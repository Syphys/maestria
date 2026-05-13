/**
 * Renderer-side hook + thin IPC wrapper for runner operations.
 *
 * One source of truth: components call `useRunners()` and get the list +
 * mutations. The hook auto-loads on mount and refreshes after every save /
 * remove / detect so views stay consistent without manual refetching.
 */

import { useCallback, useEffect, useState } from 'react';
import { LaunchResult, MODELHUB_IPC, RunnerConfig, RunParams } from '../types';
import { pickRunnerFor } from './pick';

function ipc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const r = window.electronIO?.ipcRenderer as
    | { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
    | undefined;
  if (!r) return Promise.reject(new Error('ipcRenderer unavailable'));
  return r.invoke(channel, ...args) as Promise<T>;
}

export interface BuildCommandResult {
  ok: boolean;
  command?: string[];
  shell?: string;
  url?: string;
  warnings?: string[];
  error?: string;
}

export interface AutotuneResult {
  ok: boolean;
  /** Effective params to launch with (user override merged onto estimated). */
  params?: RunParams;
  /**
   * Pure autotune output, with no user override applied. Lets the UI show
   * a "what we'd recommend" column next to the editable "what we'll use" column.
   */
  estimated?: RunParams;
  /** True when the sidecar carries a `userRunParams` patch. */
  hasUserOverride?: boolean;
  error?: string;
}

export async function listRunners(): Promise<RunnerConfig[]> {
  const r = await ipc<{ ok: boolean; runners?: RunnerConfig[] }>(
    MODELHUB_IPC.runnersList,
  );
  return r.ok && r.runners ? r.runners : [];
}

export async function saveRunner(
  runner: RunnerConfig,
): Promise<RunnerConfig | undefined> {
  const r = await ipc<{ ok: boolean; runner?: RunnerConfig; error?: string }>(
    MODELHUB_IPC.runnersSave,
    runner,
  );
  if (!r.ok) throw new Error(r.error ?? 'save failed');
  return r.runner;
}

export async function removeRunner(id: string): Promise<void> {
  const r = await ipc<{ ok: boolean; error?: string }>(
    MODELHUB_IPC.runnersRemove,
    id,
  );
  if (!r.ok) throw new Error(r.error ?? 'remove failed');
}

export async function detectRunners(): Promise<RunnerConfig[]> {
  const r = await ipc<{ ok: boolean; runners?: RunnerConfig[] }>(
    MODELHUB_IPC.runnersDetect,
  );
  return r.ok && r.runners ? r.runners : [];
}

export async function autotuneFor(
  filePath: string,
  port?: number,
): Promise<AutotuneResult> {
  return ipc<AutotuneResult>(MODELHUB_IPC.runnersAutotune, filePath, port);
}

export async function buildCommand(
  runner: RunnerConfig,
  filePath: string,
  params: RunParams,
): Promise<BuildCommandResult> {
  return ipc<BuildCommandResult>(
    MODELHUB_IPC.runnersBuildCommand,
    runner,
    filePath,
    params,
  );
}

export async function launchRunner(
  runner: RunnerConfig,
  filePath: string,
  params: RunParams,
): Promise<LaunchResult & { warnings?: string[] }> {
  return ipc<LaunchResult & { warnings?: string[] }>(
    MODELHUB_IPC.runnersLaunch,
    runner,
    filePath,
    params,
  );
}

export async function stopRunner(pid: number): Promise<void> {
  await ipc(MODELHUB_IPC.runnersStop, pid);
}

export interface RunningEntryExitInfo {
  code: number | null;
  signal: string | null;
  exitedAt: string;
}

export interface RunningEntry {
  pid: number;
  command: string[];
  url?: string;
  runnerLabel?: string;
  modelName?: string;
  /**
   * Provenance label — undefined when the user clicked Run in the app
   * ("Direct" bucket in the panel), a short string like
   * "via MCP — deer-flow" when an MCP client called `models.run`.
   */
  launchedBy?: string;
  startedAt: string;
  /**
   * Set when the process has exited. The entry stays in the panel
   * (greyed-out, no Open in browser) until the user dismisses it,
   * so they can read the captured logs.
   */
  exited?: RunningEntryExitInfo;
  recentLog: string[];
}

