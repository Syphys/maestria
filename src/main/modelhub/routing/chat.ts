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
   *
   * `ctx.onChunk` is an OPTIONAL live-progress callback fired EVERY time
   * the SSE accumulator updates — both for `content` deltas and for
   * `reasoning_content` deltas. Receives the FULL accumulated text so
   * far on each call (so the caller doesn't have to concatenate); the
   * `kind` distinguishes the two channels so the UI can wrap
   * reasoning in `<think>…</think>` exactly like the final-return shape.
   * Callers that only want the final text can omit it — the streaming
   * keeps running, the callback simply isn't invoked. Errors thrown by
   * `onChunk` are swallowed so a UI bug never sinks the chat request.
   */
  complete(
    prompt: string,
    ctx?: {
      id?: string;
      signal?: AbortSignal;
      onChunk?: (kind: 'content' | 'reasoning', accumulated: string) => void;
    },
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

/**
 * Streaming-delta shape (SSE `data: {…}` lines). llama-server emits
 * incremental tokens in `choices[0].delta.content` and (for thinking
 * models with `thinking = 1`) `choices[0].delta.reasoning_content`.
 * Final chunk has `choices[0].finish_reason !== null` and is followed
 * by `data: [DONE]`. We accumulate the deltas across the stream.
 */
type ChatStreamChunk = {
  choices?: {
    delta?: {
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
    finish_reason?: string | null;
  }[];
};

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

/**
 * Read an OpenAI-style Server-Sent Events stream and return the
 * concatenated assistant content + reasoning. Lines are framed by
 * `\n` (single LF — llama-server uses LF, not CRLF) and each event is
 * a single `data: {…}` line followed by a blank line. The terminal
 * marker is `data: [DONE]`. Malformed JSON lines are skipped (some
 * proxies inject keep-alive comments).
 *
 * Exported for unit tests; production callers go through ChatClient.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onChunk?: (kind: 'content' | 'reasoning', accumulated: string) => void,
): Promise<{ content: string; reasoning: string }> {
  let content = '';
  let reasoning = '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Throttle onChunk firings to one per 80 ms so a fast token stream
  // (60+ t/s) doesn't drown the IPC bridge / React reconciler. The
  // final accumulator is always flushed below the loop, so the caller
  // never misses tokens — only the intermediate rendering rate drops.
  const FLUSH_INTERVAL_MS = 80;
  let lastFlushedAt = 0;
  let dirty: 'content' | 'reasoning' | null = null;
  const safeFire = (kind: 'content' | 'reasoning', acc: string) => {
    if (!onChunk) return;
    try {
      onChunk(kind, acc);
    } catch {
      // never let a UI-callback bug sink the chat stream
    }
  };
  const maybeFlush = (kind: 'content' | 'reasoning') => {
    if (!onChunk) return;
    dirty = kind;
    const now = Date.now();
    if (now - lastFlushedAt < FLUSH_INTERVAL_MS) return;
    lastFlushedAt = now;
    safeFire(kind, kind === 'content' ? content : reasoning);
    dirty = null;
  };
  try {
    while (true) {
      if (signal?.aborted) {
        // Match the AbortError shape that fetch would have thrown so
        // the caller's catch (which looks for `name === 'AbortError'`)
        // takes the no-retry path.
        const err = new Error('aborted by caller');
        err.name = 'AbortError';
        throw err;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; within an event each
      // line is prefixed `data:`. llama-server only emits a single
      // `data:` per event, so a simple split on `\n` is enough.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          // Final flush — emit whatever channel was last touched so
          // the UI sees the complete text even if it landed inside
          // the throttle window.
          if (dirty) safeFire(dirty, dirty === 'content' ? content : reasoning);
          return { content, reasoning };
        }
        let chunk: ChatStreamChunk;
        try {
          chunk = JSON.parse(data) as ChatStreamChunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.reasoning_content === 'string') {
          reasoning += delta.reasoning_content;
          maybeFlush('reasoning');
        }
        if (typeof delta?.content === 'string') {
          content += delta.content;
          maybeFlush('content');
        }
      }
    }
  } finally {
    // Releases the underlying socket; safe to call even after [DONE].
    try {
      await reader.cancel();
    } catch {
      // ignore — cancelling an already-closed stream throws on some Node builds
    }
  }
  // Stream ended without an explicit [DONE] marker — flush + return.
  if (dirty) safeFire(dirty, dirty === 'content' ? content : reasoning);
  return { content, reasoning };
}

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
   * SSE STREAMING (since 2026-05-26). Requests `stream: true` and
   * accumulates `choices[0].delta.content` (+ `delta.reasoning_content`
   * for thinking models). Why streaming when we only need the final
   * concatenated text:
   *   1. Node's built-in `fetch` (undici) has a 5-minute `headersTimeout`
   *      we cannot configure without pulling in undici as a dep. With
   *      `stream: false`, llama-server only sends headers AFTER the
   *      whole generation completes, so any prompt taking >5 min got
   *      its connection killed undici-side → llama-server saw the
   *      disconnect and cancelled the task (visible in server logs as
   *      `should_stop`) → Maestria received an empty/truncated 200 →
   *      the prompt scored zero on a perfectly fine model. With
   *      streaming, headers come back immediately and tokens flow
   *      incrementally; the headersTimeout never matters.
   *   2. We can later surface tokens to the UI in real-time (the
   *      « Interactions » tab would stop appearing frozen on long
   *      generations) — left for a follow-up; today we just concat.
   *
   * No wall-clock timeout — fetch waits as long as tokens keep flowing.
   * Real network/process failures still throw + retry. `ctx.signal`
   * propagates the user's Cancel click to fetch AND the SSE reader.
   */
  async complete(
    prompt: string,
    ctx?: {
      id?: string;
      signal?: AbortSignal;
      onChunk?: (kind: 'content' | 'reasoning', accumulated: string) => void;
    },
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.cfg.model ?? '',
      messages: [{ role: 'user', content: prompt }],
      temperature: this.cfg.temperature ?? 0,
      seed: this.cfg.seed ?? 42,
      stream: true,
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
          if (!res.body) {
            throw new ChatError(
              'chat: response has no body (streaming requires a ReadableStream)',
              res.status,
              attempt + 1,
            );
          }
          const { content, reasoning } = await readSseStream(
            res.body,
            ctx?.signal,
            ctx?.onChunk,
          );
          if (!content && !reasoning) {
            throw new ChatError(
              'chat: SSE stream produced no content',
              res.status,
              attempt + 1,
            );
          }
          // When llama-server splits reasoning into its own channel,
          // re-attach it as a `<think>` block so the diagnostic record
          // and the live « Interactions » tab keep full visibility.
          // Scorers strip `<think>…</think>` before scoring (D11), so
          // appending it never affects deterministic scores.
          if (reasoning.length > 0) {
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
