/**
 * Detect llama.cpp binaries on disk.
 *
 * Strategy: scan PATH + a handful of OS-specific install dirs (llama.cpp
 * and ik_llama.cpp build outputs) for known binary names. Each hit is
 * wrapped in a `RunnerConfig` so the registry can persist it and the UI
 * can offer it without further setup.
 *
 * Intentionally does NOT spawn the binary to read its version — that costs
 * 100-500ms per candidate and isn't needed to render a setup dialog.
 * Version probing happens lazily on first use.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  RunnerConfig,
  RunnerCapabilities,
} from '../../../renderer/modelhub/types';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/**
 * Binary basenames to search for, in priority order. `llama-server` comes
 * first because the HTTP server is the canonical Models Hub launch target;
 * the others are kept as fallbacks for older or atypical builds.
 */
const BINARIES = ['llama-server', 'llama-cli', 'main', 'server'];

/**
 * Extra dirs (beyond PATH) to scan. Covers the two common upstream build
 * layouts on Windows + standard POSIX prefixes. Both `llama.cpp` and
 * `ik_llama.cpp` ship a `build/bin/` directory after `cmake --build`.
 */
const EXTRA_DIRS = [
  path.join(os.homedir(), 'llama.cpp', 'build', 'bin'),
  path.join(os.homedir(), 'llama.cpp'),
  path.join(os.homedir(), 'ik_llama.cpp', 'build', 'bin'),
  path.join(os.homedir(), 'ik_llama.cpp'),
  'C:\\llama.cpp',
  'C:\\Program Files\\llama.cpp',
  '/opt/llama.cpp/bin',
  '/usr/local/bin',
];

const CAPABILITIES: RunnerCapabilities = { gguf: true, safetensors: false };

function getPathDirs(): string[] {
  const raw = process.env.PATH ?? '';
  const sep = IS_WIN ? ';' : ':';
  return raw
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Walk dirs in order; within each dir try binaries in priority order. Return
 * every distinct hit so a machine with both a llama.cpp build and an
 * ik_llama.cpp build surfaces both. De-dupe by absolute path.
 */
async function findAll(dirs: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    for (const bin of BINARIES) {
      const full = path.join(dir, bin + EXE);
      // eslint-disable-next-line no-await-in-loop
      if (await fileExists(full)) {
        const key = full.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(full);
        }
      }
    }
  }
  return out;
}

function makeLabel(fullPath: string): string {
  return `llama-server (${path.basename(fullPath)})`;
}

/**
 * Run detection. Returns a fresh array — does NOT touch persistence. The
 * caller (registry) decides how to merge with the user's saved set.
 */
export async function detectRunners(): Promise<RunnerConfig[]> {
  const dirs = [...getPathDirs(), ...EXTRA_DIRS];
  const found = await findAll(dirs);
  return found.map((p, i) => ({
    id: randomUUID(),
    label: makeLabel(p),
    path: p,
    capabilities: { ...CAPABILITIES },
    autoDetected: true,
    priority: i,
  }));
}

/**
 * Validate a user-supplied path: the binary must exist and be a file.
 */
export async function validateRunnerPath(p: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!p) return { ok: false, error: 'empty path' };
  const exists = await fileExists(p);
  if (!exists) return { ok: false, error: `not a file: ${p}` };
  return { ok: true };
}
