/**
 * Heuristic auto-tune for runner launch parameters.
 *
 * Inputs: parsed model metadata (file size, params, quantization, ctx_max)
 * + hardware profile (RAM, VRAM, cores).
 * Output: a `RunParams` object with reasoning so the UI can show *why*
 * the values were chosen.
 *
 * Calibration is intentionally conservative — better to under-fill VRAM
 * (slower but works) than to crash with OOM at load time.
 */

import { HeaderMeta, RunParams } from '../../../renderer/modelhub/types';
import { HardwareProfile } from '../../../renderer/modelhub/hardware';

const GB = 1_000_000_000;

/** Per-token KV-cache memory cost (bytes), rough estimate for q8 KV. */
const KV_BYTES_PER_TOKEN_PER_LAYER = 2 * 1024; // ~2 KiB

/** Reserve this much VRAM beyond the weight footprint for KV + activations. */
const VRAM_HEADROOM_BYTES = 1.5 * GB;

/** Reserve this much RAM for the OS + the renderer process. */
const RAM_HEADROOM_BYTES = 2 * GB;

interface AutotuneInput {
  header?: HeaderMeta;
  hardware?: HardwareProfile;
  /** Hard ceiling for ctx — useful when caller already knows user intent. */
  maxContext?: number;
  /** Server bind port (default 8080). */
  port?: number;
}

/**
 * The "model weights" footprint on disk. For sharded models we want the
 * sum across all shards (set by `parseHeader` on the canonical shard);
 * non-sharded files have `fileSize` only. Without this, autotune on a
 * 12-shard 60 GB model would size everything from the 5 GB of shard 1.
 */
function modelBytes(header: HeaderMeta | undefined): number {
  return header?.totalBytes ?? header?.fileSize ?? 0;
}

/**
 * Estimate the memory cost of one offloaded layer in bytes.
 * Falls back to (modelBytes / blockCount) when the parser exposed both;
 * else uses (modelBytes / 32) which is the typical Llama layer count.
 */
function bytesPerLayer(header: HeaderMeta | undefined): number {
  const file = modelBytes(header);
  if (!file || file <= 0) return 0;
  const blocks =
    header?.blockCount && header.blockCount > 0 ? header.blockCount : 32;
  return Math.ceil(file / blocks);
}

/**
 * How many model layers we can realistically offload to VRAM.
 * Returns 0 when there's no GPU info, meaning "CPU only".
 */
function computeNgl(input: AutotuneInput): { ngl: number; rationale: string } {
  const vram = input.hardware?.gpu?.vramBytes;
  if (!vram || vram <= 0) {
    return { ngl: 0, rationale: 'no GPU detected → CPU only (ngl=0)' };
  }
  const perLayer = bytesPerLayer(input.header);
  if (perLayer <= 0) {
    // Without a cost estimate we can't decide; default to "all" and let
    // llama.cpp clamp. -1 means "all layers" in llama-server.
    return { ngl: -1, rationale: 'cost-per-layer unknown → ngl=-1 (all)' };
  }
  const usableVram = Math.max(0, vram - VRAM_HEADROOM_BYTES);
  const fits = Math.floor(usableVram / perLayer);
  const totalLayers = input.header?.blockCount ?? 32;
  const ngl = Math.max(0, Math.min(fits, totalLayers));
  return {
    ngl,
    rationale: `VRAM ${(vram / GB).toFixed(1)} GB − ${(VRAM_HEADROOM_BYTES / GB).toFixed(1)} GB headroom = ${(usableVram / GB).toFixed(1)} GB / ${(perLayer / 1e6).toFixed(0)} MB per layer → ${ngl}/${totalLayers} layers`,
  };
}

/**
 * Pick a context length that fits in remaining RAM after the weights.
 * Prefer the model's trained `contextMax`; clamp downward if KV cache
 * wouldn't fit.
 */
function computeCtx(
  input: AutotuneInput,
  ngl: number,
): { ctx: number; rationale: string } {
  const requested = Math.min(
    input.maxContext ?? Infinity,
    input.header?.contextMax ?? 8192,
  );
  const totalLayers = input.header?.blockCount ?? 32;
  // KV lives in VRAM for offloaded layers, RAM for the rest.
  const ramAvailable = Math.max(
    0,
    (input.hardware?.ramBytes ?? 0) -
      RAM_HEADROOM_BYTES -
      modelBytes(input.header),
  );
  const cpuLayers = Math.max(0, totalLayers - Math.max(0, ngl));
  const ramKvLimit =
    cpuLayers > 0
      ? Math.floor(ramAvailable / (cpuLayers * KV_BYTES_PER_TOKEN_PER_LAYER))
      : Infinity;
  // VRAM KV is bounded by what's left after the weights.
  const vram = input.hardware?.gpu?.vramBytes ?? 0;
  const weightsInVram =
    modelBytes(input.header) *
    (totalLayers > 0 ? Math.max(0, ngl) / totalLayers : 0);
  const vramKvAvailable = Math.max(0, vram - weightsInVram - 0.5 * GB);
  const vramLayersForKv = Math.max(1, Math.max(0, ngl));
  const vramKvLimit =
    Math.floor(
      vramKvAvailable / (vramLayersForKv * KV_BYTES_PER_TOKEN_PER_LAYER),
    ) || Infinity;
  const ctx = Math.max(512, Math.min(requested, ramKvLimit, vramKvLimit));
  // Round down to a power of 2 — most runners cope better with these.
  const rounded = 1 << Math.floor(Math.log2(ctx));
  return {
    ctx: rounded,
    rationale: `requested ${requested}, KV-cache limits → ctx=${rounded}`,
  };
}

/** Reasonable thread count: physical cores − 1, capped at 16. */
function computeThreads(profile: HardwareProfile | undefined): number {
  const logical = profile?.cpu?.cores ?? 4;
  // Treat reported `cores` as logical; physical ≈ logical/2 on hyperthreaded systems.
  const physical = Math.max(1, Math.floor(logical / 2));
  return Math.max(1, Math.min(16, physical - 1 || 1));
}

export function autotune(input: AutotuneInput): RunParams {
  const rationale: string[] = [];

  const { ngl, rationale: nglWhy } = computeNgl(input);
  rationale.push(`ngl: ${nglWhy}`);

  const { ctx, rationale: ctxWhy } = computeCtx(input, ngl);
  rationale.push(`ctx: ${ctxWhy}`);

  const threads = computeThreads(input.hardware);
  rationale.push(`threads: ${threads} (physical cores − 1, capped at 16)`);

  // Batch size: bigger when we have GPU offload, modest on CPU.
  const batchSize = ngl !== 0 ? 2048 : 512;
  rationale.push(
    `batch-size: ${batchSize} (${ngl !== 0 ? 'GPU' : 'CPU'} preset)`,
  );

  const flashAttn = !!input.hardware?.gpu?.vramBytes;
  if (flashAttn) rationale.push('flash-attn: on (GPU present)');

  const mlock =
    (input.hardware?.ramBytes ?? 0) > modelBytes(input.header) + 4 * GB;
  if (mlock) rationale.push('mlock: on (RAM ≥ weights + 4 GB)');

  return {
    ngl,
    ctx,
    threads,
    batchSize,
    mlock,
    flashAttn,
    port: input.port ?? 8080,
    rationale,
  };
}
