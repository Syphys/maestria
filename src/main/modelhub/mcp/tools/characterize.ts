/**
 * `characterize.*` MCP tools — parity with the renderer's per-model
 * Caractériser and the bulk "Caractériser tous les modèles" panel.
 *
 * Per-model `characterize.start` is synchronous: it resolves when the
 * single-model run completes (seconds to a few minutes — MCP's SSE
 * keepalive is fine over that window).
 *
 * Bulk `characterize.all_start` is **fire-and-forget**: the call
 * returns immediately with `{ started: true }` and the sweep continues
 * in the background. This is deliberate — a full library sweep can
 * take hours (Qwen3.5-397B alone can dominate), and an MCP client
 * (Claude Desktop, deer-flow, scripts) cannot usefully await that.
 * Poll progress with `characterize.all_status` and abort with
 * `characterize.all_cancel`. The last progress snapshot is retained
 * after the sweep ends so a late poller still sees the terminal state.
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
  type CharacterizeAllProgress,
} from '../../routing/characterizeAll';
import { register } from '../registry';

// Latest bulk-sweep progress snapshot. Updated by the `onProgress`
// callback we feed into `characterizeAll`. Retained across the
// terminal phase ('done' / 'cancelled') so a late poller can read
// the final stats even after the sweep ends. Reset only when a new
// bulk run starts.
let lastAllProgress: CharacterizeAllProgress | undefined;
// Captured if the fire-and-forget sweep rejects (e.g., the directory
// vanishes mid-flight). Surfaced through `all_status` so the client
// is not left guessing why the run stopped without progress.
let lastAllError: string | undefined;

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
    'Fire-and-forget: kicks off a bulk characterisation sweep over ' +
    '`directory` (smallest model first) and returns IMMEDIATELY with ' +
    '`{ started: true, directory }`. The sweep runs in the background ' +
    '— poll `characterize.all_status` for live progress and call ' +
    '`characterize.all_cancel` to stop. Single-flight: rejects ' +
    'synchronously with "A bulk characterization is already running" ' +
    'if a sweep is already in progress (use `all_status` to inspect ' +
    'it). The free-gen phase 2 (embedder projection of the monologue) ' +
    'is run per-model AFTER the chat server is stopped, so the ' +
    'embedder spawn never competes with the test model for VRAM.',
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
    // Single-flight check upfront — `characterizeAll` would throw the
    // same error synchronously on the first tick, but doing it here
    // keeps the surface symmetric (we always return JSON, never
    // surface a rejection via the unhandled-promise path below).
    if (isCharacterizeAllRunning()) {
      throw new Error('A bulk characterization is already running');
    }
    // Fresh snapshot — the previous run's terminal state is replaced
    // the instant we start a new one so `all_status` doesn't lie.
    lastAllProgress = undefined;
    lastAllError = undefined;
    // Fire-and-forget. `characterizeAll` sets its internal `running`
    // flag synchronously before its first await, so by the time this
    // handler returns, `isCharacterizeAllRunning()` is already true.
    void characterizeAll(a.directory, {
      skipExisting: a.skipExisting !== false,
      freegen: a.freegen !== false,
      skipProjection: a.skipProjection === true,
      skipWrite: a.skipWrite === true,
      onProgress: (p) => {
        lastAllProgress = p;
      },
    }).catch((e) => {
      lastAllError = (e as Error).message ?? String(e);
    });
    return {
      started: true,
      directory: a.directory,
    };
  },
});

register({
  name: 'characterize.all_status',
  description:
    'Live snapshot of the bulk characterisation sweep started by ' +
    '`characterize.all_start`. Returns `{ running, progress, error }`. ' +
    '`progress` is the latest `CharacterizeAllProgress` (phase, total, ' +
    'done, ok, errors, skipped, projected, currentIndex, currentName, ' +
    'modelStatus, errorSamples) — null until the first onProgress ' +
    'event fires. `running` is false after the sweep ends; the final ' +
    'snapshot is retained so a late poller still sees the terminal ' +
    'phase (`done` / `cancelled`). `error` is set only if the sweep ' +
    'rejected (e.g., directory not found).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    return {
      running: isCharacterizeAllRunning(),
      progress: lastAllProgress ?? null,
      error: lastAllError ?? null,
    };
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
