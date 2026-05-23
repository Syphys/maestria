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
  /** `ctx.id` is the work-item id (mocks route on it; real client ignores). */
  complete(prompt: string, ctx?: { id: string }): Promise<string>;
}

export type ChatClientConfig = {
  /** Base URL, e.g. `http://127.0.0.1:8080` (no trailing `/v1`). */
  baseUrl: string;
  /** Model id sent in the body. Local llama-server ignores it. */
  model?: string;
  /** Bearer token for hosted APIs. Omitted for local llama-server. */
  apiKey?: string;
  /**
   * Per-attempt timeout (ms). Default 240000 (4 min).
   *
   * Why 4 min: `multistep` characterization prompts (debug-then-fix,
   * train-meeting-time, etc.) ask the model for a multi-step CoT; on a
   * slow local model (CPU partial, low ngl) generating ~1k tokens of
   * reasoning can comfortably take 2–3 min. The old 2-min default was
   * tripping early-abort on multistep specifically. AbortError is now
   * NOT retried (see below) — a slow model stays slow.
   */
  timeoutMs?: number;
  /**
   * Retry attempts after the first try. Default 2. Retries fire on
   * network failures and 429/5xx only — AbortError (request timeout)
   * is NOT retryable (the model is just slow; retrying wastes 2× more
   * time waiting for the same slow generation).
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
  choices?: { message?: { content?: string }; text?: string }[];
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

  private readonly timeoutMs: number;

  private readonly maxRetries: number;

  private readonly backoffBaseMs: number;

  constructor(private readonly cfg: ChatClientConfig) {
    this.url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    this.timeoutMs = cfg.timeoutMs ?? 240_000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.backoffBaseMs = cfg.backoffBaseMs ?? 600;
  }

  /**
   * Single-turn completion. Returns the assistant message text. Throws
   * {@link ChatError} after exhausting retries.
   */
  async complete(prompt: string): Promise<string> {
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
    // absent, llama-server generates until EOS / the context window;
    // `timeoutMs` is the only wall-clock backstop.
    if (this.cfg.maxTokens !== undefined) {
      payload.max_tokens = this.cfg.maxTokens;
    }
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    let lastErr: ChatError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers,
          body,
          signal: ac.signal,
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
          return content;
        }
      } catch (e) {
        if (e instanceof ChatError && e.status !== undefined) {
          if (!isRetryableStatus(e.status)) throw e;
          lastErr = e;
        } else {
          const aborted = e instanceof Error && e.name === 'AbortError';
          const err = new ChatError(
            aborted
              ? `chat timed out after ${this.timeoutMs} ms`
              : `chat request failed: ${(e as Error).message}`,
            undefined,
            attempt + 1,
          );
          // A timeout means the model is too slow for the configured
          // `timeoutMs` — retrying spends another `timeoutMs` watching
          // the same slow generation. Surface it immediately so the
          // user can raise the budget (or skip the model) instead of
          // burning 2× more time. Real network/process failures
          // (anything that isn't an AbortError) stay retryable.
          if (aborted) throw err;
          lastErr = err;
        }
      } finally {
        clearTimeout(timer);
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
