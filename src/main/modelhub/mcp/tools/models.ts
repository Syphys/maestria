/**
 * `models.*` MCP tools.
 *
 * Surface: search / get / list_running / run / stop. Read tools are
 * trivial wrappers around existing main-process functions; the write
 * tools (`run`, `stop`) route through `launchModelByPath` and
 * `stopProcess` so the in-app path and the MCP path stay strictly
 * symmetric.
 *
 * `models.run` annotates the spawned entry with `launchedBy =
 * ctx.callerLabel` ("via MCP — deer-flow", etc.). `models.list_running`
 * exposes that field so an MCP caller can filter "did I spawn this?".
 */

import { listModelFiles } from '../../listModelFiles';
import { listRunning, stopProcess } from '../../runners/launch';
import { launchModelByPath } from '../../launchModel';
import { loadModelMeta } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';

register({
  name: 'models.list_running',
  description:
    'List models currently launched as local llama-server processes. ' +
    'Each entry includes pid, OpenAI-compatible URL, runner label, ' +
    'model filename, startedAt, and `launchedBy` (undefined for ' +
    'user-initiated launches, "via MCP — <client>" otherwise — useful ' +
    'for an MCP caller to filter to its own children).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const running = listRunning();
    return running.map((r) => ({
      pid: r.pid,
      url: r.url,
      runnerLabel: r.runnerLabel,
      modelName: r.modelName,
      launchedBy: r.launchedBy,
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

register({
  name: 'models.search',
  description:
    'Walk a directory recursively and return the canonical model files ' +
    'found (.gguf, .safetensors, .bin, .ckpt, .pt, .pth — non-shard-1 ' +
    'shards filtered out). Optional `query` filters by case-insensitive ' +
    'substring of the basename. Optional `tag` filter compares against ' +
    'the file\'s sidecar `autoTags` (e.g. "arch:llama", "quant:q4_k_m"). ' +
    'When both are present they AND together.',
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description:
          'Absolute path to the directory to scan. Required — the MCP ' +
          'server has no notion of "current location", the caller must ' +
          'pass it explicitly.',
      },
      query: {
        type: 'string',
        description:
          'Case-insensitive substring match against the file basename.',
      },
      tag: {
        type: 'string',
        description:
          'Exact-match filter against the sidecar `autoTags` array ' +
          '(e.g. "arch:llama").',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        description: 'Cap on the number of results returned. Default 100.',
      },
    },
    required: ['directory'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      directory?: unknown;
      query?: unknown;
      tag?: unknown;
      limit?: unknown;
    };
    if (typeof a.directory !== 'string' || !a.directory) {
      throw new Error('directory is required and must be a string');
    }
    const queryLower =
      typeof a.query === 'string' && a.query
        ? a.query.toLowerCase()
        : undefined;
    const tag = typeof a.tag === 'string' && a.tag ? a.tag : undefined;
    const limit = typeof a.limit === 'number' ? a.limit : 100;

    const all = await listModelFiles(a.directory);

    const matches: Array<{ path: string; autoTags?: string[] }> = [];
    for (const filePath of all) {
      if (matches.length >= limit) break;
      const basename = filePath.toLowerCase().replace(/^.*[\\/]/, '');
      if (queryLower && !basename.includes(queryLower)) continue;
      // The tag filter requires a sidecar read; skip it for files whose
      // basename already failed the query filter so we don't pay the IO.
      if (tag) {
        const meta = await loadModelMeta(filePath).catch(() => undefined);
        const tags = meta?.autoTags ?? [];
        if (!tags.includes(tag)) continue;
        matches.push({ path: filePath, autoTags: tags });
      } else {
        matches.push({ path: filePath });
      }
    }
    return { count: matches.length, results: matches };
  },
});

register({
  name: 'models.run',
  description:
    'Launch a local llama-server for the given model file with ' +
    'auto-tuned parameters. Returns the OpenAI-compatible URL the ' +
    'caller can hit, plus the OS pid. The spawned entry is tagged ' +
    'with `launchedBy = <caller>` so the in-app `RunningModelsPanel` ' +
    "groups it under the caller's session. Idempotency is not " +
    'enforced — calling twice on the same file launches two servers ' +
    'on different ports.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to a .gguf file. Any shard accepted; we ' +
          'resolve to shard 1 internally.',
      },
      port: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description:
          'Optional HTTP port for the server. Default 8080. Pick a ' +
          'free port if you plan to run multiple models in parallel.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx) => {
    const a = args as { path?: unknown; port?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const port = typeof a.port === 'number' ? a.port : undefined;
    const result = await launchModelByPath(a.path, {
      launchedBy: ctx.callerLabel,
      port,
    });
    if (!result.ok) {
      throw new Error(result.error ?? 'launch failed');
    }
    return {
      pid: result.pid,
      url: result.url,
      runnerLabel: result.runner?.label,
      params: result.params,
      warnings: result.warnings,
    };
  },
});

register({
  name: 'models.stop',
  description:
    'Stop a running llama-server by pid. Returns `{ stopped: true }` ' +
    'when SIGTERM was sent (or Windows-equivalent). Stopping a model ' +
    'the caller did not launch is allowed — there is no ownership ' +
    'enforcement on pids.',
  inputSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'integer',
        minimum: 1,
        description:
          'OS pid as returned by `models.run` or `models.list_running`.',
      },
    },
    required: ['pid'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { pid?: unknown };
    if (typeof a.pid !== 'number') {
      throw new Error('pid is required and must be a number');
    }
    const r = stopProcess(a.pid);
    if (!r.ok) {
      throw new Error(r.error ?? 'stop failed');
    }
    return { stopped: true };
  },
});
