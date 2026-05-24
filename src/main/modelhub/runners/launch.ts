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

import { spawn, ChildProcess, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { LaunchResult, RunParams } from '../../../renderer/modelhub/types';
import { appendServerLog } from '../modelLogStore';

const RING_LIMIT = 200;

/**
 * Window during which an `exit` event counts as a "boot crash" (= the
 * binary refused a flag, OOM at model load, missing CUDA lib, etc.).
 * Below this threshold, the renderer auto-opens the log dialog so the
 * user sees the diagnostic without having to click "view log" manually.
 */
const CRASH_AT_BOOT_WINDOW_MS = 5000;

export interface LaunchEvent {
  pid: number;
}
export interface LogChunkEvent extends LaunchEvent {
  /** Pre-split lines (already stripped of CR/LF). May be empty. */
  lines: string[];
}
export interface ExitEvent extends LaunchEvent {
  exited: ExitInfo;
  /** True when the process exited within CRASH_AT_BOOT_WINDOW_MS. */
  crashedEarly: boolean;
}

/**
 * Push channel used by the IPC layer to mirror per-process events to the
 * renderer (no need to poll the log buffer). Two events:
 *   - `'logChunk'` (LogChunkEvent) — fired whenever stdout/stderr produced
 *     at least one non-empty line.
 *   - `'exit'` (ExitEvent) — fired when the child exits, with a flag
 *     indicating whether it died inside the boot-crash window.
 *
 * Subscribers MUST be attached at app init (before any launch happens),
 * otherwise early events are lost — there is no replay buffer.
 */
export const launchEvents = new EventEmitter();
// Heuristic safety: every renderer window adds 2 listeners (logChunk +
// exit). Bumping the cap so dev with 4-5 windows doesn't trip Node's
// MaxListenersExceededWarning.
launchEvents.setMaxListeners(50);

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
   * True when the process was spawned with OS-level privilege
   * elevation (Windows `Start-Process -Verb RunAs`, POSIX `pkexec`).
   * The child handle is unavailable in that mode (the elevation
   * shim returns only the pid), so stdio capture is disabled and
   * `stopProcess` falls back to OS-level kill (`taskkill /F /PID`
   * on Windows, `kill <pid>` on POSIX).
   */
  elevated?: boolean;
  /**
   * Undefined while the process is alive; populated when the child
   * emits `exit`. We deliberately keep the entry around with this
   * field set instead of deleting it, so the user can still see why
   * a crashed runner died (log buffer + exit code) via the UI.
   */
  exited?: ExitInfo;
  /**
   * Cleared when the process exits — keeps the `entry.exited` shape
   * clean. Always undefined for elevated launches (we don't get a
   * `ChildProcess` handle back from the elevation shim).
   */
  child?: ChildProcess;
}

const active = new Map<number, ActiveEntry>();

function appendLog(p: ActiveEntry, chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    p.log.push(line);
    if (p.log.length > RING_LIMIT) p.log.shift();
    lines.push(line);
  }
  if (lines.length > 0) {
    launchEvents.emit('logChunk', { pid: p.pid, lines } as LogChunkEvent);
    // Mirror the chunk to the per-model `.log` file so the user can
    // open a finished model later and still see what llama-server
    // printed during its session (boot, eval, exit). Fire-and-forget:
    // a disk error here must NEVER sink the launch path.
    if (p.filePath) {
      void appendServerLog(p.filePath, `${lines.join('\n')}\n`);
    }
  }
}

/** ms elapsed since `entry.startedAt`. Used by the exit handler to set
 * the `crashedEarly` flag without re-parsing dates downstream. */
