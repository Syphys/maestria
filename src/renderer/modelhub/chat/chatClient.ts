/**
 * Streaming chat clients for the in-app chat surface.
 *
 * Two protocols cover every runner the app currently supports:
 *
 *   - **Ollama**: `POST /api/chat` returning newline-delimited JSON.
 *     Each line is `{ message: { content }, done }` and we just append.
 *
 *   - **OpenAI-compatible**: `POST /v1/chat/completions` returning SSE.
 *     llama-server, koboldcpp and lm-studio all expose this. Each line
 *     is `data: {...}` with `choices[0].delta.content`; `data: [DONE]`
 *     marks the end.
 *
 * Renderer talks to localhost HTTP directly — no IPC indirection. The
 * AbortController wired to the fetch lets the UI's Stop button cancel
 * mid-stream cleanly.
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamChunk {
  /** Text to append to the in-flight assistant message. */
  delta: string;
  /** True on the final chunk. */
  done: boolean;
}

export interface ChatStreamRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export type ChatProtocol = 'ollama' | 'openai';

export function protocolForRunnerKind(
  runnerKind: string | undefined,
): ChatProtocol {
  return runnerKind === 'ollama' ? 'ollama' : 'openai';
}

async function* iterLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) {
      const tail = buf.trim();
      if (tail) yield tail;
      return;
    }
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
      idx = buf.indexOf('\n');
    }
  }
}

async function* streamOllama(
  baseUrl: string,
  req: ChatStreamRequest,
): AsyncGenerator<StreamChunk> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
    }),
    signal: req.signal,
  });
  if (!res.ok) {
    throw new Error(
      `Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`,
    );
  }
  if (!res.body) throw new Error('Ollama: no response body');
  const reader = res.body.getReader();
  for await (const line of iterLines(reader)) {
    try {
      const obj = JSON.parse(line);
      const delta = obj?.message?.content ?? '';
      const done = obj?.done === true;
      yield { delta, done };
      if (done) return;
    } catch {
      /* malformed line — skip */
    }
  }
}

async function* streamOpenAI(
  baseUrl: string,
  req: ChatStreamRequest,
): AsyncGenerator<StreamChunk> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
    }),
    signal: req.signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  if (!res.body) throw new Error('No response body');
  const reader = res.body.getReader();
  for await (const line of iterLines(reader)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      yield { delta: '', done: true };
      return;
    }
    try {
      const obj = JSON.parse(data);
      const delta = obj?.choices?.[0]?.delta?.content ?? '';
      const finished = obj?.choices?.[0]?.finish_reason != null;
      yield { delta, done: finished };
      if (finished) return;
    } catch {
      /* malformed line — skip */
    }
  }
}

export function streamChat(
  baseUrl: string,
  protocol: ChatProtocol,
  req: ChatStreamRequest,
): AsyncGenerator<StreamChunk> {
  return protocol === 'ollama'
    ? streamOllama(baseUrl, req)
    : streamOpenAI(baseUrl, req);
}
