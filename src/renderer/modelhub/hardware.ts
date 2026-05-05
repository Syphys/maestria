/**
 * Hardware profile types + estimator helpers for Models Hub.
 *
 * Right now the detection backend is a stub (returns undefined fields when
 * actual detection hasn't been implemented yet — see `src/main/modelhub/hardware.ts`).
 * The shape is stable so UI components (size filter, run-fit estimator…)
 * can be built against it now and become hardware-aware automatically once
 * detection lands in Phase 3.
 *
 * See MODELS_HUB.md → Phase 3 (Hardware-aware execution).
 */

import { MODELHUB_IPC } from './types';

export type HardwareSource = 'detected' | 'manual' | 'unknown';

export interface GpuInfo {
  /** Vendor name as reported by the OS (e.g. "NVIDIA", "AMD", "Apple"). */
  vendor?: string;
  /** Card model name (e.g. "GeForce RTX 4090"). */
  name?: string;
  /** Total VRAM in bytes. Undefined when not detectable. */
  vramBytes?: number;
}

export interface HardwareProfile {
  source: HardwareSource;
  /** Total system RAM in bytes. */
  ramBytes?: number;
  /** Free RAM at the time of detection (rough). */
  freeRamBytes?: number;
  /** CPU model + logical core count. */
  cpu?: { model?: string; cores?: number };
  /** First/primary GPU. Multi-GPU support deferred. */
  gpu?: GpuInfo;
  detectedAt?: string;
}

export interface RuntimeEstimate {
  /** Headroom we deliberately reserve below the hard VRAM/RAM ceiling (default 15%). */
  safetyMarginPct: number;
  /** Maximum file size (bytes) we estimate fits in VRAM. Undefined when no GPU info. */
  maxVramFitBytes?: number;
  /** Maximum file size that fits in system RAM. */
  maxRamFitBytes?: number;
  /**
   * The "safe to load" budget (bytes) — min(vram, ram) when both known,
   * otherwise the one that's known. Undefined when neither is.
   * This is what the size-filter UI uses for the "Safe" preset.
   */
  safeBudgetBytes?: number;
}

const DEFAULT_SAFETY_MARGIN = 0.15;

/**
 * Estimate runtime memory budgets from a hardware profile.
 * The numbers are intentionally conservative — file size is a strict lower
 * bound on memory needed (KV cache, activations, OS overhead push it higher),
 * so a `safetyMarginPct` of 15% by default models that a bit.
 */
export function estimateRuntime(
  profile: HardwareProfile | undefined,
  safetyMarginPct: number = DEFAULT_SAFETY_MARGIN,
): RuntimeEstimate {
  const margin = 1 - safetyMarginPct;
  const vram = profile?.gpu?.vramBytes;
  const ram = profile?.ramBytes;
  const maxVramFitBytes =
    typeof vram === 'number' ? Math.floor(vram * margin) : undefined;
  const maxRamFitBytes =
    typeof ram === 'number' ? Math.floor(ram * margin) : undefined;
  let safeBudgetBytes: number | undefined;
  if (
    typeof maxVramFitBytes === 'number' &&
    typeof maxRamFitBytes === 'number'
  ) {
    // Conservative: pick the larger of (VRAM fit) and (RAM fit) since llama.cpp
    // can offload partial layers to RAM. UI will distinguish.
    safeBudgetBytes = Math.max(maxVramFitBytes, maxRamFitBytes);
  } else {
    safeBudgetBytes = maxVramFitBytes ?? maxRamFitBytes;
  }
  return { safetyMarginPct, maxVramFitBytes, maxRamFitBytes, safeBudgetBytes };
}

/** Calls the main process IPC to fetch the latest hardware profile. */
export async function fetchHardwareProfile(): Promise<
  HardwareProfile | undefined
> {
  if (
    typeof window === 'undefined' ||
    !window.electronIO?.ipcRenderer?.invoke
  ) {
    return undefined;
  }
  try {
    const result = (await window.electronIO.ipcRenderer.invoke(
      MODELHUB_IPC.detectHardware,
    )) as { ok: boolean; profile?: HardwareProfile; error?: string };
    if (result?.ok && result.profile) return result.profile;
    return undefined;
  } catch {
    return undefined;
  }
}
