/**
 * `runners.*` MCP tools — configuration + lifecycle controls for the
 * llama.cpp binaries Maestria knows about. The write operations are
 * marked `requiresAdmin: true` since a misconfigured runner can prevent
 * every model from launching (wrong path, broken probe, etc.). Read
 * operations and `runners.dismiss` are unrestricted because they don't
 * change the persisted state, just the in-memory active-entries map.
 *
 * `runners.open_chat` is exposed for parity even though it's marginal
 * over MCP — a remote client opening a browser on the user's desktop
 * is questionable. Default-token-accessible but the surface is tiny
 * and the side effect is visible (a tab pops up).
 */

import {
  detectAndMerge,
  listRunners,
  removeRunner,
  reprobeRunner,
  saveRunner,
} from '../../runners/registry';
import { buildCommand, formatCommandForShell } from '../../runners/command';
import { probeFitParams } from '../../runners/fitProbe';
import { dismissProcess, getActiveEntry } from '../../runners/launch';
import { openChatFor } from '../../runners/openChat';
import { autotune } from '../../runners/autotune';
import { detectHardwareProfile } from '../../hardware';
import { readModelHeader } from '../../parseHeader';
import { loadModelMeta } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { pickRunnerFor } from '../../../../renderer/modelhub/runners/pick';
import { register } from '../registry';
import type {
  RunParams,
  RunnerConfig,
} from '../../../../renderer/modelhub/types';

register({
  name: 'runners.list',
  description:
    'List every configured runner: id, label, path, capabilities, ' +
    'priority, last probe (helpText + parsed flags + version, when ' +
    'present). Includes both manually-added entries and auto-detected ' +
    'installs. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const runners = await listRunners();
    return { count: runners.length, runners };
  },
});

register({
  name: 'runners.save',
  description:
    'Persist a new or updated runner. Pass `id: ""` (or omit it) to ' +
    'create one; passing an existing id updates that entry. Changing ' +
    'the `path` field invalidates the stored probe (next probe ' +
    'request re-spawns `--help`). ADMIN-GATED — a malformed runner ' +
    'config can break every subsequent launch.',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      runner: {
        type: 'object',
        description: 'Full `RunnerConfig` object (see types.ts).',
        additionalProperties: true,
      },
    },
    required: ['runner'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { runner?: unknown };
    if (
      typeof a.runner !== 'object' ||
      a.runner === null ||
      Array.isArray(a.runner)
    ) {
      throw new Error('runner is required and must be an object');
    }
    const saved = await saveRunner(a.runner as RunnerConfig);
    return saved;
  },
});

register({
  name: 'runners.remove',
  description:
    'Remove a runner from the persisted set by id. Active processes ' +
    'spawned by this runner keep running — only the configuration is ' +
    'deleted. ADMIN-GATED.',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Runner UUID as returned by `runners.list`.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { id?: unknown };
    if (typeof a.id !== 'string' || !a.id) {
      throw new Error('id is required and must be a string');
    }
    await removeRunner(a.id);
    return { ok: true, id: a.id };
  },
});

register({
  name: 'runners.detect',
  description:
    'Re-run auto-detection (PATH + known install dirs) and merge fresh ' +
    'hits into the saved set without duplicating existing paths. ' +
    'Returns the resulting list. ADMIN-GATED because the merge can ' +
    'introduce runners the user has never seen.',
  requiresAdmin: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const runners = await detectAndMerge();
    return { count: runners.length, runners };
  },
});

register({
  name: 'runners.reprobe',
  description:
    'Force-spawn `<runner.path> --help` for the given runner, parse ' +
    "the output, and overwrite the runner's `probed` field with the " +
    'fresh result. Returns the updated `RunnerConfig`. ADMIN-GATED ' +
    'since the probed flags drive how every subsequent launch is ' +
    'built.',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Runner UUID as returned by `runners.list`.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { id?: unknown };
    if (typeof a.id !== 'string' || !a.id) {
      throw new Error('id is required and must be a string');
    }
    const runner = await reprobeRunner(a.id);
    if (!runner) throw new Error(`runner not found: ${a.id}`);
    return runner;
  },
});