function msSinceStart(entry: ActiveEntry): number {
  const startedMs = Date.parse(entry.startedAt);
  return Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity;
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
  /** Marks the entry as launched with elevation. See ActiveEntry.elevated. */
  elevated?: boolean;
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
      const exited: ExitInfo = {
        code: code ?? null,
        signal: signal ?? null,
        exitedAt: new Date().toISOString(),
      };
      entry.exited = exited;
      entry.child = undefined;
      const crashedEarly = msSinceStart(entry) < CRASH_AT_BOOT_WINDOW_MS;
      launchEvents.emit('exit', {
        pid: entry.pid,
        exited,
        crashedEarly,
      } as ExitEvent);
    });
    child.on('error', (err) => {
      appendLog(entry, `[spawn error] ${err.message}`);
      const exited: ExitInfo = {
        code: null,
        signal: null,
        exitedAt: new Date().toISOString(),
      };
      entry.exited = exited;
      entry.child = undefined;
      // Spawn errors always count as boot crashes — the binary never
      // even started, so the user wants the dialog open immediately.
      launchEvents.emit('exit', {
        pid: entry.pid,
        exited,
        crashedEarly: true,
      } as ExitEvent);
    });

    return { ok: true, pid: child.pid, url: options.url, command };
  } catch (e) {
    const reason = (e as Error).message;
    const { id } = recordSpawnFailure(command, options, reason);
    return { ok: false, error: reason, pid: id, command };
  }
}

/**
 * Spawn a child with OS-level privilege elevation. Used by the
 * `models.run` MCP tool when `admin: true` is requested (caller must
 * also hold the admin Bearer token; the gating happens in the tool
 * handler, not here).
 *
 * Trade-offs vs `launchProcess`:
 *  - We do NOT get a `ChildProcess` handle back — only the pid. The
 *    elevated process runs under a separate UAC context (Windows) /
 *    polkit session (POSIX), so stdio is not piped to us. The ring
 *    buffer stays empty, `runners.get_log` returns nothing. The user
 *    can still tail `.ts/<base>.log` if llama-server is launched with
 *    `--log-file`.
 *  - We can't detect exit via `child.on('exit')`. The entry stays
 *    `running` until `stopProcess` is called or `pollElevatedExits`
 *    discovers the pid is gone (best-effort, every 10 s — see below).
 *  - Cancellation (UAC denied, polkit prompt cancelled) returns an
 *    `ok: false` LaunchResult with the OS reason.
 *
 * Platform support:
 *  - Windows: `powershell -NoProfile -Command Start-Process -Verb
 *    RunAs -PassThru -FilePath <bin> -ArgumentList <args>` — UAC
 *    prompt appears. The PowerShell call returns the elevated
 *    `Process.Id`, which we parse out of stdout.
 *  - POSIX: requires `pkexec` on PATH. We don't fall back to `sudo`
 *    because sudo prompts in the terminal, which Electron's main
 *    process has none of.
 */
export function launchProcessElevated(
  command: string[],
  options: LaunchOptions = {},
): LaunchResult {
  if (command.length < 1) {
    const { id } = recordSpawnFailure(command, options, 'empty command');
    return { ok: false, error: 'empty command', pid: id };
  }
  const [bin, ...args] = command;

  let pid: number | undefined;
  let elevationError: string | undefined;

  if (process.platform === 'win32') {
    // PowerShell sends '"' through argument quoting; we encode each
    // arg as a single-quoted PS string and escape inner single quotes
    // by doubling them.
    const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const argList =
      args.length > 0 ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
    const psScript =
      `$ErrorActionPreference='Stop';` +
      `$p = Start-Process -FilePath ${psQuote(bin)}` +
      argList +
      ` -Verb RunAs -PassThru -WindowStyle Hidden;` +
      `Write-Output $p.Id`;
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { encoding: 'utf8', windowsHide: true },
    );
    if (r.status !== 0) {
      elevationError =
        (r.stderr || r.stdout || '').trim() ||
        `powershell exited with code ${r.status ?? 'unknown'}`;
    } else {
      const match = /^\s*(\d+)\s*$/m.exec(r.stdout);
      if (match) pid = parseInt(match[1], 10);
      else elevationError = `could not parse pid from: ${r.stdout.trim()}`;
    }
  } else {
    // POSIX path — pkexec only. `sudo` is ruled out because it needs
    // a TTY for the password prompt.
    const pkexecCheck = spawnSync('which', ['pkexec'], { encoding: 'utf8' });
    if (pkexecCheck.status !== 0) {
      elevationError =
        'admin elevation requires pkexec on POSIX (sudo is not supported — no TTY)';
    } else {
      try {
        const child = spawn('pkexec', [bin, ...args], {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });
        if (child.pid) {
          pid = child.pid;
          child.unref();
        } else {
          elevationError = 'pkexec returned no pid';
        }
      } catch (e) {
        elevationError = (e as Error).message;
      }
    }
  }

  if (!pid) {
    const { id } = recordSpawnFailure(
      command,
      { ...options, elevated: true },
      elevationError ?? 'elevation failed',
    );
    return {
      ok: false,
      error: elevationError ?? 'elevation failed',
      pid: id,
      command,
    };
  }

  const entry: ActiveEntry = {
    pid,
    command,
    url: options.url,
    runnerLabel: options.runnerLabel,
    modelName: options.modelName,
    filePath: options.filePath,
    launchedBy: options.launchedBy,
    params: options.params,
    elevated: true,
    startedAt: new Date().toISOString(),
    log: [
      '[elevated] stdout/stderr unavailable — process runs under a',
      '[elevated] separate privilege context. Add --log-file to the',
      '[elevated] runner customArgs to capture llama-server output.',
    ],
    child: undefined,
  };
  active.set(pid, entry);

  return { ok: true, pid, url: options.url, command };
}

