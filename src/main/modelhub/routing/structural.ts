// R0.4 — Structural signature aggregator.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.4 ; arbitration: DECISIONS.md D8.1.
//
// Pure, no I/O. Folds the already-parsed GGUF header + autoTags into a
// StructuralSignature. Called during ParseAll.
//
// IMPORTANT: the signature carries only the model's own memory footprint
// (`est_footprint_bytes`) — a model-intrinsic fact. Whether/how well it
// *fits* is NOT part of the signature: it depends on the machine, and
// signatures are portable across machines (D6/R7). Use `memoryFitScore()`
// at the point of use (R5 scorer) with the live free-memory probe (D8.2)
// for the dynamic decision, or with TOTAL memory for the "could it ever
// run" question. It returns a graded weight, not a boolean. Never persist.

import type { HeaderMeta } from '../../../renderer/modelhub/types';
import type { StructuralSignature } from '../../../shared/RoutingTypes';

/** Same default headroom as renderer/modelhub/hardware.ts `estimateRuntime`. */
export const DEFAULT_SAFETY_MARGIN = 0.15;

export type MemoryFitOpts = {
  /** Headroom kept below each ceiling. Default 0.15. */
  safetyMargin?: number;
  /** Desirability of the VRAM-resident fraction. Default 1.0 (ideal). */
  gpuWeight?: number;
  /** Desirability of the CPU/RAM-spilled fraction (slow). Default 0.15. */
  cpuWeight?: number;
  /** Penalty when it fits in neither VRAM nor RAM. Default 1.0. */
  oomPenalty?: number;
};

/**
 * GRADED fit weight — apply at the point of use (R5 dynamic scorer with the
 * live free-memory probe, DECISIONS.md D8.1/D8.2), never stored. Not a
 * boolean: it rewards how much of the model is GPU-resident (fast),
 * degrades smoothly as it spills to RAM (works, slow), and goes negative
 * when it fits nowhere (OOM → effectively excluded after weighting).
 *
 *   g     = usableFreeVram / footprint            (clamped 0..1)
 *   fits  = footprint ≤ usableFreeVram + usableFreeRam
 *   score = fits ? gpuWeight·g + cpuWeight·(1−g) : −oomPenalty
 *
 * Pass *free* VRAM/RAM (net of resident models) for the dynamic decision,
 * or *total* for the static "could this machine ever run it" question.
 * Returns `null` when BOTH budgets are unknown — never a misleading 0/false.
 */
export function memoryFitScore(
  footprintBytes: number,
  freeVramBytes: number | undefined,
  freeRamBytes: number | undefined,
  opts: MemoryFitOpts = {},
): number | null {
  if (footprintBytes <= 0) return null;
  const vKnown = typeof freeVramBytes === 'number';
  const rKnown = typeof freeRamBytes === 'number';
  if (!vKnown && !rKnown) return null;

  const m = opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const gpuW = opts.gpuWeight ?? 1.0;
  const cpuW = opts.cpuWeight ?? 0.15;
  const oom = opts.oomPenalty ?? 1.0;

  const usableV = vKnown ? Math.max(freeVramBytes!, 0) * (1 - m) : 0;
  const usableR = rKnown ? Math.max(freeRamBytes!, 0) * (1 - m) : 0;

  const g = Math.min(Math.max(usableV / footprintBytes, 0), 1);
  const fitsAtAll = footprintBytes <= usableV + usableR;
  return fitsAtAll ? gpuW * g + cpuW * (1 - g) : -oom;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * MoE detection + active-param estimate. GGUF stores expert counts under
 * `<arch>.expert_count` / `<arch>.expert_used_count`. We can't read the true
 * active parameter count from the header, so for MoE we scale total by
 * used/count as a documented rough proxy; dense ⇒ active = total.
 */
function deriveParams(header: HeaderMeta): {
  total_b: number;
  active_b: number | null;
} {
  const total_b = header.paramCount ? round1(header.paramCount / 1e9) : 0;
  const raw = header.rawMetadata ?? {};
  let expertCount: number | undefined;
  let expertUsed: number | undefined;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number') continue;
    if (k.endsWith('.expert_count')) expertCount = v;
    else if (k.endsWith('.expert_used_count')) expertUsed = v;
  }
  const archStr = String(header.architecture ?? '').toLowerCase();
  const isMoe = archStr.includes('moe') || (!!expertCount && expertCount > 1);
  if (!isMoe) return { total_b, active_b: total_b };
  if (expertCount && expertUsed && expertCount > 0) {
    return { total_b, active_b: round1(total_b * (expertUsed / expertCount)) };
  }
  return { total_b, active_b: null }; // MoE but not derivable from header
}

function mapModality(
  m: HeaderMeta['modality'],
): StructuralSignature['modality'] {
  switch (m) {
    case 'embedding':
      return 'embedding';
    case 'multimodal':
      return 'multimodal';
    case 'audio':
      return 'audio';
    case 'image':
    case 'video':
      return 'image-gen';
    default:
      return 'text';
  }
}

function langsFromAutoTags(
  autoTags: string[] | undefined,
): string[] | undefined {
  if (!autoTags?.length) return undefined;
  const langs = autoTags
    .filter((t) => t.startsWith('lang:'))
    .map((t) => t.slice('lang:'.length).trim())
    .filter(Boolean);
  return langs.length ? Array.from(new Set(langs)) : undefined;
}

/**
 * Build the StructuralSignature for one model. No hardware input — the
 * signature is machine-independent by design (see file header).
 */
export function computeStructuralSignature(args: {
  header: HeaderMeta;
  autoTags?: string[];
}): StructuralSignature {
  const { header, autoTags } = args;
  const quantization = header.quantization ?? 'unknown';
  // GGUF is mmap'd ~1:1, so on-disk size (summed across shards) is a solid
  // lower-bound proxy for the loaded-weights footprint.
  const footprint = header.totalBytes ?? header.fileSize ?? 0;

  return {
    architecture: String(header.architecture ?? 'unknown'),
    params: deriveParams(header),
    quantization,
    modality: mapModality(header.modality),
    context_max: header.contextMax ?? 0,
    est_footprint_bytes: footprint,
    supported_langs: langsFromAutoTags(autoTags),
  };
}
