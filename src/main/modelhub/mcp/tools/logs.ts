/**
 * Log-reading MCP tools. Exposes the same content the renderer's
 * « Logs serveur » / « Erreurs » / runner-detail dialogs read:
 *
 *  - `models.get_server_log` — the full `.ts/<base>.log` (llama-server
 *    stdout/stderr captured during the model's most recent session).
 *  - `models.get_error_log` — the timestamped per-model error journal
 *    written by `characterizeAll`.
 *  - `models.list_server_log_archives` — sibling archive list (one
 *    file per past session, named `<base>.<ISO-stamp>.log`).
 *  - `runners.get_log` — the in-memory ring buffer of a live
 *    `ActiveEntry`. Empty for elevated entries (no stdio capture).
 *
 * All read-only, no admin gate.
 */

import {
  listServerLogArchives,
  readErrorLog,
  readServerLog,
} from '../../modelLogStore';
import { getEntryLog } from '../../runners/launch';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';

register({
  name: 'models.get_server_log',
  description:
    "Read the full `.ts/<base>.log` for a model — llama-server's " +
    'stdout/stderr captured during the most recent session(s) ' +
    'Maestria launched. Returns an empty string when the file is ' +
    'absent (model never launched through Maestria or running on a ' +
    'read-only location).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the .gguf file. Any shard accepted.',
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
    return { log: await readServerLog(canonical) };
  },
});

register({
  name: 'models.get_error_log',
  description:
    'Read the full `.ts/<base>.error` — the timestamped per-model ' +
    'error journal written by `characterizeAll` whenever a model run ' +
    'fails (unsupported arch, sandbox unavailable, server crash, ' +
    'etc.). Returns an empty string when the model has never errored.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the .gguf file. Any shard accepted.',
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
    return { log: await readErrorLog(canonical) };
  },
});

register({
  name: 'models.list_server_log_archives',
  description:
    'List the per-session archived logs sitting next to ' +
    '`.ts/<base>.log` — names are `<base>.<YYYYMMDDThhmmssZ>.log`, ' +
    'newest first. Returns `name`, `mtimeMs`, `size` per archive. ' +
    'Use the names to feed `models.get_server_log_archive` (not ' +
    'exposed — the rotation is deterministic and old archives are ' +
    'pruned to the last 10).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the .gguf file. Any shard accepted.',
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
    return { archives: await listServerLogArchives(canonical) };
  },
});

register({
  name: 'runners.get_log',
  description:
    'Read the in-memory ring buffer (last ~200 lines of ' +
    'stdout/stderr) for a tracked `ActiveEntry`. The buffer is ' +
    'populated by the spawn pipe — elevated entries return an empty ' +
    'array because we never got a `ChildProcess` handle. For ' +
    'long-running models, the persistent log on disk ' +
    '(`models.get_server_log`) is the better source.',
  inputSchema: {
    type: 'object',
    properties: {
      pid: {
        type: 'integer',
        description:
          'OS pid as returned by `models.run` or `models.list_running`. ' +
          'Synthetic negative pids (spawn failures) are accepted — ' +
          'they carry the reason in the buffer.',
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
    const lines = getEntryLog(a.pid);
    if (!lines) {
      throw new Error(`unknown pid: ${a.pid}`);
    }
    return { lines };
  },
});