/**
 * Best-effort sweep that detects exits of elevated processes (which
 * have no `child.on('exit')` handler since we never got a handle).
 * Called every 10 s by `startElevatedExitPoller`. Marks `exited` and
 * emits the `'exit'` event so the UI converges to the same shape it
 * gets for non-elevated processes.
 */
function pollElevatedExits(): void {
  for (const entry of active.values()) {
    if (!entry.elevated || entry.exited) continue;
    let alive = true;
    try {
      // `process.kill(pid, 0)` throws ESRCH when the pid is gone, EPERM
      // when it exists but we can't signal it (elevated child — that
      // counts as alive for our purposes).
      process.kill(entry.pid, 0);
    } catch (e: any) {
      if (e?.code === 'ESRCH') alive = false;
    }
    if (alive) continue;
    const exited: ExitInfo = {
      code: null,
      signal: null,
      exitedAt: new Date().toISOString(),
    };
    entry.exited = exited;
    const crashedEarly = msSinceStart(entry) < CRASH_AT_BOOT_WINDOW_MS;
    launchEvents.emit('exit', {
      pid: entry.pid,
      exited,
      crashedEarly,
    } as ExitEvent);
  }
}

let elevatedExitTimer: NodeJS.Timeout | undefined;
/**
 * Idempotent — call once at app startup. The poller is cheap (no
 * `active.values()` work most of the time; the inner kill check is a
 * single syscall per elevated entry).
 */
export function startElevatedExitPoller(intervalMs = 10_000): void {
  if (elevatedExitTimer) return;
  elevatedExitTimer = setInterval(pollElevatedExits, intervalMs);
  if (typeof elevatedExitTimer.unref === 'function') {
    elevatedExitTimer.unref();
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
  const wasElevated = p.elevated === true;
  active.delete(pid);

  // Elevated path — no ChildProcess handle. Use OS-level kill. On
  // Windows we need `taskkill /F` since `process.kill(pid)` can't
  // signal a process running in a higher integrity level.
  if (wasElevated && !child) {
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/F', '/PID', String(pid), '/T'], {
          windowsHide: true,
        });
        if (r.status !== 0) {
          // Re-add the entry — kill didn't take.
          active.set(pid, p);
          return {
            ok: false,
            error: `taskkill failed (status ${r.status})`,
          };
        }
        return { ok: true };
      }
      // POSIX: signal the elevated child directly. On most distros
      // pkexec preserves the pid we captured, so a regular SIGTERM
      // is enough. If permission is denied (EPERM), surface it —
      // there is no clean recovery from "we elevated something we
      // can't kill" without prompting the user again.
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* swallow */
        }
      }, 3000);
      return { ok: true };
    } catch (e) {
      active.set(pid, p);
      return { ok: false, error: (e as Error).message };
    }
  }

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