export async function getRunnerLog(pid: number): Promise<string[]> {
  const r = await ipc<{ ok: boolean; log?: string[]; error?: string }>(
    MODELHUB_IPC.runnersGetLog,
    pid,
  );
  if (!r.ok || !r.log) throw new Error(r.error ?? 'log fetch failed');
  return r.log;
}

export async function dismissRunner(pid: number): Promise<void> {
  const r = await ipc<{ ok: boolean; error?: string }>(
    MODELHUB_IPC.runnersDismiss,
    pid,
  );
  if (!r.ok) throw new Error(r.error ?? 'dismiss failed');
}

export async function listRunningModels(): Promise<RunningEntry[]> {
  const r = await ipc<{ ok: boolean; running?: RunningEntry[] }>(
    MODELHUB_IPC.runnersRunning,
  );
  return r.ok && r.running ? r.running : [];
}

export interface OpenChatResult {
  ok: boolean;
  /** What we ended up doing — drives the renderer's notification text. */
  action?: 'browser' | 'noop';
  error?: string;
}

export async function openChatForPid(pid: number): Promise<OpenChatResult> {
  return ipc<OpenChatResult>(MODELHUB_IPC.runnersOpenChat, pid);
}

export interface UseRunnersState {
  runners: RunnerConfig[];
  loading: boolean;
  refresh: () => Promise<void>;
  detect: () => Promise<void>;
  save: (r: RunnerConfig) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useRunners(): UseRunnersState {
  const [runners, setRunners] = useState<RunnerConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listRunners();
      setRunners(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const detect = useCallback(async () => {
    setLoading(true);
    try {
      const r = await detectRunners();
      setRunners(r);
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(
    async (r: RunnerConfig) => {
      await saveRunner(r);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeRunner(id);
      await refresh();
    },
    [refresh],
  );

  return { runners, loading, refresh, detect, save, remove };
}

// `pickRunnerFor` was extracted to `./pick.ts` so the main process can
// import it without pulling React. Re-exported here for renderer callers
// that already depend on it via this module.
export { pickRunnerFor };

export interface QuickLaunchResult {
  ok: boolean;
  /** Server URL when the runner exposes one. */
  url?: string;
  /** Process id of the spawned child, when applicable. */
  pid?: number;
  /** Effective params used (with user override merged onto estimated). */
  params?: RunParams;
  runner?: RunnerConfig;
  warnings?: string[];
  /** When `true`, no runner is configured and the caller should open setup UI. */
  needsSetup?: boolean;
  error?: string;
}

/**
 * One-call launch path for non-React contexts (file context menu, command
 * palette). Resolves the canonical shard, picks the best runner, autotunes
 * with user overrides applied, spawns the runner, then **immediately
 * triggers the "open chat" surface** (terminal for Ollama, browser for
 * runners with a built-in web UI). The two used to be separate clicks
 * which made no sense — the user wants the model to be usable as soon
 * as it's running.
 */
export async function quickLaunchModel(
  filePath: string,
): Promise<QuickLaunchResult> {
  const runners = await listRunners();
  const runner = pickRunnerFor(runners, filePath);
  if (!runner) {
    return { ok: false, needsSetup: true, error: 'no runner configured' };
  }
  const tune = await autotuneFor(filePath);
  if (!tune.ok || !tune.params) {
    return { ok: false, runner, error: tune.error ?? 'autotune failed' };
  }
  const launch = await launchRunner(runner, filePath, tune.params);
  if (!launch.ok) {
    return {
      ok: false,
      url: launch.url,
      pid: launch.pid,
      params: tune.params,
      runner,
      warnings: launch.warnings,
      error: launch.error ?? 'launch failed',
    };
  }
  // Auto-open the runner's native web UI in the user's default browser.
  // Single click from the file menu → model running + chat surface
  // ready, without any in-app dialog (intentionally removed).
  if (typeof launch.pid === 'number') {
    openChatForPid(launch.pid).catch(() => {
      // best-effort: if shell.openExternal fails, the user can still
      // click the row's "Open in browser" button in RunningModelsPanel
    });
  }
  return {
    ok: true,
    url: launch.url,
    pid: launch.pid,
    params: tune.params,
    runner,
    warnings: launch.warnings,
  };
}
