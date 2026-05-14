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
import { detectHardwareProfile } from '../../hardware';
import { readModelHeader } from '../../parseHeader';
import { autotune } from '../../runners/autotune';
import { listRunners, reprobeRunner } from '../../runners/registry';
import { pickRunnerFor } from '../../../../renderer/modelhub/runners/pick';
import { parseHelpText } from '../../../../renderer/modelhub/helpParser';
import { register } from '../registry';
import type { RunParams } from '../../../../renderer/modelhub/types';

/**
 * JSON-Schema fragment shared by `models.run` and `models.get_run_params`
 * to describe the caller-overridable launch params. All fields are
 * optional; only the ones the caller passes override autotune defaults.
 *
 * Kept inline (not refactored to a constant) so the schema stays
 * self-documenting in the tools/list response — MCP clients render the
 * `description` text to their LLMs, and an `$ref` indirection would
 * hide it.
 */
const RUN_PARAMS_SCHEMA = {
  type: 'object',
  description:
    'Optional launch param overrides. Merged on top of autotune + ' +
    'sidecar `userRunParams`. To disable the default `--fit on` ' +
    'autosizing pass `fit: false` and provide explicit `ngl` / `ctx` / ' +
    '`batchSize`. The server port is always re-pinned to a ' +
    'collision-free value regardless of the requested port.',
  properties: {
    ngl: {
      type: 'integer',
      minimum: -1,
      description:
        'Number of model layers to offload to GPU. 0 = pure CPU. ' +
        '-1 = all layers. Ignored when `fit: true`.',
    },
    ctx: {
      type: 'integer',
      minimum: 0,
      description:
        'Context window size in tokens. 0 = loaded from the model. ' +
        'Ignored when `fit: true`.',
    },
    threads: {
      type: 'integer',
      minimum: 1,
      description: 'CPU threads for prompt processing.',
    },
    batchSize: {
      type: 'integer',
      minimum: 1,
      description: 'Logical batch size. Ignored when `fit: true`.',
    },
    mlock: {
      type: 'boolean',
      description: 'Lock weights in RAM to prevent swap.',
    },
    flashAttn: {
      type: 'boolean',
      description: 'Enable Flash Attention (requires a compiled-in build).',
    },
    port: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      description:
        'Requested HTTP bind port. Default 8080. The server may bind a ' +
        'nearby port if the requested one is busy.',
    },
    fit: {
      type: 'boolean',
      description:
        "Use llama-server's built-in `--fit on` autosizing of ngl/ctx/" +
        'batch from free VRAM at boot. Defaults to true. Pass `false` ' +
        'to send explicit ngl/ctx/batchSize values instead.',
    },
    customArgs: {
      type: 'string',
      description:
        'Free-form extra CLI args, one per line. Comments (`#…`) and ' +
        'empty lines ignored. Whitespace inside a value is preserved ' +
        'by splitting on the first whitespace only, so ' +
        '`--system "You are X"` works without quote handling.',
    },
  },
  additionalProperties: false,
} as const;

function coerceRunParamsArg(value: unknown): Partial<RunParams> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('params must be an object');
  }
  const v = value as Record<string, unknown>;
  const out: Partial<RunParams> = {};
  if (v.ngl !== undefined) {
    if (typeof v.ngl !== 'number') throw new Error('params.ngl must be number');
    out.ngl = v.ngl;
  }
  if (v.ctx !== undefined) {
    if (typeof v.ctx !== 'number') throw new Error('params.ctx must be number');
    out.ctx = v.ctx;
  }
  if (v.threads !== undefined) {
    if (typeof v.threads !== 'number') {
      throw new Error('params.threads must be number');
    }
    out.threads = v.threads;
  }
  if (v.batchSize !== undefined) {
    if (typeof v.batchSize !== 'number') {
      throw new Error('params.batchSize must be number');
    }
    out.batchSize = v.batchSize;
  }
  if (v.mlock !== undefined) {
    if (typeof v.mlock !== 'boolean') {
      throw new Error('params.mlock must be boolean');
    }
    out.mlock = v.mlock;
  }
  if (v.flashAttn !== undefined) {
    if (typeof v.flashAttn !== 'boolean') {
      throw new Error('params.flashAttn must be boolean');
    }
    out.flashAttn = v.flashAttn;
  }
  if (v.port !== undefined) {
    if (typeof v.port !== 'number') {
      throw new Error('params.port must be number');
    }
    out.port = v.port;
  }
  if (v.fit !== undefined) {
    if (typeof v.fit !== 'boolean') {
      throw new Error('params.fit must be boolean');
    }
    out.fit = v.fit;
  }
  if (v.customArgs !== undefined) {
    if (typeof v.customArgs !== 'string') {
      throw new Error('params.customArgs must be string');
    }
    out.customArgs = v.customArgs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

register({
  name: 'models.list_running',
  description:
    'List models currently launched as local llama-server processes. ' +
    'Each entry includes pid, OpenAI-compatible URL, runner label, ' +
    'model filename, startedAt, `launchedBy` (undefined for ' +
    'user-initiated launches, "via MCP — <client>" otherwise — useful ' +
    'for an MCP caller to filter to its own children), and `params` ' +
    '(the effective launch parameters: ngl/ctx/threads/batchSize/' +
    'mlock/flashAttn/port/fit/customArgs).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const running = listRunning();
    return running.map((r) => ({
      pid: r.pid,
      url: r.url,
      runnerLabel: r.runnerLabel,
      modelName: r.modelName,
      filePath: r.filePath,
      launchedBy: r.launchedBy,
      params: r.params,
      startedAt: r.startedAt,
    }));
  },
});

