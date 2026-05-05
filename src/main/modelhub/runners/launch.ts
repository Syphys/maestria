/**
 * Spawn + track active runner processes.
 *
 * Tracks two kinds of entries:
 *
 *  1. **Managed**: a child process we spawned (e.g. `llama-server`).
 *     Killed via SIGTERM on Stop. Killed unconditionally on app quit so
 *     we don't leave orphans.
 *
 *  2. **External**: a model registered with a daemon we don't own — the
 *     usual case for Ollama, where the installer's background service
 *     already listens on 11434. We didn't spawn anything, but the user
 *     still wants a "this is running, here's the URL, here's a Stop"
 *     entry in the UI. Stop on these is a soft remove (we don't kill
 *     the daemon — that would be hostile).
 *
 * Output is captured into a small ring buffer so the UI can show the
 * last few lines without unbounded memory growth on long-running servers.
 */

import { spawn, ChildProcess } from 'child_process';
import { LaunchResult, RunnerKind } from '../../../renderer/modelhub/types';

const RING_LIMIT = 200;

export interface ActiveEntry {
  /** Real OS pid for managed entries; synthetic id (negative int) for external. */
  pid: number;
  /** True when the entry was spawned by us (vs registered against an external daemon). */
  managed: boolean;
  command: string[];
  url?: string;
  /** Runner kind, if known — drives the smart "Open chat" routing. */
  runnerKind?: RunnerKind;
  /** Human-readable runner label (e.g. "Ollama", "llama.cpp (llama-server)"). */
  runnerLabel?: string;
  /**
   * Model identifier inside the runner — for Ollama this is the registered
   * `tagspaces-...` name; for others it's the basename of the model file.
   */
  modelName?: string;
  startedAt: string;
  log: string[];
  child?: ChildProcess;
}

const active = new Map<number, ActiveEntry>();

/** Synthetic ids start far below the OS pid range so collisions are impossible. */
let nextSyntheticId = -1;

function appendLog(p: ActiveEntry, chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    p.log.push(line);
    if (p.log.length > RING_LIMIT) p.log.shift();
  }
}

export interface LaunchOptions {
  url?: string;
  runnerKind?: RunnerKind;
  runnerLabel?: string;
  modelName?: string;
}

export function launchProcess(
  command: string[],
  options: LaunchOptions = {},
): LaunchResult {
  if (command.length < 1) {
    return { ok: false, error: 'empty command' };
  }
  const [bin, ...args] = command;
  try {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
    if (!child.pid) {
      return { ok: false, error: 'spawn returned no pid', command };
    }
    const entry: ActiveEntry = {
      pid: child.pid,
      managed: true,
      command,
      url: options.url,
      runnerKind: options.runnerKind,
      runnerLabel: options.runnerLabel,
      modelName: options.modelName,
      startedAt: new Date().toISOString(),
      log: [],
      child,
    };
    active.set(child.pid, entry);

    child.stdout?.on('data', (d) => appendLog(entry, d));
    child.stderr?.on('data', (d) => appendLog(entry, d));
    child.on('exit', () => {
      active.delete(entry.pid);
    });
    child.on('error', (err) => {
      appendLog(entry, `[spawn error] ${err.message}`);
      active.delete(entry.pid);
    });

    return { ok: true, pid: child.pid, url: options.url, command };
  } catch (e) {
    return { ok: false, error: (e as Error).message, command };
  }
}

/**
 * Add an entry for a model running under an external daemon (e.g. an
 * Ollama install whose service was already up). We don't spawn anything;
 * we just expose it in the UI so the user has a visible Stop / Open
 * action.
 */
export function registerExternalModel(opts: {
  command: string[];
  url?: string;
  runnerKind?: RunnerKind;
  runnerLabel?: string;
  modelName?: string;
}): ActiveEntry {
  const id = nextSyntheticId;
  nextSyntheticId -= 1;
  // Idempotency: if the same kind+url+model is already registered, return
  // the existing entry instead of stacking duplicates on each Run click.
  for (const ex of active.values()) {
    if (
      !ex.managed &&
      ex.runnerKind === opts.runnerKind &&
      ex.url === opts.url &&
      ex.modelName === opts.modelName
    ) {
      return ex;
    }
  }
  const entry: ActiveEntry = {
    pid: id,
    managed: false,
    command: opts.command,
    url: opts.url,
    runnerKind: opts.runnerKind,
    runnerLabel: opts.runnerLabel,
    modelName: opts.modelName,
    startedAt: new Date().toISOString(),
    log: [],
  };
  active.set(id, entry);
  return entry;
}

export function getActiveEntry(pid: number): ActiveEntry | undefined {
  return active.get(pid);
}

export function stopProcess(pid: number): { ok: boolean; error?: string } {
  const p = active.get(pid);
  if (!p) return { ok: false, error: 'unknown pid' };
  if (!p.managed) {
    // Synthetic — no process to kill, just drop the entry. The user can
    // still `ollama rm` manually if they want to fully unregister.
    active.delete(pid);
    return { ok: true };
  }
  try {
    p.child?.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    setTimeout(() => {
      if (active.has(pid)) {
        try {
          p.child?.kill('SIGKILL');
        } catch {
          /* swallow */
        }
      }
    }, 3000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface RunningSummary {
  pid: number;
  managed: boolean;
  command: string[];
  url?: string;
  runnerKind?: RunnerKind;
  runnerLabel?: string;
  modelName?: string;
  startedAt: string;
  recentLog: string[];
}

export function listRunning(): RunningSummary[] {
  return Array.from(active.values()).map((p) => ({
    pid: p.pid,
    managed: p.managed,
    command: p.command,
    url: p.url,
    runnerKind: p.runnerKind,
    runnerLabel: p.runnerLabel,
    modelName: p.modelName,
    startedAt: p.startedAt,
    recentLog: p.log.slice(-20),
  }));
}

/** Called from app `before-quit` to avoid orphan processes. */
export function killAll(): void {
  for (const p of active.values()) {
    if (!p.managed) continue;
    try {
      p.child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  active.clear();
}
