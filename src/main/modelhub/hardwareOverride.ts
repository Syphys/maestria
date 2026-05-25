/**
 * Persisted hardware override.
 *
 * Stored in the Electron user-data dir as `modelhub-hardware.json`.
 * Empty / zero / negative fields are stripped on write so a "clear
 * this field" UX is just "save with the input blank". The override
 * fields a user typically sets:
 *
 *   - vendor: "NVIDIA" / "AMD" / "Apple" / "Intel"
 *   - name:   "GeForce RTX 4090" / "Radeon RX 7900 XT" / "M2 Max"
 *   - vramBytes: 24 GB cards on AMD/Intel where Get-CimInstance reports
 *     the wrong wrap-around value, or to model a future GPU before
 *     installing it (autotune preview)
 *   - ramBytes: rarely useful — only if the user wants to model a
 *     constrained scenario
 *
 * The merge logic lives in `hardware.ts`: any override field that's
 * present wins over the corresponding detected field. The profile's
 * `source` becomes 'manual' as soon as ONE field is overridden.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

const FILE_NAME = 'modelhub-hardware.json';

export interface HardwareOverride {
  vendor?: string;
  name?: string;
  vramBytes?: number;
  ramBytes?: number;
}

interface HardwareFile {
  version: 1;
  override: HardwareOverride;
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

async function readFile(): Promise<HardwareFile | undefined> {
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as HardwareFile;
    if (parsed.version !== 1) return undefined;
    return parsed;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    console.warn('[modelhub-hardware] read failed:', e?.message ?? String(e));
    return undefined;
  }
}

async function writeFile(data: HardwareFile): Promise<void> {
  const fp = getFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
  try {
    await fs.chmod(fp, 0o600);
  } catch {
    /* POSIX only; no-op on Windows */
  }
}

function sanitize(input: HardwareOverride): HardwareOverride {
  const out: HardwareOverride = {};
  if (typeof input.vendor === 'string' && input.vendor.trim()) {
    out.vendor = input.vendor.trim();
  }
  if (typeof input.name === 'string' && input.name.trim()) {
    out.name = input.name.trim();
  }
  if (typeof input.vramBytes === 'number' && input.vramBytes > 0) {
    out.vramBytes = Math.floor(input.vramBytes);
  }
  if (typeof input.ramBytes === 'number' && input.ramBytes > 0) {
    out.ramBytes = Math.floor(input.ramBytes);
  }
  return out;
}

export async function getOverride(): Promise<HardwareOverride> {
  const f = await readFile();
  return f?.override ?? {};
}

export async function setOverride(input: HardwareOverride): Promise<void> {
  const override = sanitize(input);
  await writeFile({ version: 1, override });
}

export async function clearOverride(): Promise<void> {
  await writeFile({ version: 1, override: {} });
}

/** True when at least one field of the override is set. */
export function hasAnyOverride(o: HardwareOverride): boolean {
  return (
    !!o.vendor ||
    !!o.name ||
    typeof o.vramBytes === 'number' ||
    typeof o.ramBytes === 'number'
  );
}
