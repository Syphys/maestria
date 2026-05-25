/**
 * Bearer tokens + auto-start flag for the MCP server.
 *
 * Two distinct tokens are persisted in `modelhub-mcp.json` under the
 * Electron user-data dir:
 *
 *  - `token` — the default ("user") Bearer. Created lazily on first
 *    use. Grants access to every tool EXCEPT those marked
 *    `requiresAdmin: true`.
 *  - `adminToken` — the admin Bearer. Generated on demand from
 *    Settings ▸ AI ▸ MCP Server (or via the IPC channel). NOT created
 *    automatically so a fresh install ships without admin access at all
 *    — the user has to deliberately opt in by clicking "Generate admin
 *    token". This token unlocks destructive / configuration-changing
 *    tools (`meta.clear_folder`, `runners.save/remove`,
 *    `hardware.set_override`, `routing.set_config`, the `admin: true`
 *    branch of `models.run`).
 *
 * Both are 32-char hex strings (`crypto.randomUUID()` without dashes,
 * ~122 bits of entropy). OS-level filesystem permissions are the only
 * gate — they are local-machine passwords, no cryptographic
 * properties beyond unpredictability.
 *
 * The same file holds the `autoStart` flag (default false). When true,
 * `registerModelhubEvents` starts the server at app boot.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const FILE_NAME = 'modelhub-mcp.json';

interface TokenFile {
  version: 1;
  token: string;
  /**
   * Optional admin token. Absence = no admin access at all (every
   * `requiresAdmin: true` tool returns 403). Generated on demand.
   */
  adminToken?: string;
  /** ISO timestamp the user token was created. */
  createdAt: string;
  /** ISO timestamp the admin token was created (when present). */
  adminCreatedAt?: string;
  /** Auto-start the MCP server at app boot. Default false. */
  autoStart?: boolean;
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function makeToken(): string {
  // randomUUID gives ~122 bits of entropy; strip the dashes so the token
  // is one shell-safe word (no quoting headaches when the user copies it
  // into a config file).
  return randomUUID().replace(/-/g, '');
}

async function readFile(): Promise<TokenFile | undefined> {
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as TokenFile;
    if (parsed.version !== 1 || !parsed.token) return undefined;
    return parsed;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    console.warn('[modelhub-mcp] token read failed:', e?.message ?? e);
    return undefined;
  }
}

async function writeFile(data: TokenFile): Promise<void> {
  const fp = getFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
  // Bearer tokens are local-machine passwords. Lock the file so other
  // users on the same machine can't read it via /home/$other_user share,
  // backup tools, or accidental world-readable inheritance. POSIX only —
  // chmod is a no-op on Windows (ACLs from the user-profile dir cover it).
  try {
    await fs.chmod(fp, 0o600);
  } catch {
    /* best-effort; Windows or read-only mount */
  }
}

export async function getOrCreateToken(): Promise<string> {
  const existing = await readFile();
  if (existing) return existing.token;
  const fresh: TokenFile = {
    version: 1,
    token: makeToken(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(fresh);
  return fresh.token;
}

export async function regenerateToken(): Promise<string> {
  const prev = await readFile();
  const fresh: TokenFile = {
    version: 1,
    token: makeToken(),
    createdAt: new Date().toISOString(),
    // Preserve admin state + autostart so regenerating user token
    // doesn't silently revoke admin access nor disable autostart.
    adminToken: prev?.adminToken,
    adminCreatedAt: prev?.adminCreatedAt,
    autoStart: prev?.autoStart,
  };
  await writeFile(fresh);
  return fresh.token;
}

/**
 * Read the persisted admin token, if any. Does NOT create one. Use
 * `getOrCreateAdminToken` when the caller explicitly wants admin
 * access to be enabled.
 */
export async function getAdminToken(): Promise<string | undefined> {
  const f = await readFile();
  return f?.adminToken;
}

/**
 * Lazily create the admin token if missing. Idempotent — repeated calls
 * return the same string. The user token must already exist (the
 * function reads it first and bails if there's nothing yet — a server
 * that hasn't been started can't have an admin token either).
 */
export async function getOrCreateAdminToken(): Promise<string> {
  const prev = await readFile();
  if (!prev) {
    // Edge case: nothing persisted yet (server never started). Create
    // the full file with both tokens so the next start picks them up.
    const fresh: TokenFile = {
      version: 1,
      token: makeToken(),
      createdAt: new Date().toISOString(),
      adminToken: makeToken(),
      adminCreatedAt: new Date().toISOString(),
    };
    await writeFile(fresh);
    return fresh.adminToken!;
  }
  if (prev.adminToken) return prev.adminToken;
  const adminToken = makeToken();
  await writeFile({
    ...prev,
    adminToken,
    adminCreatedAt: new Date().toISOString(),
  });
  return adminToken;
}

/**
 * Generate a fresh admin token, invalidating the previous one. After
 * this, any MCP session authenticated with the OLD admin token loses
 * privileged access on its next request (the verify check fails).
 */
export async function regenerateAdminToken(): Promise<string> {
  const prev = await readFile();
  if (!prev) {
    // Same edge case as above.
    return getOrCreateAdminToken();
  }
  const adminToken = makeToken();
  await writeFile({
    ...prev,
    adminToken,
    adminCreatedAt: new Date().toISOString(),
  });
  return adminToken;
}

/**
 * Revoke admin access entirely — drops the admin token from the file.
 * After this, every `requiresAdmin: true` tool returns 403 until the
 * user explicitly regenerates one. User token + autostart preserved.
 */
export async function revokeAdminToken(): Promise<void> {
  const prev = await readFile();
  if (!prev?.adminToken) return;
  const { adminToken: _drop, adminCreatedAt: _drop2, ...rest } = prev;
  await writeFile({ ...rest, version: 1, token: prev.token });
}

export async function getAutoStart(): Promise<boolean> {
  const f = await readFile();
  return !!f?.autoStart;
}

export async function setAutoStart(enabled: boolean): Promise<void> {
  const prev = await readFile();
  if (prev) {
    await writeFile({ ...prev, autoStart: enabled });
    return;
  }
  // No file yet → create one with a fresh token + the flag, so the
  // user doesn't lose their toggle state if they enable BEFORE first
  // start (e.g. they enable autostart in Settings, then quit before
  // ever opening the server).
  await writeFile({
    version: 1,
    token: makeToken(),
    createdAt: new Date().toISOString(),
    autoStart: enabled,
  });
}
