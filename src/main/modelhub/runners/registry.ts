/**
 * Persistent runner registry.
 *
 * Stores configured runners as JSON in the Electron user-data dir under
 * `modelhub-runners.json`. Survives upgrades; the file is opt-in and only
 * created on first save. On first read we merge in auto-detected runners
 * so the user never sees an empty list when llama-server / ollama is
 * already on PATH.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { RunnerConfig } from '../../../renderer/modelhub/types';
import { detectRunners } from './detect';

const FILE_NAME = 'modelhub-runners.json';

interface RegistryFile {
  version: 1;
  runners: RunnerConfig[];
  /** Set after first auto-merge so we don't re-add detected entries the user removed. */
  autoMergedAt?: string;
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

async function readFile(): Promise<RegistryFile | undefined> {
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed.version !== 1) return undefined;
    return parsed;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    // Corrupted file: surface to console but don't crash the app.
    console.warn('[modelhub] runner registry read failed:', e?.message ?? e);
    return undefined;
  }
}

async function writeFile(data: RegistryFile): Promise<void> {
  const fp = getFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Backfill UUIDs for entries persisted with an empty `id` (legacy fallout
 * from an older `saveRunner` that used `??` and let the empty-string id
 * posted by the manual-add form survive). Without this migration the
 * renderer can't edit such rows: clicking Edit sets `editingId = ''`
 * which is falsy, so `editingRunner` resolves to undefined and the form
 * never opens. Returns true when at least one entry was rewritten.
 */
function backfillIds(file: RegistryFile): boolean {
  let touched = false;
  for (const r of file.runners) {
    if (!r.id) {
      r.id = randomUUID();
      touched = true;
    }
  }
  return touched;
}

/**
 * Load runners. On first call (no file yet), auto-detection populates the
 * list so subsequent calls are instant. Subsequent calls do NOT re-detect
 * — that's what `detectAndMerge` is for. Without this split, a user who
 * removed a detected runner would see it pop back every load.
 */
export async function listRunners(): Promise<RunnerConfig[]> {
  const file = await readFile();
  if (file) {
    if (backfillIds(file)) await writeFile(file);
    return file.runners;
  }

  const detected = await detectRunners();
  await writeFile({
    version: 1,
    runners: detected,
    autoMergedAt: new Date().toISOString(),
  });
  return detected;
}

export async function saveRunner(runner: RunnerConfig): Promise<RunnerConfig> {
  const file = (await readFile()) ?? {
    version: 1 as const,
    runners: [],
  };
  // Use `||` rather than `??` so the empty-string id the manual-add
  // form posts ("id: ''") triggers a fresh UUID — otherwise every
  // hand-added runner would have id "" and overwrite the previous one.
  const id = runner.id || randomUUID();
  const next: RunnerConfig = { ...runner, id };
  const idx = file.runners.findIndex((r) => r.id === id);
  if (idx >= 0) file.runners[idx] = next;
  else file.runners.push(next);
  await writeFile(file);
  return next;
}

export async function removeRunner(id: string): Promise<void> {
  const file = await readFile();
  if (!file) return;
  file.runners = file.runners.filter((r) => r.id !== id);
  await writeFile(file);
}

/**
 * Re-runs detection and merges hits into the saved set without duplicating
 * existing paths. Useful for the "Refresh detection" button in the setup UI.
 */
export async function detectAndMerge(): Promise<RunnerConfig[]> {
  const file = (await readFile()) ?? {
    version: 1 as const,
    runners: [],
  };
  let dirty = backfillIds(file);
  const detected = await detectRunners();
  const known = new Set(file.runners.map((r) => r.path.toLowerCase()));
  const additions = detected.filter((d) => !known.has(d.path.toLowerCase()));
  if (additions.length > 0) {
    file.runners = [...file.runners, ...additions];
    file.autoMergedAt = new Date().toISOString();
    dirty = true;
  }
  if (dirty) await writeFile(file);
  return file.runners;
}
