// Slice 2 — ChatClient: OpenAI-compatible /v1/chat/completions client.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R2.6 ; arbitration: DECISIONS.md D3.
//
// Used by the characterization runner to query a launched `llama-server`.
// DETERMINISM IS THE POINT: temperature 0, fixed seed, single completion,
// no streaming — re-running the suite on the same model must reproduce.
// Standalone (does not share code with the paused R1 embed client) so the
// characterization path is independent. No external deps.

/** Minimal seam the runner depends on — lets the smoke inject a mock. */
export interface ChatLike {
  /**
   * `ctx.id` is the work-item id (mocks route on it; real client ignores).
   *
   * `ctx.signal` is an OPTIONAL AbortSignal that fires when the user
   * clicks the bulk-characterise "Cancel" button. It is wired through
   * to `fetch()` so an in-flight HTTP request is killed immediately,
   * which in turn makes llama-server stop generating (the connection
   * close is its cancellation signal). This is the ONLY cancellation
   * path — there is no wall-clock timeout (see ChatClientConfig docs).
   */
  complete(
    prompt: string,
    ctx?: { id?: string; signal?: AbortSignal },
  ): Promise<string>;
}

export type ChatClientConfig = {
  /** Base URL, e.g. `http://127.0.0.1:8080` (no trailing `/v1`). */
  baseUrl: string;
  /** Model id sent in the body. Local llama-server ignores it. */
  model?: string;
  /** Bearer token for hosted APIs. Omitted for local llama-server. */
  apiKey?: string;
  /**
   * Retry attempts after the first try. Default 2. Retries fire on
   * network failures and 429/5xx only.
   *
   * NO WALL-CLOCK TIMEOUT — characterization chat must run to
   * completion no matter how slow the model. A timeout silently drops
   * valid slow responses (a 31B Q6 on partial GPU can take 3–4 min per
   * multistep prompt) and shows up as `(empty)` in the suite, which
   * misleads the user about the model's competence. User feedback,
   * 2026-05-24: « Je t'avais dit de pas mettre de time out ».
   */
  maxRetries?: number;
  /** Base backoff (ms); attempt n waits ~base·2ⁿ + jitter. Default 600. */
  backoffBaseMs?: number;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
  /** RNG seed for reproducibility. Default 42. */
  seed?: number;
  /**
   * Per-model cap on generated tokens. UNSET ⇒ no `max_tokens` sent
   * (llama-server uses its loaded context window). The characterizer
   * sets this to each model's effective `ctx` so every model gets its
   * OWN ceiling — a 4k model caps at ~4k, a 32k thinking model at ~32k.
   *
   * Never set to a hardcoded global value: the old 1024/2048 caps
   * truncated long reasoners mid-`<think>` and made math / reasoning
   * prompts score 0 on an empty response. Ctx-derived gives each model
   * the full ceiling its config allows, without any hidden limit.
   */
  maxTokens?: number;
};

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly attempts?: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

type ChatCompletionResponse = {
  choices?: {
    message?: {
      content?: string;
      /**
       * Thinking-model channel introduced in recent llama-server builds
       * (and OpenAI-compat clones) for Qwen3 / DeepSeek-R1 / Gemma-It
       * with `thinking = 1`. The model's internal reasoning lands here
       * instead of `content`. We wrap it in `<think>…</think>` and
       * prepend to content so:
       *   - the UI sees the full monologue (Interactions tab);
       *   - existing scorers (mcq, checkSpec, …) still strip
       *     `<think>…</think>` before scoring, so the score is
       *     unaffected by the wrap.
       */
      reasoning_content?: string;
    };
    text?: string;
  }[];
};

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

