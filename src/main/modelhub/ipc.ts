/**
 * Models Hub — IPC registration.
 * Called once from `mainEvents.ts` during `loadMainEvents()`.
 */

import { app, ipcMain } from 'electron';
import {
  MODELHUB_IPC,
  ModelMeta,
  RunnerConfig,
  RunParams,
} from '../../renderer/modelhub/types';
import { readModelHeader } from './parseHeader';
import { enrichLocal, EnrichLocalOptions } from './enrichLocal';
import { enrichHf, EnrichHfOptions } from './enrichHf';
import { loadModelMeta, patchModelMeta } from './sidecar';
import {
  enrichFolder,
  EnrichFolderOptions,
  EnrichFolderProgress,
} from './enrichFolder';
import { clearFolder } from './clearFolder';
import { detectHardwareProfile } from './hardware';
import {
  detectAndMerge,
  listRunners,
  removeRunner,
  saveRunner,
} from './runners/registry';
import { autotune } from './runners/autotune';
import { buildCommand, formatCommandForShell } from './runners/command';
import {
  getActiveEntry,
  killAll,
  launchProcess,
  listRunning,
  registerExternalModel,
  stopProcess,
} from './runners/launch';
import { openChatFor } from './runners/openChat';
import { isOllamaDaemonRunning, prepareOllamaModel } from './runners/ollama';
import { resolveCanonicalShardPath, sumShardBytes } from './shardFs';
import { listModelHostingFolders } from './listModelHostingFolders';

interface RunState {
  cancelToken: { cancelled: boolean };
}

const activeRuns = new Map<string, RunState>();

function newRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function registerModelhubEvents(): void {
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
    MODELHUB_IPC.enrichHf,
    async (_event, filePath: string, options?: EnrichHfOptions) => {
      return enrichHf(filePath, options ?? {});
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

  ipcMain.handle(MODELHUB_IPC.clearFolder, async (_event, rootDir: string) => {
    try {
      const summary = await clearFolder(rootDir);
      return { ok: true, ...summary };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

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
        // Ollama needs a registration step before the file is usable. We
        // also avoid spawning a second `ollama serve` when the installer
        // already left a daemon running — that would fail with EADDRINUSE.
        if (runner.kind === 'ollama') {
          const prep = await prepareOllamaModel(runner.path, canonical, params);
          const url = 'http://127.0.0.1:11434';
          const info = [
            prep.alreadyRegistered
              ? `Model already registered as "${prep.modelName}".`
              : prep.ok
                ? `Registered as "${prep.modelName}".`
                : `Registration failed: ${prep.error}`,
            `Use it from any Ollama client: \`ollama run ${prep.modelName}\` or POST http://127.0.0.1:11434/api/chat with model="${prep.modelName}".`,
          ];

          if (isOllamaDaemonRunning(runner.path)) {
            // Daemon belongs to the OS — we don't own it. Surface the
            // registered model in the running list as a synthetic entry
            // so the user gets a Stop / Open Chat button anyway.
            const entry = prep.ok
              ? registerExternalModel({
                  command: [runner.path, 'run', prep.modelName],
                  url,
                  runnerKind: 'ollama',
                  runnerLabel: runner.label,
                  modelName: prep.modelName,
                })
              : undefined;
            return {
              ok: prep.ok,
              url,
              pid: entry?.pid,
              modelName: prep.modelName,
              warnings: info,
              error: prep.ok ? undefined : prep.error,
            };
          }
          // Daemon not reachable — start it ourselves.
          const built = buildCommand(runner, canonical, params);
          const spawned = launchProcess(built.command, {
            url,
            runnerKind: 'ollama',
            runnerLabel: runner.label,
            modelName: prep.modelName,
          });
          return {
            ...spawned,
            modelName: prep.modelName,
            warnings: [
              ...info,
              ...(built.warnings ?? []),
              'Started `ollama serve` in the background.',
            ],
          };
        }

        const built = buildCommand(runner, canonical, params);
        const result = launchProcess(built.command, {
          url: built.url,
          runnerKind: runner.kind,
          runnerLabel: runner.label,
          modelName: fileBasename,
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

  ipcMain.handle(MODELHUB_IPC.runnersRunning, async () => {
    return { ok: true, running: listRunning() };
  });

  ipcMain.handle(MODELHUB_IPC.runnersOpenChat, async (_event, pid: number) => {
    const entry = getActiveEntry(pid);
    if (!entry) return { ok: false, error: 'unknown pid' };
    return openChatFor(entry);
  });

  // Don't leave runner child processes orphaned when the app quits.
  app.on('before-quit', () => {
    killAll();
  });
}
