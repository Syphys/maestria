/**
 * Per-model log + error files stored alongside the sidecar.
 *
 * Two append-only text files live next to the sidecar JSON:
 *   - `<.ts>/<basename>.log`   — llama-server stdout/stderr captured while
 *                                Maestria launched the model for a
 *                                characterization or embedder session.
 *                                Useful for debugging boot crashes
 *                                ("unknown architecture", OOM, …).
 *   - `<.ts>/<basename>.error` — per-model error journal from the bulk
 *                                characterizer. Each entry is a single
 *                                ISO-timestamped line with the reason.
 *
 * Prompts / responses are NOT duplicated here — those already land in
 * the signature's `diagnostic.entries` and are the only display source
 * for the « Interactions » tab.
 *
 * Read-only locations: every write checks `skipWrite` first and silently
 * no-ops. Reads still work (returning `''` if the file doesn't exist),
 * so the panel never breaks on a read-only model folder.
 *
 * All writes are best-effort append: on EACCES / ENOSPC / EROFS we log
 * to `console.warn` and swallow. The characterization itself must never
 * fail because of a log-side write — that would be a regression vs the
 * pre-logging behaviour.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { sidecarPathFor } from './sidecar';

/** `.log` path derived from the model's `.json` sidecar path. */
export function serverLogPathFor(filePath: string): string {
  const sidecar = sidecarPathFor(filePath);
  return sidecar.replace(/\.json$/i, '.log');
}

/** `.error` path derived from the model's `.json` sidecar path. */
export function errorLogPathFor(filePath: string): string {
  const sidecar = sidecarPathFor(filePath);
  return sidecar.replace(/\.json$/i, '.error');
}

/** Hard cap on file size before we rotate (keep the tail). 4 MiB. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** When rotating, keep the last KEEP_TAIL_BYTES of the file. 2 MiB. */
const KEEP_TAIL_BYTES = 2 * 1024 * 1024;

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Trim the file to its last KEEP_TAIL_BYTES if it grew past MAX_LOG_BYTES.
 * Cheap to call before every append: when the size is well under the
 * cap, `stat` + the size check returns immediately.
 */
async function rotateIfTooLarge(file: string): Promise<void> {
  try {
    const s = await fs.stat(file);
    if (s.size <= MAX_LOG_BYTES) return;
    // The cap (4 MiB) is small enough that reading the whole file and
    // slicing in memory is simpler and safer than positional reads —
    // those trip TS's recent Buffer / ArrayBufferView strict signatures
    // and add no real benefit at this size.
    const whole = await fs.readFile(file, 'utf8');
    const tail = whole.slice(-KEEP_TAIL_BYTES);
    await fs.writeFile(
      file,
      `…[rotated, kept last ${KEEP_TAIL_BYTES} bytes]\n${tail}`,
    );
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return; // brand-new file, nothing to rotate
    // eslint-disable-next-line no-console
    console.warn(`[modelLogStore] rotate failed for ${file}: ${err?.message}`);
  }
}

/**
 * Append a chunk of llama-server stdout/stderr to the model's `.log`.
 * `chunk` is appended verbatim — the caller may have already added a
 * trailing `\n`. Best-effort: swallowed on permission/disk errors.
 */
export async function appendServerLog(
  filePath: string,
  chunk: string,
  options: { skipWrite?: boolean } = {},
): Promise<void> {
  if (options.skipWrite) return;
  if (!chunk) return;
  const log = serverLogPathFor(filePath);
  try {
    await ensureDir(log);
    await rotateIfTooLarge(log);
    await fs.appendFile(log, chunk, 'utf8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[modelLogStore] appendServerLog failed for ${log}: ${(e as Error).message}`,
    );
  }
}

/**
 * Append an ISO-timestamped error line to the model's `.error` file.
 * `reason` is a single human-readable string (e.g. the thrown Error
 * message). A newline is appended automatically.
 */
export async function appendErrorLog(
  filePath: string,
  reason: string,
  options: { skipWrite?: boolean } = {},
): Promise<void> {
  if (options.skipWrite) return;
  if (!reason) return;
  const log = errorLogPathFor(filePath);
  const line = `[${new Date().toISOString()}] ${reason}\n`;
  try {
    await ensureDir(log);
    await rotateIfTooLarge(log);
    await fs.appendFile(log, line, 'utf8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[modelLogStore] appendErrorLog failed for ${log}: ${(e as Error).message}`,
    );
  }
}

/** Read the full server log; returns `''` if the file is absent. */
export async function readServerLog(filePath: string): Promise<string> {
  try {
    return await fs.readFile(serverLogPathFor(filePath), 'utf8');
  } catch {
    return '';
  }
}

