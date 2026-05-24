/**
 * Models Hub — IPC registration.
 * Called once from `mainEvents.ts` during `loadMainEvents()`.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import {
  MODELHUB_IPC,
  ModelMeta,
  RunnerConfig,
  RunParams,
} from '../../renderer/modelhub/types';
import { readModelHeader } from './parseHeader';
import { enrichLocal, EnrichLocalOptions } from './enrichLocal';
import { loadModelMeta, patchModelMeta } from './sidecar';
import { loadSignature } from './routing/signatureStore';
import {
  runCharacterization,
  getCurrentRun,
} from './routing/characterizeRunner';
import {
  characterizeAll,
  cancelCharacterizeAll,
} from './routing/characterizeAll';
import {
  enrichFolder,
  EnrichFolderOptions,
  EnrichFolderProgress,
} from './enrichFolder';
import { clearFolder } from './clearFolder';
import { detectHardwareProfile, detectRawHardwareProfile } from './hardware';
import {
  getOverride as getHardwareOverride,
  setOverride as setHardwareOverride,
  type HardwareOverride,
} from './hardwareOverride';
import {
  effectiveRoutingParams,
  getRoutingConfig,
  setRoutingConfig,
  type RoutingConfig,
} from './routingConfig';
import { listModelFiles } from './listModelFiles';
import { readServerLog, readErrorLog } from './modelLogStore';
import { probeFreeMemory } from './routing/freeMemory';
import { decideRoute } from './routing/routeDecision';
import { ensureEmbedderReady } from './embedderLifecycle';
import type { RouteCandidate } from './routing/router';
import {
  detectAndMerge,
  listRunners,
  removeRunner,
  reprobeRunner,
  saveRunner,
} from './runners/registry';
import { autotune } from './runners/autotune';
import { buildCommand, formatCommandForShell } from './runners/command';
import { probeFitParams } from './runners/fitProbe';
import {
  dismissProcess,
  getActiveEntry,
  getEntryLog,
  killAll,
  launchEvents,
  launchProcess,
  listRunning,
  pickFreePort,
  startElevatedExitPoller,
  stopProcess,
  type ExitEvent,
  type LogChunkEvent,
} from './runners/launch';
import { openChatFor } from './runners/openChat';
import { resolveCanonicalShardPath, sumShardBytes } from './shardFs';
import { listModelHostingFolders } from './listModelHostingFolders';
import {
  getAdminToken as mcpGetAdminToken,
  getAutoStart as mcpGetAutoStart,
  getOrCreateAdminToken as mcpGetOrCreateAdminToken,
  getOrCreateToken as mcpGetOrCreateToken,
  getStatus as mcpGetStatus,
  isRunning as mcpIsRunning,
  listTools as mcpListTools,
  regenerateAdminToken as mcpRegenerateAdminToken,
  regenerateToken as mcpRegenerateToken,
  revokeAdminToken as mcpRevokeAdminToken,
  setAutoStart as mcpSetAutoStart,
  start as mcpStart,
  stop as mcpStop,
} from './mcp';

interface RunState {
  cancelToken: { cancelled: boolean };
}

const activeRuns = new Map<string, RunState>();

function newRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fan-out a launch event to every renderer window. Skip windows that
 * were already destroyed (happens during reload / quit) so a stale
 * reference doesn't crash the broadcaster. Idempotent — safe to call
 * for every event regardless of how many windows are open.
 */
function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* webContents may be detached mid-send — best-effort */
    }
  }
}

