/**
 * Bearer token persistence for the MCP server.
 *
 * Generated lazily on first use (`crypto.randomUUID()` without dashes for
 * a 32-char hex string). Stored in the Electron user-data dir as
 * `modelhub-mcp.json`. OS-level filesystem permissions are the only
 * gate — the token is a local-machine password, no cryptographic
 * properties beyond unpredictability.
 *
 * The Settings UI surfaces both copy + regenerate; regeneration
 * invalidates the previous token immediately (next request fails 401).
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
  const fresh: TokenFile = {
    version: 1,
    token: makeToken(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(fresh);
  return fresh.token;
}