register({
  name: 'models.get',
  description:
    'Return the sidecar metadata for a model file: parsed GGUF header ' +
    '(architecture, quantization, layer count, context length, ' +
    'embedding dim, etc.), Hugging Face card if cached, auto-derived ' +
    'system tags (arch:llama, quant:q4_k_m, size:7-13B, …). The raw ' +
    'GGUF KV dump (`header.rawMetadata`, ~40 typed entries like ' +
    '`rope.scaling.yarn_log_multiplier`) is hidden by default — pass ' +
    '`withMetadata: true` for the full dump. Works on any shard — ' +
    'resolves to the canonical shard (#1) internally.',
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
      withMetadata: {
        type: 'boolean',
        description:
          'Include the raw GGUF KV dump under `header.rawMetadata`. ' +
          'Default false — the summary fields on `header` ' +
          '(architecture, name, sizeLabel, contextMax, embeddingDim, ' +
          'blockCount, headCount, quantization) are sufficient for most ' +
          'callers. Set true when you need architecture-specific knobs ' +
          'like `rope.scaling.*` or `attention.kv_lora_rank`.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; withMetadata?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const meta = await loadModelMeta(canonical);
    if (!meta) {
      throw new Error(`no sidecar metadata for ${a.path}`);
    }
    const withMetadata = a.withMetadata === true;
    const header =
      withMetadata || !meta.header
        ? meta.header
        : (() => {
            const { rawMetadata: _drop, ...rest } = meta.header;
            return rest;
          })();
    return {
      path: canonical,
      header,
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
    'Launch a local llama-server for the given model file. The default ' +
    'params come from `autotune` (hardware-aware) merged with the ' +
    "model's sidecar `userRunParams`; pass `params` to override any " +
    'subset (including disabling `--fit on` autosizing or appending ' +
    'arbitrary advanced flags via `customArgs`). Returns the ' +
    'OpenAI-compatible URL, the OS pid, the effective params, and any ' +
    'warnings buildCommand emitted. The spawned entry is tagged with ' +
    '`launchedBy = <caller>` so the in-app `RunningModelsPanel` ' +
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
          'Convenience shortcut for `params.port`. Default 8080. The ' +
          'actual bound port is re-pinned to avoid collisions and ' +
          'returned in the response.',
      },
      params: RUN_PARAMS_SCHEMA,
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown, ctx) => {
    const a = args as { path?: unknown; port?: unknown; params?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const port = typeof a.port === 'number' ? a.port : undefined;
    const paramsOverride = coerceRunParamsArg(a.params);
    const result = await launchModelByPath(a.path, {
      launchedBy: ctx.callerLabel,
      port,
      paramsOverride,
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

/**
 * Map a `ParsedFlag` to the externally-facing flag descriptor MCP
 * callers see. The internal `kind` taxonomy
 * (`'bool-bare' | 'bool-on-off' | ...`) is convenient for the editor
 * but unwieldy for an LLM caller, so we collapse it to a shorter
 * `valueType` plus `choices` when applicable.
 */
function flagToWireShape(f: ReturnType<typeof parseHelpText>[number]) {
  let valueType: 'boolean' | 'number' | 'string' = 'string';
  if (
    f.kind === 'bool-bare' ||
    f.kind === 'bool-on-off' ||
    f.kind === 'bool-on-off-auto'
  ) {
    valueType = 'boolean';
  } else if (f.kind === 'number') {
    valueType = 'number';
  }
  return {
    flag: f.flag,
    shortFlag: f.shortFlag,
    valueType,
    valueDescriptor: f.valueDescriptor,
    defaultValue: f.defaultValue,
    choices: f.choices,
    description: f.description,
    envVar: f.envVar,
    /**
     * UI hint: this flag is OFF by default from the caller's
     * perspective — i.e. the caller decides whether to enable it. The
     * default value applies only when the caller explicitly opts in.
     */
    enabled: false,
  };
}

register({
  name: 'models.get_run_params',
  description:
    'Inspect what `models.run` *would* use for a given model file, ' +
    "without launching. Returns the autotuned params, the model's " +
    'sidecar override (if any), the merged effective params, the ' +
    'picked runner, and the full list of advanced flags the chosen ' +
    'runner advertises (parsed from its `--help` output, each ' +
    'starting as `enabled: false`). Use this to discover what is ' +
    'overridable before calling `models.run` with a `params` payload.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to a .gguf file. Any shard accepted; resolved ' +
          'to shard 1 internally.',
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
    const meta = await loadModelMeta(canonical).catch(() => undefined);
    let header = meta?.header;
    if (!header) {
      const parsed = await readModelHeader(canonical);
      if (parsed.ok && parsed.meta) header = parsed.meta;
    }
    const hardware = await detectHardwareProfile();
    const autotuned = autotune({ header, hardware });
    const override = meta?.userRunParams;
    const effective: RunParams = {
      ...autotuned,
      ...(override ?? {}),
    };

    const runners = await listRunners();
    const runner = pickRunnerFor(runners, canonical, meta);
    // Probe lazily — the user may have configured a runner without
    // ever opening Advanced Parameters, in which case helpText is
    // empty. We surface the parsed flags eagerly so MCP introspection
    // doesn't require a separate setup step.
    let probedRunner = runner;
    if (runner && !runner.probed) {
      const reprobed = await reprobeRunner(runner.id);
      if (reprobed) probedRunner = reprobed;
    }
    const helpText = probedRunner?.probed?.helpText ?? '';
    const flags = helpText ? parseHelpText(helpText).map(flagToWireShape) : [];

    return {
      path: canonical,
      autotuned,
      override,
      effective,
      runner: probedRunner && {
        id: probedRunner.id,
        label: probedRunner.label,
        path: probedRunner.path,
        version: probedRunner.probed?.version,
      },
      flags,
    };
  },
});

register({
  name: 'models.list_runner_flags',
  description:
    'List every CLI flag the given runner binary advertises in its ' +
    '`--help` output, parsed into a structured shape (flag name, value ' +
    'type, default, choices, description, env var). Each entry starts ' +
    'as `enabled: false` — the caller picks which to opt into and ' +
    'passes them through `models.run` via `params.customArgs`. If the ' +
    'runner has never been probed, this tool probes it once on demand ' +
    '(spawns `<bin> --help`, ~200 ms).',
  inputSchema: {
    type: 'object',
    properties: {
      runnerId: {
        type: 'string',
        description:
          'Optional runner UUID (as returned by an internal admin tool ' +
          'or by `models.get_run_params`). When omitted, picks the ' +
          'first GGUF-capable runner sorted by priority.',
      },
    },
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { runnerId?: unknown };
    const runners = await listRunners();
    let runner =
      typeof a.runnerId === 'string' && a.runnerId
        ? runners.find((r) => r.id === a.runnerId)
        : runners
            .filter((r) => r.capabilities.gguf)
            .sort((x, y) => (x.priority ?? 99) - (y.priority ?? 99))[0];
    if (!runner) {
      throw new Error(
        typeof a.runnerId === 'string' && a.runnerId
          ? `runner not found: ${a.runnerId}`
          : 'no GGUF-capable runner configured',
      );
    }
    if (!runner.probed) {
      const reprobed = await reprobeRunner(runner.id);
      if (reprobed) runner = reprobed;
    }
    const helpText = runner.probed?.helpText ?? '';
    const flags = helpText ? parseHelpText(helpText).map(flagToWireShape) : [];
    return {
      runner: {
        id: runner.id,
        label: runner.label,
        path: runner.path,
        version: runner.probed?.version,
      },
      probedAt: runner.probed?.probedAt,
      count: flags.length,
      flags,
    };
  },
});
