// SSE streaming reader for chat.ts. Covers the happy path (content +
// reasoning across multiple chunks, [DONE] terminator), the malformed-
// line tolerance (keep-alive comments / partial JSON), abort
// propagation (signal aborts mid-stream → AbortError), and stream end
// without [DONE] (some proxies).
import { describe, expect, test } from '@playwright/test';
import { readSseStream } from '../../../src/main/modelhub/routing/chat';

/** Wrap an array of UTF-8 strings as a ReadableStream<Uint8Array>. */
function streamOf(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

/** Build an SSE data event from a chunk shape. */
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('readSseStream', () => {
  test('accumulates content across multiple chunks until [DONE]', async () => {
    const stream = streamOf([
      sse({ choices: [{ delta: { content: 'Hel' } }] }),
      sse({ choices: [{ delta: { content: 'lo ' } }] }),
      sse({ choices: [{ delta: { content: 'world' } }] }),
      'data: [DONE]\n\n',
    ]);
    const { content, reasoning } = await readSseStream(stream);
    expect(content).toBe('Hello world');
    expect(reasoning).toBe('');
  });

  test('accumulates reasoning_content separately', async () => {
    const stream = streamOf([
      sse({ choices: [{ delta: { reasoning_content: 'Let me think… ' } }] }),
      sse({ choices: [{ delta: { reasoning_content: 'OK.' } }] }),
      sse({ choices: [{ delta: { content: 'Answer: 42' } }] }),
      'data: [DONE]\n\n',
    ]);
    const { content, reasoning } = await readSseStream(stream);
    expect(content).toBe('Answer: 42');
    expect(reasoning).toBe('Let me think… OK.');
  });

  test('handles chunk boundaries that split an event in two', async () => {
    // The first read returns half a JSON line; the second completes it.
    const full = sse({ choices: [{ delta: { content: 'Hello' } }] });
    const half = full.slice(0, 20);
    const rest = full.slice(20);
    const stream = streamOf([half, rest, 'data: [DONE]\n\n']);
    const { content } = await readSseStream(stream);
    expect(content).toBe('Hello');
  });

  test('skips malformed JSON lines (keep-alive comments)', async () => {
    const stream = streamOf([
      ':keepalive\n\n',
      sse({ choices: [{ delta: { content: 'a' } }] }),
      'data: not-json\n\n',
      sse({ choices: [{ delta: { content: 'b' } }] }),
      'data: [DONE]\n\n',
    ]);
    const { content } = await readSseStream(stream);
    expect(content).toBe('ab');
  });

  test('returns what it has when stream ends without [DONE]', async () => {
    const stream = streamOf([
      sse({ choices: [{ delta: { content: 'partial' } }] }),
    ]);
    const { content } = await readSseStream(stream);
    expect(content).toBe('partial');
  });

  test('aborts mid-stream when signal fires before reader.read()', async () => {
    const controller = new AbortController();
    const stream = streamOf([
      sse({ choices: [{ delta: { content: 'one' } }] }),
      sse({ choices: [{ delta: { content: 'two' } }] }),
      'data: [DONE]\n\n',
    ]);
    controller.abort();
    let err;
    try {
      await readSseStream(stream, controller.signal);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.name).toBe('AbortError');
  });
});
