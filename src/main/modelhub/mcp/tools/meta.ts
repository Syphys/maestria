/**
 * Sidecar-write MCP tools. The destructive ones (`clear_folder`,
 * `enrich.folder_start`) are marked `requiresAdmin: true` so an MCP
 * client without the admin Bearer can't wipe a user's library or
 * trigger a long disk-bound sweep.
 *
 *  - `meta.patch` — patch arbitrary `modelMeta` fields (userNotes,
 *    userRunParams, …). NOT admin-gated: the equivalent in-app action
 *    is a single text edit and the failure mode is benign (sidecar
 *    field overwrite).
 *  - `meta.enrich` — single-file enrichment (parse header + derive
 *    autoTags + write sidecar). NOT admin-gated: it's the same work
 *    the renderer does silently when the user opens a model.
 *  - `enrich.folder_start` — recursive bulk enrichment. Long-running
 *    (disk + IO bound). ADMIN-GATED: blocks an MCP caller from
 *    triggering a multi-minute sweep without explicit opt-in.
 *  - `meta.clear_folder` — strips `description` + system tags from
 *    every model under a root. ADMIN-GATED: destructive, hard to
 *    undo (the user has to re-enrich to regenerate auto-tags).
 *
 * `enrich.folder_cancel` isn't exposed because the synchronous shape
 * of `enrich.folder_start` (resolves only when the sweep finishes)
 * means there is no caller-visible runId to cancel. If you need to
 * stop a sweep mid-flight, close the MCP transport — the server
 * shutdown breaks the inner cancel token via the closing-session
 * cleanup path.
 */

import { clearFolder } from '../../clearFolder';
import { enrichFolder } from '../../enrichFolder';
import { enrichLocal } from '../../enrichLocal';
import { patchModelMeta } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';
import type { ModelMeta } from '../../../../renderer/modelhub/types';

register({
  name: 'meta.patch',
  description:
    "Patch arbitrary `modelMeta` fields on the model's sidecar. " +
    'Resolves the canonical shard internally — a patch written from ' +
    'any sibling shard lands on shard 1. Typical use: `userNotes`, ' +
    '`userRunParams`, `fitProbe` (after a slow probe). Returns the ' +
    'merged modelMeta plus disk write status.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the model file. Any shard accepted.',
      },
      patch: {
        type: 'object',
        description:
          'Partial modelMeta — only the keys present in the object are ' +
          'merged. Unknown keys are accepted (forward-compat).',
        additionalProperties: true,
      },
    },
    required: ['path', 'patch'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; patch?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    if (
      typeof a.patch !== 'object' ||
      a.patch === null ||
      Array.isArray(a.patch)
    ) {
      throw new Error('patch is required and must be an object');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const result = await patchModelMeta(
      canonical,
      a.patch as Partial<ModelMeta>,
    );
    return {
      written: result.written,
      sidecarPath: result.sidecarPath,
      modelMeta: (result as { modelMeta?: ModelMeta }).modelMeta,
    };
  },
});

register({
  name: 'meta.enrich',
  description:
    'Parse the GGUF header of a single model, derive the system tags ' +
    '(arch:*, quant:*, size:*, ctx:*, dir:*, …) and write them into ' +
    'the sidecar. Idempotent — re-running just refreshes the autoTags. ' +
    'Returns the resulting modelMeta + the auto-tags array.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the .gguf file. Any shard accepted.',
      },
      rootDir: {
        type: 'string',
        description:
          'Optional location root, used to derive `dir:<segment>` ' +
          'auto-tags. Without it only the immediate parent folder is ' +
          'tagged.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; rootDir?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const rootDir =
      typeof a.rootDir === 'string' && a.rootDir ? a.rootDir : undefined;
    const result = await enrichLocal(a.path, { rootDir });
    return result;
  },
});

register({
  name: 'enrich.folder_start',
  description:
    'Walk `directory` recursively and enrich every model file (parse ' +
    'header, derive autoTags, write sidecar). Skips files whose ' +
    '`lastEnrichedAt` is younger than `freshnessMs` (default 1 hour) ' +
    'unless `force: true`. Concurrency defaults to 4 IO workers. ' +
    "Synchronous from the caller's POV — resolves only when the full " +
    'sweep finishes. Returns the summary (total/processed/ok/skipped/' +
    'errors). Cancellable from inside the app via the matching IPC ' +
    'channel; the MCP surface has no per-run id because the call is ' +
    'one-shot.',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Absolute path to the directory to sweep.',
      },
      force: {
        type: 'boolean',
        description: 'Re-enrich even fresh files. Default false.',
      },
      freshnessMs: {
        type: 'integer',
        minimum: 0,
        description: 'Skip files younger than this. Default 3 600 000 (1 h).',
      },
      concurrency: {
        type: 'integer',
        minimum: 1,
        maximum: 16,
        description: 'Parallel IO workers. Default 4.',
      },
      maxFiles: {
        type: 'integer',
        minimum: 1,
        description: 'Hard cap on the number of files processed.',
      },
      skipWrite: {
        type: 'boolean',
        description:
          'Compute everything but skip the sidecar writes (read-only ' +
          'override). Default false.',
      },
    },
    required: ['directory'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      directory?: unknown;
      force?: unknown;
      freshnessMs?: unknown;
      concurrency?: unknown;
      maxFiles?: unknown;
      skipWrite?: unknown;
    };
    if (typeof a.directory !== 'string' || !a.directory) {
      throw new Error('directory is required and must be a string');
    }
    const result = await enrichFolder(a.directory, {
      force: a.force === true,
      freshnessMs:
        typeof a.freshnessMs === 'number' ? a.freshnessMs : undefined,
      concurrency:
        typeof a.concurrency === 'number' ? a.concurrency : undefined,
      maxFiles: typeof a.maxFiles === 'number' ? a.maxFiles : undefined,
      skipWrite: a.skipWrite === true,
    });
    return result;
  },
});

register({
  name: 'meta.clear_folder',
  description:
    'DESTRUCTIVE — bulk-clear every model-file sidecar under ' +
    '`directory`: remove the TagSpaces `description` and every system ' +
    '/ modelhub-origin / auto-namespaced tag (arch:*, quant:*, ' +
    'size:*, …). User-added tags survive untouched. Re-enriching ' +
    'restores the auto-tags but the description is gone for good. ' +
    'Toggle `tags` / `description` independently (both default true). ' +
    'Returns the summary (total/cleared/skipped/errors).',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Absolute path to the directory to sweep.',
      },
      tags: {
        type: 'boolean',
        description:
          'Strip system / auto-namespaced tags from `sidecar.tags[]`. ' +
          'Default true.',
      },
      description: {
        type: 'boolean',
        description: 'Empty the `sidecar.description` string. Default true.',
      },
    },
    required: ['directory'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      directory?: unknown;
      tags?: unknown;
      description?: unknown;
    };
    if (typeof a.directory !== 'string' || !a.directory) {
      throw new Error('directory is required and must be a string');
    }
    const result = await clearFolder(a.directory, {
      tags: a.tags !== false,
      description: a.description !== false,
    });
    return result;
  },
});
