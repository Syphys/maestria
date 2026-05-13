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

import { useCallback, useEffect, useRef, useState } from 'react';
import { HardwareOverride, MODELHUB_IPC } from './types';

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

function ipcInvoke<T = unknown>(
  channel: string,
  ...args: unknown[]
): Promise<T | undefined> {
  const r = window?.electronIO?.ipcRenderer as
    | { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
    | undefined;
  if (!r) return Promise.resolve(undefined);
  return r.invoke(channel, ...args) as Promise<T>;
}

/** Fetches the effective HardwareProfile (override applied on top of detection). */
export async function fetchHardwareProfile(): Promise<
  HardwareProfile | undefined
> {
  try {
    const r = await ipcInvoke<{ ok: boolean; profile?: HardwareProfile }>(
      MODELHUB_IPC.detectHardware,
    );
    return r?.ok ? r.profile : undefined;
  } catch {
    return undefined;
  }
}

/** Fetches the raw detected HardwareProfile (no override). */
export async function fetchRawHardwareProfile(): Promise<
  HardwareProfile | undefined
> {
  try {
    const r = await ipcInvoke<{ ok: boolean; profile?: HardwareProfile }>(
      MODELHUB_IPC.detectHardwareRaw,
    );
    return r?.ok ? r.profile : undefined;
  } catch {
    return undefined;
  }
}

export async function getHardwareOverride(): Promise<HardwareOverride> {
  try {
    const r = await ipcInvoke<{ ok: boolean; override?: HardwareOverride }>(
      MODELHUB_IPC.getHardwareOverride,
    );
    return r?.override ?? {};
  } catch {
    return {};
  }
}

export async function setHardwareOverride(
  override: HardwareOverride,
): Promise<void> {
  const r = await ipcInvoke<{ ok: boolean; error?: string }>(
    MODELHUB_IPC.setHardwareOverride,
    override,
  );
  if (r && !r.ok) throw new Error(r.error ?? 'set failed');
}

export interface UseHardwareState {
  /** Effective profile (override applied). */
  effective: HardwareProfile | undefined;
  /** Raw detected profile (no override). */
  detected: HardwareProfile | undefined;
  /** Current persisted override fields. */
  override: HardwareOverride;
  loading: boolean;
  error?: string;
  /** Refresh detected + effective + override from main. */
  refresh: () => Promise<void>;
  /** Persist a new override and refresh. */
  saveOverride: (next: HardwareOverride) => Promise<void>;
  /** Clear every override field and refresh. */
  clearOverride: () => Promise<void>;
}

/**
 * Hook backing the Settings ▸ Hardware Accordion. Pulls all three
 * snapshots in parallel on mount. Polling is unnecessary — hardware
 * doesn't change at runtime — so subsequent refreshes are explicit.
 */
export function useHardware(): UseHardwareState {
  const [effective, setEffective] = useState<HardwareProfile | undefined>();
  const [detected, setDetected] = useState<HardwareProfile | undefined>();
  const [override, setOverride] = useState<HardwareOverride>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const [eff, raw, ov] = await Promise.all([
        fetchHardwareProfile(),
        fetchRawHardwareProfile(),
        getHardwareOverride(),
      ]);
      if (!aliveRef.current) return;
      setEffective(eff);
      setDetected(raw);
      setOverride(ov);
    } catch (e) {
      if (aliveRef.current) setError((e as Error).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  const saveOverride = useCallback(
    async (next: HardwareOverride) => {
      setError(undefined);
      try {
        await setHardwareOverride(next);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  const clearOverrideCb = useCallback(async () => {
    setError(undefined);
    try {
      await setHardwareOverride({});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refresh]);

  return {
    effective,
    detected,
    override,
    loading,
    error,
    refresh,
    saveOverride,
    clearOverride: clearOverrideCb,
  };
}

/** Format a byte count as a short "23.4 GB" / "512 MB" string. */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}
