/**
 * Spawn + track active llama.cpp child processes.
 *
 * Every entry corresponds to a process **we spawned** — there is no
 * external-daemon tracking any more (that was the Ollama path, which is
 * gone). Killed via SIGTERM on Stop, unconditionally on app quit so we
 * don't leave orphans.
 *
 * Output is captured into a small ring buffer so the UI can show the
 * last few lines without unbounded memory growth on long-running servers.
 */

import { spawn, ChildProcess } from 'child_process';
import { LaunchResult, RunParams } from '../../../renderer/modelhub/types';

const RING_LIMIT = 200;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
}

export interface ActiveEntry {
  pid: number;
  command: string[];
  url?: string;
  /** Human-readable runner label (e.g. "llama-server (llama-server.exe)"). */
  runnerLabel?: string;
  /** Basename of the model file we launched. */
  modelName?: string;
  /**
   * Canonical absolute path of the model file we launched. Surfaced to
   * the renderer so the editor can count its own running instances by
   * exact path match, and so the Launch logs panel can navigate back
   * to the file's properties tab on click.
   */
  filePath?: string;
  /**
   * Origin tag — undefined when the user clicked Run in the app,
   * "via MCP — deer-flow" / "via MCP — session …" when an MCP client
   * invoked `models.run`. Drives the provenance grouping in
   * `RunningModelsPanel`.
   */
  launchedBy?: string;
  /**
   * Effective launch params (autotune + sidecar override + caller
   * override, after port collision-resolution). Stored so MCP callers
   * can introspect *with what* each running server was spawned via
   * `models.list_running`. Undefined only for synthetic spawn-failure
   * entries where we never reached the autotune step.
   */
  params?: RunParams;
  startedAt: string;
  log: string[];
  /**
   * Undefined while the process is alive; populated when the child
   * emits `exit`. We deliberately keep the entry around with this
   * field set instead of deleting it, so the user can still see why
   * a crashed runner died (log buffer + exit code) via the UI.
   */
  exited?: ExitInfo;
  /** Cleared when the process exits — keeps the `entry.exited` shape clean. */
  child?: ChildProcess;
}

const active = new Map<number, ActiveEntry>();

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
  runnerLabel?: string;
  modelName?: string;
  /** Canonical absolute path of the launched model. See ActiveEntry.filePath. */
  filePath?: string;
  /** See `ActiveEntry.launchedBy`. */
  launchedBy?: string;
  /** Effective launch params — stored on the entry for introspection. */
  params?: RunParams;
}

/**
 * Synthetic id counter for entries that never got a real OS pid
 * (spawn threw, spawn returned no pid). Negative + monotonically
 * decreasing so it can't collide with a real pid.
 */
let nextSyntheticId = -1;

function recordSpawnFailure(
  command: string[],
  options: LaunchOptions,
  reason: string,
): { id: number; entry: ActiveEntry } {
  const id = nextSyntheticId;
  nextSyntheticId -= 1;
  const entry: ActiveEntry = {
    pid: id,
    command,
    url: options.url,
    runnerLabel: options.runnerLabel,
    modelName: options.modelName,
    filePath: options.filePath,
    launchedBy: options.launchedBy,
    params: options.params,
    startedAt: new Date().toISOString(),
    log: [`[spawn failed] ${reason}`],
    exited: {
      code: null,
      signal: null,
      exitedAt: new Date().toISOString(),
    },
    child: undefined,
  };
  active.set(id, entry);
  return { id, entry };
}

export function launchProcess(
  command: string[],
  options: LaunchOptions = {},
): LaunchResult {
  if (command.length < 1) {
    const { id } = recordSpawnFailure(command, options, 'empty command');
    return { ok: false, error: 'empty command', pid: id };
  }
  const [bin, ...args] = command;
  try {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
    if (!child.pid) {
      const { id } = recordSpawnFailure(
        command,
        options,
        'spawn returned no pid',
      );
      return { ok: false, error: 'spawn returned no pid', pid: id, command };
    }
    const entry: ActiveEntry = {
      pid: child.pid,
      command,
      url: options.url,
      runnerLabel: options.runnerLabel,
      modelName: options.modelName,
      filePath: options.filePath,
      launchedBy: options.launchedBy,
      params: options.params,
      startedAt: new Date().toISOString(),
      log: [],
      child,
    };
    active.set(child.pid, entry);

    child.stdout?.on('data', (d) => appendLog(entry, d));
    child.stderr?.on('data', (d) => appendLog(entry, d));
    child.on('exit', (code, signal) => {
      // Don't drop the entry — keep it around so the user can read the
      // captured log + exit code. `stopProcess` / dismissProcess remove
      // it explicitly.
      entry.exited = {
        code: code ?? null,
        signal: signal ?? null,
        exitedAt: new Date().toISOString(),
      };
      entry.child = undefined;
    });
    child.on('error', (err) => {
      appendLog(entry, `[spawn error] ${err.message}`);
      entry.exited = {
        code: null,
        signal: null,
        exitedAt: new Date().toISOString(),
      };
      entry.child = undefined;
    });

    return { ok: true, pid: child.pid, url: options.url, command };
  } catch (e) {
    const reason = (e as Error).message;
    const { id } = recordSpawnFailure(command, options, reason);
    return { ok: false, error: reason, pid: id, command };
  }
}

