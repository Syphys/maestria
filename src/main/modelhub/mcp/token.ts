/**
 * Bearer token + auto-start flag for the MCP server.
 *
 * Token is generated lazily on first use (`crypto.randomUUID()` without
 * dashes for a 32-char hex string). Stored in the Electron user-data
 * dir as `modelhub-mcp.json`. OS-level filesystem permissions are the
 * only gate — the token is a local-machine password, no cryptographic
 * properties beyond unpredictability.
 *
 * The same file holds the `autoStart` flag (default false). When true,
 * `registerModelhubEvents` starts the server at app boot; the toggle
 * in Settings ▸ AI ▸ MCP Server writes it through here.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const FILE_NAME = 'modelhub-mcp.json';

interface TokenFile {
  version: 1;
  token: string;
  createdAt: string;
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
    autoStart: prev?.autoStart,
  };
  await writeFile(fresh);
  return fresh.token;
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
