/**
 * Runner auto-detection.
 *
 * Strategy: scan PATH for known binary names + a handful of OS-specific
 * install locations (Ollama default install dirs, LM Studio bundles…).
 * Each hit is wrapped in a `RunnerConfig` so the registry can persist it
 * and the UI can offer it without further setup.
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
  RunnerKind,
  RunnerCapabilities,
} from '../../../renderer/modelhub/types';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

interface CandidateSpec {
  kind: RunnerKind;
  /** Binary basenames to look for (no extension; .exe is added on Windows). */
  binaries: string[];
  /** Extra absolute or "~"-prefixed dirs to scan beyond PATH. */
  extraDirs: string[];
  capabilities: RunnerCapabilities;
}

const CANDIDATES: CandidateSpec[] = [
  {
    kind: 'llama.cpp',
    binaries: ['llama-server', 'llama-cli', 'main', 'server'],
    extraDirs: [
      path.join(os.homedir(), 'llama.cpp', 'build', 'bin'),
      path.join(os.homedir(), 'llama.cpp'),
      'C:\\llama.cpp',
      'C:\\Program Files\\llama.cpp',
      '/opt/llama.cpp/bin',
      '/usr/local/bin',
    ],
    capabilities: { chat: true, server: true, gguf: true, safetensors: false },
  },
  {
    kind: 'ik_llama.cpp',
    binaries: ['ik_llama-server', 'ik_llama-cli', 'ik_llama'],
    extraDirs: [
      path.join(os.homedir(), 'ik_llama.cpp', 'build', 'bin'),
      path.join(os.homedir(), 'ik_llama.cpp'),
    ],
    capabilities: { chat: true, server: true, gguf: true, safetensors: false },
  },
  {
    kind: 'koboldcpp',
    binaries: ['koboldcpp', 'koboldcpp_cuda', 'koboldcpp_rocm'],
    extraDirs: [path.join(os.homedir(), 'koboldcpp'), 'C:\\koboldcpp'],
    capabilities: { chat: true, server: true, gguf: true, safetensors: false },
  },
];

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
 * Look for any of `binaries` in `dirs`. Returns the first match's full path,
 * or undefined. Order matters: caller passes binaries in priority order
 * (e.g. llama-server before main, since we prefer the HTTP server).
 */
async function findBinary(
  binaries: string[],
  dirs: string[],
): Promise<string | undefined> {
  for (const bin of binaries) {
    const fname = bin + EXE;
    for (const dir of dirs) {
      const full = path.join(dir, fname);
      // eslint-disable-next-line no-await-in-loop
      if (await fileExists(full)) return full;
    }
  }
  return undefined;
}

function makeLabel(kind: RunnerKind, fullPath: string): string {
  return `${kind} (${path.basename(fullPath)})`;
}

/**
 * Run detection for all known runner kinds.
 * Returns a fresh array — does NOT touch persistence. The caller (registry)
 * decides how to merge with the user's saved set.
 */
export async function detectRunners(): Promise<RunnerConfig[]> {
  const pathDirs = getPathDirs();
  const results: RunnerConfig[] = [];

  for (let i = 0; i < CANDIDATES.length; i += 1) {
    const spec = CANDIDATES[i];
    const dirs = [...pathDirs, ...spec.extraDirs];
    // eslint-disable-next-line no-await-in-loop
    const found = await findBinary(spec.binaries, dirs);
    if (!found) continue;
    results.push({
      id: randomUUID(),
      kind: spec.kind,
      label: makeLabel(spec.kind, found),
      path: found,
      capabilities: { ...spec.capabilities },
      autoDetected: true,
      priority: i, // matches CANDIDATES order: llama.cpp first
    });
  }

  return results;
}

/**
 * Validate a user-supplied path: the binary must exist and be a file.
 * The kind is taken at face value — we cannot reliably sniff llama.cpp
 * vs ik_llama.cpp from the binary itself without running it.
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