export function getActiveEntry(pid: number): ActiveEntry | undefined {
  return active.get(pid);
}

/**
 * Pick a port that no currently-running entry occupies, starting from
 * `requested` and scanning upward. Two consecutive launches that both
 * autotune to 8080 used to collide silently — only the first server
 * actually bound, the second exited with EADDRINUSE, and the panel
 * showed two rows with identical URLs because we never rewrote the port.
 *
 * Only live (non-exited) entries count — a crashed runner whose ring
 * buffer is still around isn't holding the port.
 *
 * Bounded scan to avoid an infinite loop if every port in the range is
 * taken; falls through to `requested + range` which will most likely
 * fail to bind, which is a strictly better failure mode than colliding.
 */
export function pickFreePort(requested = 8080, range = 1000): number {
  const used = new Set<number>();
  for (const e of active.values()) {
    if (e.exited || !e.url) continue;
    const m = e.url.match(/:(\d+)/);
    if (m) used.add(Number(m[1]));
  }
  let p = requested;
  while (used.has(p) && p < requested + range) p += 1;
  return p;
}

export function stopProcess(pid: number): { ok: boolean; error?: string } {
  const p = active.get(pid);
  if (!p) return { ok: false, error: 'unknown pid' };
  // Drop the entry from `active` immediately so RunningModelsPanel sees
  // it disappear instead of flashing a red "exited" row when the user
  // clicks Stop. The on('exit') handler still runs (it's bound to the
  // closed-over entry object) and sets entry.exited, but that object
  // is no longer in the map so listRunning() can't surface it. Real
  // crashes — where the user did NOT click Stop — still land in the
  // panel as expected because they reach the on('exit') handler with
  // the entry still in the map.
  const child = p.child;
  active.delete(pid);
  if (!child) return { ok: true };
  try {
    child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* swallow — already dead */
      }
    }, 3000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Read the captured stdout/stderr ring buffer of an entry. */
export function getEntryLog(pid: number): string[] | undefined {
  const p = active.get(pid);
  return p ? [...p.log] : undefined;
}

/** Drop a dead entry from the registry. No-op on live entries. */
export function dismissProcess(pid: number): { ok: boolean; error?: string } {
  const p = active.get(pid);
  if (!p) return { ok: false, error: 'unknown pid' };
  if (!p.exited && p.child) {
    return {
      ok: false,
      error: 'process is still running — stop it first',
    };
  }
  active.delete(pid);
  return { ok: true };
}

export interface RunningSummary {
  pid: number;
  command: string[];
  url?: string;
  runnerLabel?: string;
  modelName?: string;
  /** Canonical absolute model path — surfaces to the renderer. */
  filePath?: string;
  launchedBy?: string;
  /** Effective launch params for this server, when known. */
  params?: RunParams;
  startedAt: string;
  /** Set when the process has terminated; absent while running. */
  exited?: ExitInfo;
  recentLog: string[];
}

export function listRunning(): RunningSummary[] {
  return Array.from(active.values()).map((p) => ({
    pid: p.pid,
    command: p.command,
    url: p.url,
    runnerLabel: p.runnerLabel,
    modelName: p.modelName,
    filePath: p.filePath,
    launchedBy: p.launchedBy,
    params: p.params,
    startedAt: p.startedAt,
    exited: p.exited,
    recentLog: p.log.slice(-20),
  }));
}

/** Called from app `before-quit` to avoid orphan processes. */
export function killAll(): void {
  for (const p of active.values()) {
    if (!p.child) continue;
    try {
      p.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  active.clear();
}
