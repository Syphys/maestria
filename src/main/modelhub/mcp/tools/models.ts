/**
 * `models.*` MCP tools.
 *
 * v1 surface (this commit): `models.list_running` + `models.get`. These
 * are read-only and let an external client (Claude Desktop, Cursor, a
 * script) survey what's loaded and inspect a model's metadata without
 * the ability to spawn or stop anything yet.
 *
 * The launch/stop/search tools land in the next commit (alongside the
 * `launchedBy` annotation on `ActiveEntry`).
 */

import { listRunning } from '../../runners/launch';
import { loadModelMeta } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';

register({
  name: 'models.list_running',
  description:
    'List models currently launched as local llama-server processes. ' +
    'Each entry includes the OS pid, the OpenAI-compatible URL the caller ' +
    'can hit, the runner label, the model filename, and a `launchedBy` ' +
    'tag that distinguishes user-initiated launches from launches that ' +
    'originated via this MCP server.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const running = listRunning();
    return running.map((r) => ({
      pid: r.pid,
      url: r.url,
      runnerLabel: r.runnerLabel,
      modelName: r.modelName,
      startedAt: r.startedAt,
    }));
  },
});

register({
  name: 'models.get',
  description:
    'Return the full sidecar metadata for a model file: parsed GGUF ' +
    'header (architecture, quantization, layer count, context length, ' +
    'embedding dim, etc.), Hugging Face card if cached, auto-derived ' +
    'system tags (arch:llama, quant:q4_k_m, size:7-13B, …). Works on ' +
    'any shard — resolves to the canonical shard (#1) internally.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to a .gguf or .safetensors file. Any shard of ' +
          'a multi-file model is accepted; the response is the canonical ' +
          'shard metadata.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const meta = await loadModelMeta(canonical);
    if (!meta) {
      throw new Error(`no sidecar metadata for ${a.path}`);
    }
    return {
      path: canonical,
      header: meta.header,
      huggingface: meta.huggingface,
      autoTags: meta.autoTags,
      userNotes: meta.userNotes,
    };
  },
});