/** Read the full error log; returns `''` if the file is absent. */
export async function readErrorLog(filePath: string): Promise<string> {
  try {
    return await fs.readFile(errorLogPathFor(filePath), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Rotate the current `.log` into a per-session archive before a fresh
 * characterization run, so each run has its own readable file and the
 * previous run's diagnostic data is never lost. Renames the existing
 * `<base>.log` to `<base>.<ISO-stamp>.log` (timestamp is the file's
 * last-write time, filesystem-safe) when it exists and is non-empty.
 *
 * Why timestamped archive instead of wiping:
 *   - the user explicitly asked for per-session preservation
 *     (2026-05-24: « Garde le log pour chaque modèle dans un fichier
 *     propre »);
 *   - diagnostics from a buggy run survive a subsequent re-run that
 *     would otherwise truncate them;
 *   - the « Logs serveur » tab keeps reading `<base>.log` (the active
 *     session); archives sit alongside for after-the-fact inspection.
 *
 * Best-effort: silent on permission / FS errors. Bounded by
 * `pruneOldServerLogArchives` so the `.ts/` folder doesn't grow
 * without limit.
 */
export async function archiveServerLog(
  filePath: string,
  options: { skipWrite?: boolean; keepLastN?: number } = {},
): Promise<void> {
  if (options.skipWrite) return;
  const current = serverLogPathFor(filePath);
  try {
    const s = await fs.stat(current).catch(() => undefined);
    if (s && s.size > 0) {
      const stamp = stampFromMtime(s.mtimeMs);
      // Insert the stamp before the `.log` suffix:
      //   foo.gguf.log → foo.gguf.<stamp>.log
      const archive = current.replace(/\.log$/i, `.${stamp}.log`);
      await fs.rename(current, archive).catch(async (e: unknown) => {
        const err = e as NodeJS.ErrnoException;
        // Cross-device or weird FS: fall back to copy + truncate so the
        // archive still exists. Read as utf8 (log files are text) so the
        // round-trip dodges TS5's stricter Buffer / ArrayBufferView typing.
        if (err?.code === 'EXDEV') {
          const data = await fs.readFile(current, 'utf8');
          await fs.writeFile(archive, data);
          await fs.writeFile(current, '');
        } else {
          throw e;
        }
      });
    }
    await pruneOldServerLogArchives(filePath, options.keepLastN ?? 10);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return;
    // eslint-disable-next-line no-console
    console.warn(`[modelLogStore] archiveServerLog failed: ${err?.message}`);
  }
}

/**
 * Filesystem-safe ISO timestamp: `YYYYMMDDThhmmssZ`. Avoids `:` (not
 * allowed in Windows filenames) and the milliseconds + dashes that
 * the standard ISO form carries.
 */
function stampFromMtime(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Cap the number of `<base>.<stamp>.log` archives kept beside the
 * sidecar — anything older than the `keepLastN` most recent is
 * deleted. Bounded scan: typical models will have ≤ a few dozen.
 */
export async function pruneOldServerLogArchives(
  filePath: string,
  keepLastN: number,
): Promise<void> {
  if (keepLastN < 0) return;
  const current = serverLogPathFor(filePath);
  const dir = path.dirname(current);
  const base = path.basename(current).replace(/\.log$/i, '');
  // Match `<base>.<stamp>.log` only — never the active `<base>.log`.
  const stampRe = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{8}T\\d{6}Z\\.log$`,
    'i',
  );
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const matches: { name: string; mtime: number }[] = [];
  for (const n of names) {
    if (!stampRe.test(n)) continue;
    try {
      const s = await fs.stat(path.join(dir, n));
      matches.push({ name: n, mtime: s.mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  // Newest first; drop the head we keep, delete the tail.
  matches.sort((a, b) => b.mtime - a.mtime);
  for (const m of matches.slice(keepLastN)) {
    await fs.unlink(path.join(dir, m.name)).catch(() => undefined);
  }
}

/**
 * List the archived sessions for a model, newest first. Names are
 * relative to the sidecar `.ts/` folder. Returns an empty array when
 * no archives exist (or the folder is missing).
 */
export async function listServerLogArchives(
  filePath: string,
): Promise<{ name: string; mtimeMs: number; size: number }[]> {
  const current = serverLogPathFor(filePath);
  const dir = path.dirname(current);
  const base = path.basename(current).replace(/\.log$/i, '');
  const stampRe = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{8}T\\d{6}Z\\.log$`,
    'i',
  );
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { name: string; mtimeMs: number; size: number }[] = [];
  for (const n of names) {
    if (!stampRe.test(n)) continue;
    try {
      const s = await fs.stat(path.join(dir, n));
      out.push({ name: n, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
