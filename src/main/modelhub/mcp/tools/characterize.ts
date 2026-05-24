/**
 * `characterize.*` MCP tools — parity with the renderer's per-model
 * Caractériser and the bulk "Caractériser tous les modèles" panel.
 *
 * Long-running operations (`characterize.start`, `characterize.all_start`)
 * resolve only when the run completes. MCP's SSE transport handles
 * keepalive over multi-minute calls, so a synchronous tool surface is
 * fine here. Cancellation lives behind separate tools
 * (`characterize.all_cancel`) — single-model `start` is not cancellable
 * for the same reason the UI doesn't expose a cancel button on the
 * per-model Inférence tab: the suite is short enough that running it
 * to completion is always cheaper than tearing it down mid-flight.
 *
 * `load_signature` is read-only and unrestricted.
 *
 * Write operations are NOT marked `requiresAdmin: true` — characterising
 * a model is the *purpose* of Maestria, and labelling it admin-only
 * would defeat the API's point. The destructive surface is restricted
 * to `meta.clear_folder` and the config setters.
 */

import { app } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { resolveCanonicalShardPath } from '../../shardFs';
import { loadSignature } from '../../routing/signatureStore';
import {
  getCurrentRun,
  runCharacterization,
} from '../../routing/characterizeRunner';
import {
  cancelCharacterizeAll,
  characterizeAll,
  isCharacterizeAllRunning,
} from '../../routing/characterizeAll';
import { register } from '../registry';

register({
  name: 'characterize.start',
  description:
    'Run the deterministic R5 + tree characterisation for a single ' +
    "model. Reuses the model's already-running llama-server if any, " +
    'otherwise launches an autotuned ephemeral one (stopped on ' +
    'completion). Single-flight server-side — concurrent invocations ' +
    'are rejected. Resolves when the signature has been computed and ' +
    "persisted to the model's `.ts/<base>.json` sidecar (use " +
    '`load_signature` to read it back, or `models.get` for the full ' +
    'sidecar). Read `characterize.status` mid-flight from another ' +
    'tool call to poll progress.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to a .gguf file. Any shard accepted; ' +
          'resolves to shard 1 internally.',
      },
      skipWrite: {
        type: 'boolean',
        description:
          'When true, compute the signature but do NOT write the ' +
          'sidecar (read-only location override). Default false.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; skipWrite?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const skipWrite = a.skipWrite === true;
    const result = await runCharacterization(a.path, { skipWrite });
    return result;
  },
});

register({
  name: 'characterize.status',
  description:
    'Snapshot of the active per-model characterisation, or null when ' +
    'none is running. Cheap — reads an in-memory ref. Same shape as ' +
    "the renderer's `MODELHUB_IPC.characterizeStatus` channel.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const run = getCurrentRun();
    if (!run) return null;
    return { filePath: run.filePath, status: run.status };
  },
});

register({
  name: 'characterize.all_start',
  description:
    'Bulk-characterise every model under `directory`, smallest first. ' +
    'Single-flight — rejects with "A bulk characterization is already ' +
    'running" if one is in progress. Resolves only when the full ' +
    'sweep finishes (can be 30+ minutes). The free-gen phase 2 ' +
    '(embedder projection of the monologue) is run per-model AFTER ' +
    'the chat server is stopped, so the embedder spawn never competes ' +
    'with the test model for VRAM. Returns the final ' +
    '`CharacterizeAllProgress` snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Absolute path to the directory to scan.',
      },
      skipExisting: {
        type: 'boolean',
        description:
          'When true (default), skip models that already carry a ' +
          'complete signature. Set to false to force re-characterisation.',
      },
      freegen: {
        type: 'boolean',
        description:
          'Enable « Parler libre » — generate a ~600-800 word ' +
          'monologue per model (used by the projection phase to derive ' +
          'topic coverage). Default true.',
      },
      skipProjection: {
        type: 'boolean',
        description:
          'When true, run free-gen text generation only; defer the ' +
          'embedder projection (« Sans calcul vectoriel »). Implicit ' +
          'when no embedder is configured (silent fallback). Default ' +
          'false.',
      },
      skipWrite: {
        type: 'boolean',
        description:
          'Compute signatures but skip the sidecar writes (read-only ' +
          'override). Default false.',
      },
    },
    required: ['directory'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      directory?: unknown;
      skipExisting?: unknown;
      freegen?: unknown;
      skipProjection?: unknown;
      skipWrite?: unknown;
    };
    if (typeof a.directory !== 'string' || !a.directory) {
      throw new Error('directory is required and must be a string');
    }
    const result = await characterizeAll(a.directory, {
      skipExisting: a.skipExisting !== false,
      freegen: a.freegen !== false,
      skipProjection: a.skipProjection === true,
      skipWrite: a.skipWrite === true,
    });
    return result;
  },
});

register({
  name: 'characterize.all_cancel',
  description:
    'Request the bulk characterisation to stop. Honoured BETWEEN ' +
    'models — the model currently under test runs to completion. ' +
    'Returns immediately. Idempotent — no-op when no bulk run is ' +
    'active.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const wasRunning = isCharacterizeAllRunning();
    cancelCharacterizeAll();
    return { wasRunning, cancelled: wasRunning };
  },
});

register({
  name: 'characterize.load_signature',
  description:
    "Read the model's `signature` block from its `.ts/<base>.json` " +
    'sidecar: R5 behavioural vector, tree branch scores, free-gen ' +
    'text + topic-coverage (when projected), `characterization_state` ' +
    '(`none` / `running` / `done` / `failed`). Returns null when the ' +
    'model has never been characterised. Read-only — same data the ' +
    "renderer's Compétence radar consumes.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to a .gguf file. Any shard accepted.',
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
    const signature = await loadSignature(canonical).catch(() => undefined);
    return signature ?? null;
  },
});

register({
  name: 'characterize.get_questions_dir',
  description:
    'Return the absolute path of the bundled routing-questions ' +
    'directory (probe-anchors / tree-v0 / v1-30 / mcq-v1 / qcm-v0 / ' +
    'embedding-triplets). Used to open the prompts in the editor ' +
    'for « Voir les questions sources » from the bulk panel.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const appPath = app.getAppPath();
    const candidates: string[] = [];
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'modelhub-questions'));
    }
    candidates.push(
      path.join(appPath, 'src', 'main', 'modelhub', 'routing', 'questions'),
    );
    candidates.push(
      path.resolve(
        appPath,
        '..',
        '..',
        'src',
        'main',
        'modelhub',
        'routing',
        'questions',
      ),
    );
    candidates.push(path.join(appPath, '..', '..', 'modelhub-questions'));
    for (const c of candidates) {
      if (existsSync(c)) return { path: c };
    }
    throw new Error(
      'bundled routing questions directory not found — packaging issue',
    );
  },
});
