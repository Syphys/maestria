/**
 * Append-only JSONL log for MCP `tools/call` events.
 *
 * One line per call, written to `userData/modelhub-mcp.log`. Rotated
 * single-step (file → file.1) once it crosses 5 MB; older `.1` is
 * overwritten. No daily/timestamped rotation — simpler is fine for a
 * dev/debug aid. The line format is JSON so an external tool can `jq`
 * the file:
 *
 *   { "ts": "ISO", "caller": "via MCP — deer-flow/2.0",
 *     "tool": "models.run", "ok": true, "ms": 142,
 *     "args": { … }, "error"?: "…" }
 *
 * Errors during logging never propagate to the caller — a missing log
 * file is far less interesting than the tool result we just produced.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

const LOG_FILE_NAME = 'modelhub-mcp.log';
const ROTATE_AT_BYTES = 5 * 1024 * 1024;

export interface CallLogEntry {
  /** Caller label, "via MCP — <ua>" or "via MCP". */
  caller: string;
  /** Tool name, e.g. "models.run". */
  tool: string;
  /** Tool arguments. */
  args: unknown;
  /** Wall-clock ms spent in the handler. */
  durationMs: number;
  /** True on success, false on thrown error. */
  ok: boolean;
  /** Error message when `ok === false`. */
  error?: string;
}

function getLogPath(): string {
  return path.join(app.getPath('userData'), LOG_FILE_NAME);
}

async function rotateIfNeeded(fp: string): Promise<void> {
  try {
    const st = await fs.stat(fp);
    if (st.size < ROTATE_AT_BYTES) return;
    const rotated = `${fp}.1`;
    // Remove the previous rotation target if present, then rename.
    // `fs.rename` on Windows fails if the destination exists.
    await fs.rm(rotated, { force: true });
    await fs.rename(fp, rotated);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return;
    // Don't blow up the call path because of a rotation hiccup.
    console.warn(
      '[modelhub-mcp] log rotation failed:',
      e?.message ?? String(e),
    );
  }
}

export async function appendCallLog(entry: CallLogEntry): Promise<void> {
  const fp = getLogPath();
  try {
    await rotateIfNeeded(fp);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + '\n';
    await fs.appendFile(fp, line, 'utf8');
  } catch (e) {
    console.warn(
      '[modelhub-mcp] log append failed:',
      (e as Error).message ?? e,
    );
  }
}

export function getLogPathForDisplay(): string {
  return getLogPath();
}