/** Network error / timeout / 429 / 5xx are transient; other 4xx are not. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

export class ChatClient implements ChatLike {
  private readonly url: string;

  private readonly maxRetries: number;

  private readonly backoffBaseMs: number;

  constructor(private readonly cfg: ChatClientConfig) {
    this.url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    this.maxRetries = cfg.maxRetries ?? 2;
    this.backoffBaseMs = cfg.backoffBaseMs ?? 600;
  }

  /**
   * Single-turn completion. Returns the assistant message text. Throws
   * {@link ChatError} after exhausting retries.
   *
   * No wall-clock timeout — `fetch` waits as long as the model and the
   * OS keep the socket open. A slow 31B Q6 multistep prompt can take
   * 3–4 min; the user prefers to wait rather than see fake `(empty)`
   * responses. Real network/process failures still throw + retry.
   */
  async complete(
    prompt: string,
    ctx?: { id?: string; signal?: AbortSignal },
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.cfg.model ?? '',
      messages: [{ role: 'user', content: prompt }],
      temperature: this.cfg.temperature ?? 0,
      seed: this.cfg.seed ?? 42,
      stream: false,
      n: 1,
    };
    // No `max_tokens` unless one is explicitly configured — thinking
    // models must be free to finish their reasoning AND answer. With it
    // absent, llama-server generates until EOS / the context window.
    if (this.cfg.maxTokens !== undefined) {
      payload.max_tokens = this.cfg.maxTokens;
    }
    // Belt-and-braces stop sequences. llama-server normally stops on
    // the model's declared EOS token, but a non-trivial slice of the
    // GGUF fine-tunes in the wild ship with a broken chat template or
    // an `<|endoftext|>` marker that is NOT flagged as EOS — those
    // models emit the marker mid-stream and keep generating, looping
    // the same answer 30+ times until max_tokens is hit. The strings
    // below cover the common conventions across model families; they
    // never appear in legitimate output so adding them is safe.
    payload.stop = [
      '<|endoftext|>', // GPT-2 family + many earlier fine-tunes
      '<|im_end|>', // ChatML (Qwen, Yi, …)
      '<|eot_id|>', // Llama 3 / 3.1 / 3.2
      '<|end|>', // Phi-3
      '</s>', // Llama 1/2, Mistral, Mixtral
      '<end_of_turn>', // Gemma 2 / 3
    ];
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    let lastErr: ChatError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Early-out before re-issuing the request when the caller has
      // already aborted (e.g. user clicked Cancel during the backoff
      // sleep between attempts). Avoids one wasted network round-trip.
      if (ctx?.signal?.aborted) {
        throw new ChatError('chat: aborted by caller', undefined, attempt + 1);
      }
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers,
          body,
          // When the caller aborts mid-flight, fetch throws an
          // AbortError immediately and we close the socket — llama-server
          // detects the disconnect and stops generating server-side too.
          signal: ctx?.signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          const err = new ChatError(
            `chat HTTP ${res.status}: ${detail}`,
            res.status,
            attempt + 1,
          );
          if (!isRetryableStatus(res.status)) throw err;
          lastErr = err;
        } else {
          const json = (await res.json()) as ChatCompletionResponse;
          const choice = json.choices?.[0];
          const content = choice?.message?.content ?? choice?.text;
          if (typeof content !== 'string') {
            throw new ChatError(
              'chat: response had no message content',
              res.status,
              attempt + 1,
            );
          }
          // When llama-server splits reasoning into its own channel,
          // re-attach it as a `<think>` block so the diagnostic record
          // and the live « Interactions » tab keep full visibility.
          // Scorers strip `<think>…</think>` before scoring (D11), so
          // appending it never affects deterministic scores.
          const reasoning = choice?.message?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            return `<think>${reasoning}</think>\n${content}`;
          }
          return content;
        }
      } catch (e) {
        // AbortError from fetch when the caller cancels — do NOT retry,
        // surface immediately. node-fetch and undici both throw
        // `DOMException`/`AbortError` with `name === 'AbortError'`.
        const name = (e as { name?: string } | null)?.name;
        if (name === 'AbortError' || ctx?.signal?.aborted) {
          throw new ChatError(
            `chat: aborted by caller`,
            undefined,
            attempt + 1,
          );
        }
        if (e instanceof ChatError && e.status !== undefined) {
          if (!isRetryableStatus(e.status)) throw e;
          lastErr = e;
        } else {
          // Real network / process failure (DNS, ECONNREFUSED, RST,
          // server crash). These ARE worth retrying — the model itself
          // may have restarted in the meantime.
          const err = new ChatError(
            `chat request failed: ${(e as Error).message}`,
            undefined,
            attempt + 1,
          );
          lastErr = err;
        }
      }

      if (attempt < this.maxRetries) {
        const backoff =
          this.backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(backoff);
      }
    }
    throw (
      lastErr ?? new ChatError('chat failed', undefined, this.maxRetries + 1)
    );
  }
}
