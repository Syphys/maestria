// R1.3 — EmbedClient: OpenAI-compatible /v1/embeddings client.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R1.3.
//
// Targets a local `llama-server --embedding` (bge-m3 by convention) but the
// payload/route is the OpenAI embeddings contract, so the same client also
// works against OpenAI/Voyage/Cohere-compatible HTTP endpoints (R1.7).
// Returns Float32Array vectors. Exponential-backoff retry, 30 s timeout.
// No external deps — Node/Electron global `fetch` + `AbortController`.

export type EmbedClientConfig = {
  /** Base URL, e.g. `http://127.0.0.1:8080` (no trailing `/v1`). */
  baseUrl: string;
  /** Model id sent in the request body. Local llama-server ignores it. */
  model?: string;
  /** Bearer token for hosted APIs. Omitted for local llama-server. */
  apiKey?: string;
  /** Per-attempt timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Retry attempts after the first try. Default 3. */
  maxRetries?: number;
  /** Base backoff (ms); attempt n waits ~base·2ⁿ + jitter. Default 500. */
  backoffBaseMs?: number;
};

export class EmbedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly attempts?: number,
  ) {
    super(message);
    this.name = 'EmbedError';
  }
}

type OpenAIEmbeddingResponse = {
  data?: { embedding: number[] | string; index: number }[];
};

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

/** Network error / timeout / 429 / 5xx are transient; 4xx (except 429) not. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network failure / abort
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/** llama.cpp returns `number[]`; some APIs return base64-packed float32. */
function toFloat32(embedding: number[] | string): Float32Array {
  if (typeof embedding === 'string') {
    const buf = Buffer.from(embedding, 'base64');
    return new Float32Array(
      buf.buffer,
      buf.byteOffset,
      Math.floor(buf.byteLength / 4),
    );
  }
  return Float32Array.from(embedding);
}

export class EmbedClient {
  private readonly url: string;

  private readonly timeoutMs: number;

  private readonly maxRetries: number;

  private readonly backoffBaseMs: number;

  constructor(private readonly cfg: EmbedClientConfig) {
    this.url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/embeddings';
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.backoffBaseMs = cfg.backoffBaseMs ?? 500;
  }

  /** Embed one string → one vector. */
  async embedOne(text: string): Promise<Float32Array> {
    const [v] = await this.embed([text]);
    return v;
  }

  /**
   * Embed N strings → N vectors, order preserved (sorted by response
   * `index`). Throws {@link EmbedError} after exhausting retries.
   */
  async embed(input: string[]): Promise<Float32Array[]> {
    if (input.length === 0) return [];
    const body = JSON.stringify({ model: this.cfg.model ?? '', input });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    let lastErr: EmbedError | undefined;
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
          const err = new EmbedError(
            `embeddings HTTP ${res.status}: ${detail}`,
            res.status,
            attempt + 1,
          );
          if (!isRetryableStatus(res.status)) throw err;
          lastErr = err;
        } else {
          const json = (await res.json()) as OpenAIEmbeddingResponse;
          const data = json.data;
          if (!Array.isArray(data) || data.length !== input.length) {
            throw new EmbedError(
              `embeddings: expected ${input.length} vectors, got ${
                data?.length ?? 0
              }`,
              res.status,
              attempt + 1,
            );
          }
          return [...data]
            .sort((a, b) => a.index - b.index)
            .map((d) => toFloat32(d.embedding));
        }
      } catch (e) {
        if (e instanceof EmbedError && e.status !== undefined) {
          // Non-retryable HTTP error already classified above.
          if (!isRetryableStatus(e.status)) throw e;
          lastErr = e;
        } else {
          const aborted = e instanceof Error && e.name === 'AbortError';
          lastErr = new EmbedError(
            aborted
              ? `embeddings timed out after ${this.timeoutMs} ms`
              : `embeddings request failed: ${(e as Error).message}`,
            undefined,
            attempt + 1,
          );
        }
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.maxRetries) {
        const backoff =
          this.backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * 200);
        await sleep(backoff);
      }
    }
    throw (
      lastErr ??
      new EmbedError('embeddings failed', undefined, this.maxRetries + 1)
    );
  }
}
