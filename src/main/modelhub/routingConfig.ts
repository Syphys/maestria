/**
 * Persisted routing configuration (Slice 6 wiring — D8.2).
 *
 * Stored in the Electron user-data dir as `modelhub-routing.json`,
 * mirroring `hardwareOverride.ts`. Holds the user-tunable knobs the
 * deterministic router needs but that are machine/taste dependent and
 * therefore must NOT be baked into any signature (DECISIONS.md D8).
 *
 * Today it carries the live free-memory probe's safety reserves: the
 * amount of VRAM / RAM we hold back before deciding what fits. Empty /
 * zero / negative fields are stripped on write, so "use the default" UX
 * is just "save with the input blank".
 *
 * The reserve protects the desktop compositor + the about-to-be-routed
 * model's runtime overhead (KV cache, activations) that a raw "free
 * bytes" number doesn't account for. Surfaced in Settings ▸ AI ▸ Routing.
 */

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

const FILE_NAME = 'modelhub-routing.json';

/** Held back from free VRAM by default — OS/compositor + model overhead. */
export const DEFAULT_VRAM_RESERVE_BYTES = 1 * 1024 ** 3; // 1 GiB
/** Held back from free RAM by default — generous, RAM spill is the slow path. */
export const DEFAULT_RAM_RESERVE_BYTES = 2 * 1024 ** 3; // 2 GiB

export interface RoutingConfig {
  /** Bytes held back from probed free VRAM before fit scoring. */
  vramReserveBytes?: number;
  /** Bytes held back from probed free RAM before fit scoring. */
  ramReserveBytes?: number;
}

interface RoutingFile {
  version: 1;
  config: RoutingConfig;
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

async function readFile(): Promise<RoutingFile | undefined> {
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as RoutingFile;
    if (parsed.version !== 1) return undefined;
    return parsed;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    console.warn('[modelhub-routing] read failed:', e?.message ?? String(e));
    return undefined;
  }
}

async function writeFile(data: RoutingFile): Promise<void> {
  const fp = getFilePath();
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
}

function sanitize(input: RoutingConfig): RoutingConfig {
  const out: RoutingConfig = {};
  if (
    typeof input.vramReserveBytes === 'number' &&
    input.vramReserveBytes > 0
  ) {
    out.vramReserveBytes = Math.floor(input.vramReserveBytes);
  }
  if (typeof input.ramReserveBytes === 'number' && input.ramReserveBytes > 0) {
    out.ramReserveBytes = Math.floor(input.ramReserveBytes);
  }
  return out;
}

/** Persisted config (only the fields the user explicitly set). */
export async function getRoutingConfig(): Promise<RoutingConfig> {
  const f = await readFile();
  return f?.config ?? {};
}

export async function setRoutingConfig(input: RoutingConfig): Promise<void> {
  const config = sanitize(input);
  await writeFile({ version: 1, config });
}

/**
 * The reserves the probe actually applies: the user value when set, the
 * documented default otherwise. Never undefined — the probe always has a
 * concrete headroom to subtract.
 */
export function effectiveReserves(cfg: RoutingConfig): {
  vramReserveBytes: number;
  ramReserveBytes: number;
} {
  return {
    vramReserveBytes: cfg.vramReserveBytes ?? DEFAULT_VRAM_RESERVE_BYTES,
    ramReserveBytes: cfg.ramReserveBytes ?? DEFAULT_RAM_RESERVE_BYTES,
  };
}
