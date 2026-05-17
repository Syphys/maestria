// Slice 6 wiring — D8.2 live free-memory probe.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R5 ; arbitration: DECISIONS.md D8.1
// (graded fit, applied at point of use), D8.2 (DYNAMIC, resource-aware:
// the free-memory figure is probed live and is NEVER part of a
// signature — signatures are portable across machines, D6/R7).
//
// Produces the `RouteResources` the pure router consumes, net of the
// models already resident, minus a user-tunable safety reserve
// (routingConfig — surfaced in Settings ▸ AI ▸ Routing).
//
// Fail-tolerant: every sub-probe is isolated; an unknown budget is
// reported as `undefined` (NOT 0) so `memoryFitScore` can fall back to
// the other ceiling instead of wrongly flagging OOM. Every external
// effect is injectable so the orchestration is unit-testable offline
// (no spawn / no fs / no os state).

import { exec } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { detectHardwareProfile } from '../hardware';
import { listRunning, type RunningSummary } from '../runners/launch';
import {
  effectiveReserves,
  getRoutingConfig,
  type RoutingConfig,
} from '../routingConfig';
import { loadSignature } from './signatureStore';
import type { RouteResources } from './router';

const execAsync = promisify(exec);
const NVIDIA_SMI_TIMEOUT_MS = 4_000;

export interface FreeMemoryProbe extends RouteResources {
  /** How `freeVramBytes` was obtained (transparency for the caller/UI). */
  vramSource: 'nvidia-smi' | 'total-minus-resident' | 'unknown';
  /** Reserves actually subtracted (user value or documented default). */
  reserves: { vramReserveBytes: number; ramReserveBytes: number };
  /** Canonical paths of resident models folded into the fallback. */
  residentModels: string[];
}

export interface FreeMemoryDeps {
  execAsync?: typeof execAsync;
  freemem?: () => number;
  listRunning?: typeof listRunning;
  loadSignature?: typeof loadSignature;
  detectHardwareProfile?: typeof detectHardwareProfile;
  getRoutingConfig?: typeof getRoutingConfig;
}

/** Live free VRAM (bytes) from nvidia-smi, or undefined when unavailable. */
async function nvidiaFreeVramBytes(
  ex: typeof execAsync,
): Promise<number | undefined> {
  try {
    const { stdout } = await ex(
      'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits',
      { timeout: NVIDIA_SMI_TIMEOUT_MS },
    );
    // First card wins — multi-GPU is deferred (same convention as
    // hardwareDetect.ts). Value is MiB.
    const line = stdout.trim().split('\n')[0]?.trim();
    const mib = parseInt(line ?? '', 10);
    if (!Number.isFinite(mib) || mib < 0) return undefined;
    return mib * 1024 * 1024;
  } catch {
    return undefined;
  }
}

/** Sum the persisted footprint of every model currently held by a runner. */
async function residentFootprint(
  running: RunningSummary[],
  ls: typeof loadSignature,
): Promise<{ bytes: number; paths: string[] }> {
  let bytes = 0;
  const paths: string[] = [];
  for (const r of running) {
    if (r.exited || !r.filePath) continue;
    const sig = await ls(r.filePath).catch(() => undefined);
    const fp = sig?.structural?.est_footprint_bytes;
    if (typeof fp === 'number' && fp > 0) {
      bytes += fp;
      paths.push(r.filePath);
    }
  }
  return { bytes, paths };
}

/**
 * Probe the machine's free VRAM / RAM for the dynamic router.
 *
 * VRAM, in order of accuracy:
 *   1. `nvidia-smi memory.free` — already net of every resident process
 *      (the OS truth). Preferred.
 *   2. Fallback: detected TOTAL VRAM − Σ resident-model footprints.
 *      Used when nvidia-smi is absent (AMD/Intel/Apple) but we know the
 *      card's total size.
 *   3. Otherwise `undefined` — the router then scores fit on RAM alone.
 *
 * The user-tunable reserve (routingConfig) is subtracted on top of
 * BOTH paths: even nvidia-smi's "free" doesn't account for the runtime
 * overhead (KV cache, activations) of the model we're about to route.
 *
 * RAM uses `os.freemem()` (already live + net of everything) minus the
 * RAM reserve. It is effectively always known, so `freeRamBytes` is
 * defined (≥ 0) on every platform.
 */
export async function probeFreeMemory(
  deps: FreeMemoryDeps = {},
): Promise<FreeMemoryProbe> {
  const ex = deps.execAsync ?? execAsync;
  const fm = deps.freemem ?? os.freemem;
  const lr = deps.listRunning ?? listRunning;
  const ls = deps.loadSignature ?? loadSignature;
  const dhp = deps.detectHardwareProfile ?? detectHardwareProfile;
  const grc = deps.getRoutingConfig ?? getRoutingConfig;

  const cfg: RoutingConfig = await grc().catch(() => ({}));
  const reserves = effectiveReserves(cfg);

  // RAM — always available.
  const freeRamBytes = Math.max(fm() - reserves.ramReserveBytes, 0);

  // VRAM — nvidia-smi first.
  let vramSource: FreeMemoryProbe['vramSource'] = 'unknown';
  let residentModels: string[] = [];
  let freeVramBytes: number | undefined;

  const nv = await nvidiaFreeVramBytes(ex);
  if (typeof nv === 'number') {
    vramSource = 'nvidia-smi';
    freeVramBytes = Math.max(nv - reserves.vramReserveBytes, 0);
  } else {
    const profile = await dhp().catch(() => undefined);
    const totalVram = profile?.gpu?.vramBytes;
    if (typeof totalVram === 'number' && totalVram > 0) {
      const resident = await residentFootprint(lr(), ls);
      residentModels = resident.paths;
      vramSource = 'total-minus-resident';
      freeVramBytes = Math.max(
        totalVram - resident.bytes - reserves.vramReserveBytes,
        0,
      );
    }
  }

  return {
    freeVramBytes,
    freeRamBytes,
    vramSource,
    reserves,
    residentModels,
  };
}