export default function registerModelhubEvents(): void {
  // Mirror per-process events out to all renderer windows so the
  // RunningModelsPanel can live-tail the open log dialog and auto-open
  // the dialog on a boot crash. Subscribed once, lives for the app's
  // lifetime — no teardown path because the IPC handlers below also
  // never unregister.
  launchEvents.on('logChunk', (e: LogChunkEvent) => {
    broadcastToAllWindows(MODELHUB_IPC.runnersLogChunk, e);
  });
  launchEvents.on('exit', (e: ExitEvent) => {
    broadcastToAllWindows(MODELHUB_IPC.runnersExit, e);
  });
  // Elevated processes don't fire `child.on('exit')` because we never
  // got a handle. The poller checks each elevated pid every 10 s and
  // emits a synthetic `exit` event so the UI converges. Idempotent.
  startElevatedExitPoller();

  ipcMain.handle(MODELHUB_IPC.parseHeader, async (_event, filePath: string) => {
    return readModelHeader(filePath);
  });

  ipcMain.handle(
    MODELHUB_IPC.enrichLocal,
    async (_event, filePath: string, options?: EnrichLocalOptions) => {
      return enrichLocal(filePath, options ?? {});
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.loadModelMeta,
    async (_event, filePath: string) => {
      try {
        const meta = await loadModelMeta(filePath);
        return { ok: true, modelMeta: meta };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.loadSignature,
    async (_event, filePath: string) => {
      try {
        // loadSignature resolves the canonical shard internally.
        const signature = await loadSignature(filePath);
        return { ok: true, signature: signature ?? null };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.characterizeStart,
    async (_event, filePath: string, skipWrite?: boolean) => {
      try {
        const result = await runCharacterization(filePath, {
          skipWrite,
          onStatus: (s) =>
            broadcastToAllWindows(MODELHUB_IPC.characterizeProgress, {
              // Canonical path of the run (set by the time onStatus fires)
              // so a panel can match the event to its model.
              filePath: getCurrentRun()?.filePath,
              status: s,
            }),
        });
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.characterizeStatus, async () => {
    return { ok: true, run: getCurrentRun() };
  });

  ipcMain.handle(
    MODELHUB_IPC.characterizeAllStart,
    async (
      _event,
      rootDir: string,
      skipWrite?: boolean,
      skipExisting?: boolean,
      freegen?: boolean,
      // « Sans calcul vectoriel » — tests + monologue, projections deferred.
      // Implicit when no embedder is configured (silent fallback).
      skipProjection?: boolean,
    ) => {
      try {
        const result = await characterizeAll(rootDir, {
          skipWrite,
          skipExisting,
          freegen,
          skipProjection,
          onProgress: (p) =>
            broadcastToAllWindows(MODELHUB_IPC.characterizeAllProgress, p),
        });
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.characterizeAllCancel, async () => {
    cancelCharacterizeAll();
    return { ok: true };
  });

  // Absolute path of the routing-questions folder so the renderer can
  // open it inside Maestria as a read-only location.
  //
  // The path depends on how Electron was launched:
  //   - Packaged build  → `<resources>/modelhub-questions/` (copied
  //     there by electron-builder `extraResources` in builder.json).
  //   - `npm run dev`   → Electron uses the ROOT `package.json`
  //     (electronmon entry `.erb/dll/main.bundle.dev.js`), so
  //     `app.getAppPath()` returns the repo root.
  //   - `npm run run-electron` (after `npm run build`) → Electron uses
  //     `release/app/package.json`, so `app.getAppPath()` returns
  //     `release/app/` and we have to walk up.
  //
  // Rather than guess the launch mode, probe each candidate with
  // `existsSync` and return the first hit. Falls back with a clear
  // error when none match — that surfaces in the renderer notification
  // so the user knows it's a packaging / dev-config issue, not a bug
  // in the location entry.
  ipcMain.handle(MODELHUB_IPC.getQuestionsDir, async () => {
    try {
      const appPath = app.getAppPath();
      const candidates: string[] = [];
      if (app.isPackaged) {
        candidates.push(path.join(process.resourcesPath, 'modelhub-questions'));
      }
      // `npm run dev` — appPath is the repo root.
      candidates.push(
        path.join(appPath, 'src', 'main', 'modelhub', 'routing', 'questions'),
      );
      // `npm run run-electron` — appPath is `<repo>/release/app/`, so
      // we walk two levels up to the repo root and back down.
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
      // Some builds keep an extras dir alongside the bundled main.
      candidates.push(path.join(appPath, '..', '..', 'modelhub-questions'));
      for (const c of candidates) {
        if (existsSync(c)) {
          return { ok: true, path: c };
        }
      }
      return {
        ok: false,
        error: `routing-questions folder not found. Tried: ${candidates.join(' | ')}`,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Per-model log readers — used by the CharacterizeAllPanel tabs
  // (« Logs serveur » / « Erreurs ») to show what llama-server printed
  // during the model's session(s) and the timestamped error journal
  // from the bulk characterizer. Both resolve the canonical shard
  // internally so the caller can pass any sibling.
  ipcMain.handle(
    MODELHUB_IPC.getServerLog,
    async (_event, filePath: string) => {
      try {
        const canonical = await resolveCanonicalShardPath(filePath);
        const content = await readServerLog(canonical);
        return { ok: true, content };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.getErrorLog, async (_event, filePath: string) => {
    try {
      const canonical = await resolveCanonicalShardPath(filePath);
      const content = await readErrorLog(canonical);
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    MODELHUB_IPC.enrichFolderStart,
    async (
      event,
      rootDir: string,
      options?: Omit<EnrichFolderOptions, 'cancelToken'>,
    ) => {
      const runId = newRunId();
      const cancelToken = { cancelled: false };
      activeRuns.set(runId, { cancelToken });
      const sender = event.sender;

      // Fire-and-forget: do the work async, push events to the renderer.
      (async () => {
        try {
          const summary = await enrichFolder(
            rootDir,
            { ...(options ?? {}), cancelToken },
            (p: EnrichFolderProgress) => {
              if (sender.isDestroyed()) return;
              sender.send(MODELHUB_IPC.enrichFolderProgress, { runId, ...p });
            },
          );
          if (!sender.isDestroyed()) {
            sender.send(MODELHUB_IPC.enrichFolderDone, { runId, summary });
          }
        } catch (e) {
          if (!sender.isDestroyed()) {
            sender.send(MODELHUB_IPC.enrichFolderDone, {
              runId,
              error: (e as Error).message,
            });
          }
        } finally {
          activeRuns.delete(runId);
        }
      })();

      return { runId };
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.enrichFolderCancel,
    async (_event, runId: string) => {
      const run = activeRuns.get(runId);
      if (!run) return { ok: false, error: 'unknown runId' };
      run.cancelToken.cancelled = true;
      return { ok: true };
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.clearFolder,
    async (
      _event,
      rootDir: string,
      options?: {
        tags?: boolean;
        description?: boolean;
      },
    ) => {
      try {
        // Backward-compat: when no options are passed, default to the
        // legacy behaviour (clear both tags + description).
        const opts = options ?? { tags: true, description: true };
        const summary = await clearFolder(rootDir, opts);
        return { ok: true, ...summary };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.patchModelMeta,
    async (_event, filePath: string, patch: Partial<ModelMeta>) => {
      try {
        // Resolve to canonical so notes / userRunParams written from any
        // shard land on the canonical sidecar — same convention as enrich.
        const canonical = await resolveCanonicalShardPath(filePath);
        const result = await patchModelMeta(canonical, patch);
        return {
          ok: true,
          modelMeta: result.modelMeta,
          sidecarPath: result.sidecarPath,
          written: result.written,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.detectHardware, async () => {
    try {
      const profile = await detectHardwareProfile();
      return { ok: true, profile };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.detectHardwareRaw, async () => {
    try {
      const profile = await detectRawHardwareProfile();
      return { ok: true, profile };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.getHardwareOverride, async () => {
    try {
      const override = await getHardwareOverride();
      return { ok: true, override };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    MODELHUB_IPC.setHardwareOverride,
    async (_event, override: HardwareOverride) => {
      try {
        await setHardwareOverride(override ?? {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.getRoutingConfig, async () => {
    try {
      const config = await getRoutingConfig();
      return { ok: true, config };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    MODELHUB_IPC.setRoutingConfig,
    async (_event, config: RoutingConfig) => {
      try {
        await setRoutingConfig(config ?? {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.listModelHostingFolders,
    async (_event, rootDir: string) => {
      try {
        const folders = await listModelHostingFolders(rootDir);
        return { ok: true, folders };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.sumShardBytes,
    async (_event, filePath: string) => {
      try {
        // Resolve to canonical first so callers can pass any shard from
        // the set and still get the aggregate size of the whole model.
        const canonical = await resolveCanonicalShardPath(filePath);
        const agg = await sumShardBytes(canonical);
        return {
          ok: true,
          totalBytes: agg.totalBytes,
          shardCount: agg.shardCount,
          expectedTotal: agg.expectedTotal,
          incomplete: agg.incomplete,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  // ---- Runners ---------------------------------------------------------

  ipcMain.handle(MODELHUB_IPC.runnersList, async () => {
    try {
      const runners = await listRunners();
      return { ok: true, runners };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    MODELHUB_IPC.runnersSave,
    async (_event, runner: RunnerConfig) => {
      try {
        const saved = await saveRunner(runner);
        return { ok: true, runner: saved };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.runnersRemove, async (_event, id: string) => {
    try {
      await removeRunner(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.runnersDetect, async () => {
    try {
      const runners = await detectAndMerge();
      return { ok: true, runners };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.runnersReprobe, async (_event, id: string) => {
    try {
      const runner = await reprobeRunner(id);
      if (!runner) return { ok: false, error: 'unknown runner id' };
      return { ok: true, runner };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    MODELHUB_IPC.runnersAutotune,
    async (_event, filePath: string, port?: number) => {
      try {
        // Sharded models: every runner expects to load shard 1, not shard N.
        // Centralize the redirect here so renderer code stays oblivious.
        const canonical = await resolveCanonicalShardPath(filePath);
        const meta = await loadModelMeta(canonical).catch(() => undefined);
        let header = meta?.header;
        if (!header) {
          const parsed = await readModelHeader(canonical);
          if (parsed.ok && parsed.meta) header = parsed.meta;
        }
        const hardware = await detectHardwareProfile();
        const estimated = autotune({ header, hardware, port });
        // User overrides take precedence at launch time. We return both:
        //  - `params` is what'll be used (override if present, else estimated)
        //  - `estimated` is the unfiltered autotune result so the UI can
        //    show both columns side by side.
        const userOverride = meta?.userRunParams;
        const params = userOverride
          ? { ...estimated, ...userOverride }
          : estimated;
        return {
          ok: true,
          params,
          estimated,
          hasUserOverride: !!userOverride,
          header,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.runnersBuildCommand,
    async (
      _event,
      runner: RunnerConfig,
      filePath: string,
      params: RunParams,
    ) => {
      try {
        const canonical = await resolveCanonicalShardPath(filePath);
        const built = buildCommand(runner, canonical, params);
        return {
          ok: true,
          command: built.command,
          shell: formatCommandForShell(built.command),
          url: built.url,
          warnings: built.warnings,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    MODELHUB_IPC.runnersLaunch,
    async (
      _event,
      runner: RunnerConfig,
      filePath: string,
      params: RunParams,
    ) => {
      try {
        const canonical = await resolveCanonicalShardPath(filePath);
        const fileBasename = canonical.replace(/^.*[\\/]/, '');
        // Re-pin to a free port. The renderer's autotune always emits
        // 8080; two consecutive Runs would otherwise share the URL and
        // the second server would crash on EADDRINUSE.
        const effectiveParams: RunParams = {
          ...params,
          port: pickFreePort(params.port ?? 8080),
        };
        const built = buildCommand(runner, canonical, effectiveParams);
        const result = launchProcess(built.command, {
          url: built.url,
          runnerLabel: runner.label,
          modelName: fileBasename,
          filePath: canonical,
        });
        return { ...result, warnings: built.warnings };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.runnersStop, async (_event, pid: number) => {
    return stopProcess(pid);
  });

  ipcMain.handle(
    MODELHUB_IPC.runnersFitProbe,
    async (
      _event,
      runner: RunnerConfig,
      filePath: string,
      params: RunParams,
      options?: { suggest?: boolean },
    ) => {
      try {
        const canonical = await resolveCanonicalShardPath(filePath);
        const outcome = await probeFitParams(runner, canonical, params, {
          suggest: options?.suggest !== false,
        });
        return outcome;
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  ipcMain.handle(MODELHUB_IPC.runnersRunning, async () => {
    return { ok: true, running: listRunning() };
  });

  ipcMain.handle(MODELHUB_IPC.runnersGetLog, async (_event, pid: number) => {
    const log = getEntryLog(pid);
    if (!log) return { ok: false, error: 'unknown pid' };
    return { ok: true, log };
  });

  ipcMain.handle(MODELHUB_IPC.runnersDismiss, async (_event, pid: number) => {
    return dismissProcess(pid);
  });

  ipcMain.handle(MODELHUB_IPC.runnersOpenChat, async (_event, pid: number) => {
    const entry = getActiveEntry(pid);
    if (!entry) return { ok: false, error: 'unknown pid' };
    return openChatFor(entry);
  });

  // ---- MCP server -----------------------------------------------------

  ipcMain.handle(MODELHUB_IPC.mcpStart, async () => {
    try {
      const r = await mcpStart();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpStop, async () => {
    try {
      await mcpStop();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpStatus, async () => {
    return { ok: true, status: mcpGetStatus() };
  });

  ipcMain.handle(MODELHUB_IPC.mcpGetToken, async () => {
    try {
      const token = await mcpGetOrCreateToken();
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpRegenerateToken, async () => {
    try {
      const token = await mcpRegenerateToken();
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpListTools, async () => {
    return {
      ok: true,
      tools: mcpListTools().map((t) => ({
        name: t.name,
        description: t.description,
      })),
    };
  });

  ipcMain.handle(MODELHUB_IPC.mcpGetAutoStart, async () => {
    try {
      const autoStart = await mcpGetAutoStart();
      return { ok: true, autoStart };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    MODELHUB_IPC.mcpSetAutoStart,
    async (_event, enabled: boolean) => {
      try {
        await mcpSetAutoStart(!!enabled);
        // If we just flipped it on AND nothing is bound yet, start the
        // server now so the user can use it immediately without
        // restarting the app. Flipping it off does NOT stop a running
        // server — the user can press Stop in the UI if they want.
        if (enabled && !mcpIsRunning()) {
          await mcpStart();
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  // ---- Admin token (separate Bearer for requiresAdmin tools) ----------
  ipcMain.handle(MODELHUB_IPC.mcpGetAdminToken, async () => {
    try {
      const token = await mcpGetAdminToken();
      // Surface null (not undefined) so the renderer can distinguish
      // "no admin token has been generated" from "the call failed".
      return { ok: true, token: token ?? null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpCreateAdminToken, async () => {
    try {
      const token = await mcpGetOrCreateAdminToken();
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpRegenerateAdminToken, async () => {
    try {
      const token = await mcpRegenerateAdminToken();
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(MODELHUB_IPC.mcpRevokeAdminToken, async () => {
    try {
      await mcpRevokeAdminToken();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Slice 9 — search-integrated competence routing. Same pipeline as the
  // `models.route` MCP tool, but invoked from the renderer's search bar
  // when `searchType: 'routing'` is selected. Returns just the ranked
  // file paths + their score so the LocationIndexContextProvider can map
  // them to FileSystemEntry[] for the perspective renderers. Failure ⇒
  // empty array (caller falls back to a fuzzy search silently).
  ipcMain.handle(
    MODELHUB_IPC.routeQuery,
    async (
      _event,
      args: { query: string; directoryPath: string; limit?: number },
    ) => {
      const { query, directoryPath } = args;
      const limit =
        typeof args.limit === 'number' && args.limit > 0
          ? Math.floor(args.limit)
          : 50;
      if (!query || !query.trim() || !directoryPath) {
        return { hits: [], routedBy: 'r5', gateReason: 'empty query / path' };
      }
      try {
        // Hot bonus — canonical paths held by a live runner.
        const runningSet = new Set<string>();
        for (const r of listRunning()) {
          if (!r.exited && r.filePath) {
            runningSet.add(await resolveCanonicalShardPath(r.filePath));
          }
        }

        const files = await listModelFiles(directoryPath);
        const candidates: RouteCandidate[] = await Promise.all(
          files.map(async (f) => {
            const signature =
              (await loadSignature(f).catch(() => undefined)) ?? null;
            let footprintBytes: number | undefined;
            if (
              signature &&
              !(
                typeof signature.structural?.est_footprint_bytes === 'number' &&
                signature.structural.est_footprint_bytes > 0
              )
            ) {
              const bytes = await sumShardBytes(f)
                .then((s) => s.totalBytes)
                .catch(() => 0);
              if (bytes > 0) footprintBytes = bytes;
            }
            return {
              id: f,
              signature,
              footprintBytes,
              running: runningSet.has(f),
            };
          }),
        );

        const resources = await probeFreeMemory();
        const params = effectiveRoutingParams(await getRoutingConfig());

        // Resolve managed embedder → live URL (slice 7e), or pass
        // through the external URL. Absent ⇒ decideRoute handles R5.
        let embedderRef: { baseUrl: string; model?: string } | undefined;
        if (params.embedder?.kind === 'managed') {
          const ready = await ensureEmbedderReady(params.embedder.filePath, {
            model: params.embedder.model,
          });
          if (ready) {
            embedderRef = { baseUrl: ready.baseUrl, model: ready.model };
          }
        } else if (params.embedder?.kind === 'external') {
          embedderRef = {
            baseUrl: params.embedder.baseUrl,
            model: params.embedder.model,
          };
        }

        const decision = await decideRoute({
          query,
          candidates,
          resources,
          embedder: embedderRef,
          params: {
            thetaQ: params.thetaQ,
            embeddingReliabilityThreshold: params.embeddingReliabilityThreshold,
          },
        });

        // Only eligible (D9) entries → mask out the rest. Sort by score
        // desc, normalise into [0, 1] just in case.
        const ranked = (decision.ranked as Array<any>).filter(
          (r) => r.eligible !== false && typeof r.score === 'number',
        );
        ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const head = ranked.slice(0, limit);
        const maxScore = head.length > 0 ? (head[0].score ?? 1) : 1;
        const hits = head.map((r) => ({
          path: r.id as string,
          score:
            maxScore > 0
              ? Math.min(1, Math.max(0, (r.score ?? 0) / maxScore))
              : 0,
        }));
        return {
          hits,
          routedBy: decision.routedBy,
          gateReason: decision.gateReason,
        };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[routeQuery] failed: ${(e as Error).message}`);
        return {
          hits: [],
          routedBy: 'r5',
          gateReason: `error: ${(e as Error).message}`,
        };
      }
    },
  );

  // Auto-start the MCP server if the user enabled it last session.
  // Fire-and-forget so a binding failure (port busy, etc.) doesn't
  // wedge the modelhub IPC bootstrap.
  (async () => {
    try {
      if (await mcpGetAutoStart()) {
        await mcpStart();
      }
    } catch (e) {
      console.warn(
        '[modelhub-mcp] auto-start failed:',
        (e as Error).message ?? e,
      );
    }
  })();

  // Don't leave runner child processes — or the MCP listener — orphaned
  // when the app quits.
  app.on('before-quit', () => {
    killAll();
    if (mcpIsRunning()) {
      // Best-effort, fire-and-forget — Electron doesn't await before-quit.
      void mcpStop();
    }
  });
}
