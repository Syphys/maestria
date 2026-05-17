/**
 * Models Hub — IPC registration.
 * Called once from `mainEvents.ts` during `loadMainEvents()`.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
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
  stopProcess,
  type ExitEvent,
  type LogChunkEvent,
} from './runners/launch';
import { openChatFor } from './runners/openChat';
import { resolveCanonicalShardPath, sumShardBytes } from './shardFs';
import { listModelHostingFolders } from './listModelHostingFolders';
import {
  getAutoStart as mcpGetAutoStart,
  getOrCreateToken as mcpGetOrCreateToken,
  getStatus as mcpGetStatus,
  isRunning as mcpIsRunning,
  listTools as mcpListTools,
  regenerateToken as mcpRegenerateToken,
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
