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
import { LaunchResult } from '../../../renderer/modelhub/types';

const RING_LIMIT = 200;

export interface ActiveEntry {
  pid: number;
  command: string[];
  url?: string;
  /** Human-readable runner label (e.g. "llama-server (llama-server.exe)"). */
  runnerLabel?: string;
  /** Basename of the model file we launched. */
  modelName?: string;
  startedAt: string;
  log: string[];
  child: ChildProcess;
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
      command,
      url: options.url,
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

export function getActiveEntry(pid: number): ActiveEntry | undefined {
  return active.get(pid);
}

export function stopProcess(pid: number): { ok: boolean; error?: string } {
  const p = active.get(pid);
  if (!p) return { ok: false, error: 'unknown pid' };
  try {
    p.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    setTimeout(() => {
      if (active.has(pid)) {
        try {
          p.child.kill('SIGKILL');
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
  command: string[];
  url?: string;
  runnerLabel?: string;
  modelName?: string;
  startedAt: string;
  recentLog: string[];
}

export function listRunning(): RunningSummary[] {
  return Array.from(active.values()).map((p) => ({
    pid: p.pid,
    command: p.command,
    url: p.url,
    runnerLabel: p.runnerLabel,
    modelName: p.modelName,
    startedAt: p.startedAt,
    recentLog: p.log.slice(-20),
  }));
}

/** Called from app `before-quit` to avoid orphan processes. */
export function killAll(): void {
  for (const p of active.values()) {
    try {
      p.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  active.clear();
}
