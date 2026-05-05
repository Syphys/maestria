/**
 * "Open chat" router for an active runner entry.
 *
 *   - Ollama: spawn a new terminal window with `ollama run <model>`.
 *     We DO NOT fall back to opening the URL in a browser — Ollama's
 *     root path (`http://127.0.0.1:11434/`) just returns a plain-text
 *     "Ollama is running", not a chat surface. Falling back to that was
 *     actively misleading. If the terminal spawn fails for some reason
 *     (no console available, AV blocking…), we copy the command to the
 *     clipboard via the renderer instead — guaranteed to work, the user
 *     pastes it where they want.
 *
 *   - Runners with a built-in web UI (llama-server, koboldcpp,
 *     lm-studio): open the URL in the default browser. Their `/`
 *     endpoint actually serves something useful (a chat page).
 *
 *   - Anything else with a URL: open URL.
 */

import { shell, clipboard } from 'electron';
import { exec } from 'child_process';
import { ActiveEntry } from './launch';

export interface OpenChatResult {
  ok: boolean;
  /** Drives the renderer's notification text. */
  action?: 'browser' | 'terminal' | 'clipboard' | 'noop';
  /** When `action === 'clipboard'`, the command we copied. */
  copiedCommand?: string;
  error?: string;
}

/**
 * Quote a value for inclusion in a Windows `cmd.exe` command line. cmd
 * uses double-quotes; embedded `"` is escaped as `""`. We don't have to
 * worry about backslashes — Windows file paths are fine inside quotes.
 */
function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Quote a value for a POSIX shell. Single-quotes; embedded `'` becomes
 * `'\\''` (close, escaped quote, reopen).
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface TerminalAttempt {
  ok: boolean;
}

function spawnTerminal(executable: string, args: string[]): TerminalAttempt {
  if (process.platform === 'win32') {
    // `start "" cmd /K "<exe>" <args>` opens a new visible cmd window
    // that stays open after the command exits — the user can read errors
    // and re-run as needed. Using `exec` (rather than `spawn` with array
    // args) sidesteps Node's argument-quoting heuristics, which proved
    // unreliable: with `start` the rest of the line is parsed by cmd
    // itself, not by Node, so we want a single string.
    const cmdLine =
      `start "" cmd /K ${cmdQuote(executable)} ` + args.map(cmdQuote).join(' ');
    try {
      const child = exec(cmdLine, { windowsHide: false });
      child.unref();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  if (process.platform === 'darwin') {
    const cmdLine = [executable, ...args].map(shQuote).join(' ');
    const apple = `tell application "Terminal" to do script "${cmdLine.replace(/"/g, '\\"')}"`;
    try {
      const child = exec(`osascript -e ${shQuote(apple)}`);
      child.unref();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  // Linux: try common emulators in order.
  const candidates = [
    'x-terminal-emulator',
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'xterm',
  ];
  const inner = [executable, ...args].map(shQuote).join(' ');
  for (const term of candidates) {
    try {
      // -e usually accepts a single command string. Some emulators want
      // `-e bash -c "..."`; fallback to that pattern if we ever care.
      const child = exec(`${term} -e ${shQuote(inner)}`);
      child.unref();
      return { ok: true };
    } catch {
      /* try next */
    }
  }
  return { ok: false };
}

export async function openChatFor(entry: ActiveEntry): Promise<OpenChatResult> {
  // Ollama: terminal-only path. URL would be useless.
  if (entry.runnerKind === 'ollama' && entry.modelName) {
    const exe = entry.command[0];
    if (!exe) {
      return { ok: false, error: 'no executable in command' };
    }
    const attempt = spawnTerminal(exe, ['run', entry.modelName]);
    if (attempt.ok) {
      return { ok: true, action: 'terminal' };
    }
    // Couldn't open a terminal — copy the command to clipboard so the
    // user can paste it into whatever shell they prefer. Reliable
    // fallback that always works.
    const cmdString =
      process.platform === 'win32'
        ? `${cmdQuote(exe)} run ${cmdQuote(entry.modelName)}`
        : [exe, 'run', entry.modelName].map(shQuote).join(' ');
    try {
      clipboard.writeText(cmdString);
      return {
        ok: true,
        action: 'clipboard',
        copiedCommand: cmdString,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // Other runners: their root URL is a real web UI. Open externally.
  if (entry.url) {
    try {
      await shell.openExternal(entry.url);
      return { ok: true, action: 'browser' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  return {
    ok: false,
    action: 'noop',
    error: 'no URL or terminal action available for this runner',
  };
}
