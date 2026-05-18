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

/** Descend to leaf granularity when a leaf projects ≥ this (SPEC §5). */
export const DEFAULT_THETA_Q = 0.5;
/** Open a branch's leaves only if its level-1 probe ≥ this (SPEC §3). */
export const DEFAULT_THETA_OPEN = 0.6;
/** Min per-language embedding reliability to trust the projector (§4). */
export const DEFAULT_EMBEDDING_RELIABILITY_THRESHOLD = 0.7;

export interface RoutingConfig {
  /** Bytes held back from probed free VRAM before fit scoring. */
  vramReserveBytes?: number;
  /** Bytes held back from probed free RAM before fit scoring. */
  ramReserveBytes?: number;
  /**
   * SPEC v0 vector routing. When `routingEmbedderBaseUrl` is set,
   * `models.route` projects the query onto the probe anchors and ranks by
   * the competence tree; on ANY failure it silently falls back to the R5
   * deterministic classifier. Empty ⇒ R5 only (back-compat).
   */
  routingEmbedderBaseUrl?: string;
  /** Model id sent to the embedder (local llama-server ignores it). */
  routingEmbedderModel?: string;
  /** θ_q — branch→leaf descent confidence (0..1). Blank ⇒ 0.5. */
  thetaQ?: number;
  /** θ_open — characterization branch gate (0..1). Blank ⇒ 0.6. */
  thetaOpen?: number;
  /** Embedding-reliability gate threshold (0..1). Blank ⇒ 0.7. */
  embeddingReliabilityThreshold?: number;
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

/** Keep a 0..1 knob only when it is a finite number strictly in range. */
function unit(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1
    ? v
    : undefined;
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
  const url = input.routingEmbedderBaseUrl?.trim();
  if (url) out.routingEmbedderBaseUrl = url;
  const model = input.routingEmbedderModel?.trim();
  if (model) out.routingEmbedderModel = model;
  const tq = unit(input.thetaQ);
  if (tq !== undefined) out.thetaQ = tq;
  const to = unit(input.thetaOpen);
  if (to !== undefined) out.thetaOpen = to;
  const er = unit(input.embeddingReliabilityThreshold);
  if (er !== undefined) out.embeddingReliabilityThreshold = er;
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

/**
 * Vector-routing knobs the router/characterizer actually apply: the user
 * value when set, the documented default otherwise. `embedder` is
 * undefined when no routing embedder is configured ⇒ `models.route`
 * stays on the R5 deterministic path.
 */
export function effectiveRoutingParams(cfg: RoutingConfig): {
  thetaQ: number;
  thetaOpen: number;
  embeddingReliabilityThreshold: number;
  embedder?: { baseUrl: string; model?: string };
} {
  return {
    thetaQ: cfg.thetaQ ?? DEFAULT_THETA_Q,
    thetaOpen: cfg.thetaOpen ?? DEFAULT_THETA_OPEN,
    embeddingReliabilityThreshold:
      cfg.embeddingReliabilityThreshold ??
      DEFAULT_EMBEDDING_RELIABILITY_THRESHOLD,
    embedder: cfg.routingEmbedderBaseUrl
      ? {
          baseUrl: cfg.routingEmbedderBaseUrl,
          model: cfg.routingEmbedderModel,
        }
      : undefined,
  };
}