register({
  name: 'runners.fit_probe',
  description:
    'Run `llama-fit-params --fit-print on` against a model and parse ' +
    'the per-device memory breakdown. SLOW — ~5 s on a 16 GB model ' +
    '(actually loads the weights into VRAM/RAM). The renderer caches ' +
    'the result in `modelMeta.fitProbe`; this tool surfaces the raw ' +
    'probe so a script can inspect / store it externally. ' +
    'Requires the matching `llama-fit-params` binary next to the ' +
    "runner's `llama-server`.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the .gguf file. Any shard accepted.',
      },
      runnerId: {
        type: 'string',
        description:
          'Optional runner UUID. When omitted, picks the runner that ' +
          'would launch this model (same logic as `models.run`).',
      },
      suggest: {
        type: 'boolean',
        description:
          'Pass `--fit-suggest` to have llama-fit-params propose values ' +
          'rather than validate the ones we pass. Default false.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      path?: unknown;
      runnerId?: unknown;
      suggest?: unknown;
    };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const runners = await listRunners();
    let runner: RunnerConfig | undefined;
    if (typeof a.runnerId === 'string' && a.runnerId) {
      runner = runners.find((r) => r.id === a.runnerId);
      if (!runner) throw new Error(`runner not found: ${a.runnerId}`);
    } else {
      const meta = await loadModelMeta(canonical).catch(() => undefined);
      runner = pickRunnerFor(runners, canonical, meta);
      if (!runner) throw new Error('no runner can launch this file');
    }
    const meta = await loadModelMeta(canonical).catch(() => undefined);
    let header = meta?.header;
    if (!header) {
      const parsed = await readModelHeader(canonical);
      if (parsed.ok && parsed.meta) header = parsed.meta;
    }
    const hardware = await detectHardwareProfile();
    const params: RunParams = {
      ...autotune({ header, hardware }),
      ...(meta?.userRunParams ?? {}),
    };
    const result = await probeFitParams(runner, canonical, params, {
      suggest: a.suggest === true,
    });
    return result;
  },
});

register({
  name: 'runners.build_command',
  description:
    'Compose the exact shell command `models.run` would spawn for the ' +
    'given model, without launching anything. Useful for the "Copy ' +
    'command" affordance in external admin scripts. Returns the ' +
    'argv array AND the shell-quoted single-line form (Windows or ' +
    'POSIX rules based on the host platform).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the .gguf file. Any shard accepted.',
      },
      runnerId: {
        type: 'string',
        description:
          'Optional runner UUID. When omitted, picks the runner that ' +
          'would launch this model.',
      },
      params: {
        type: 'object',
        description:
          'Optional `RunParams` override merged on top of autotune + ' +
          'sidecar `userRunParams`. Same shape as `models.run`.',
        additionalProperties: true,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      path?: unknown;
      runnerId?: unknown;
      params?: unknown;
    };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const runners = await listRunners();
    const meta = await loadModelMeta(canonical).catch(() => undefined);
    let runner: RunnerConfig | undefined;
    if (typeof a.runnerId === 'string' && a.runnerId) {
      runner = runners.find((r) => r.id === a.runnerId);
      if (!runner) throw new Error(`runner not found: ${a.runnerId}`);
    } else {
      runner = pickRunnerFor(runners, canonical, meta);
      if (!runner) throw new Error('no runner can launch this file');
    }
    let header = meta?.header;
    if (!header) {
      const parsed = await readModelHeader(canonical);
      if (parsed.ok && parsed.meta) header = parsed.meta;
    }
    const hardware = await detectHardwareProfile();
    const baseParams: RunParams = {
      ...autotune({ header, hardware }),
      ...(meta?.userRunParams ?? {}),
      ...((a.params as Partial<RunParams>) ?? {}),
    };
    const built = buildCommand(runner, canonical, baseParams);
    return {
      argv: built.command,
      shellLine: formatCommandForShell(built.command),
      url: built.url,
      warnings: built.warnings,
      runner: { id: runner.id, label: runner.label, path: runner.path },
    };
  },
});

register({
  name: 'runners.dismiss',
  description:
    'Remove a finished `ActiveEntry` (`exited != undefined`) from the ' +
    'in-memory list, so `models.list_running` stops returning it. ' +
    'Live entries are rejected with "process is still running — stop ' +
    'it first" (call `models.stop` first). Useful for elevated ' +
    "entries whose exit the poller hasn't caught yet — confirms the " +
    'process is gone and reaps the slot.',
  inputSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'integer',
        description: 'OS pid (positive) or synthetic id (negative).',
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
    const r = dismissProcess(a.pid);
    if (!r.ok) throw new Error(r.error ?? 'dismiss failed');
    return { ok: true, pid: a.pid };
  },
});

register({
  name: 'runners.open_chat',
  description:
    "Open the llama-server's built-in web UI (the `entry.url`) in " +
    "the user's default browser via `shell.openExternal`. Useful for " +
    'a thin MCP-driven launcher that wants to drop the user straight ' +
    'into the chat after `models.run`. Side effect happens on the ' +
    "user's desktop; the MCP caller only sees `{ ok: true, action: " +
    "'browser' }`.",
  inputSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'integer',
        description: 'OS pid as returned by `models.run` or `list_running`.',
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
    const entry = getActiveEntry(a.pid);
    if (!entry) throw new Error(`unknown pid: ${a.pid}`);
    const r = await openChatFor(entry);
    if (!r.ok) throw new Error(r.error ?? 'open chat failed');
    return r;
  },
});
