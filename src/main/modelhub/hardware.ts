/**
 * Hardware profile resolver — merges the platform detection with the
 * persisted user override.
 *
 * Two entry points the rest of the app uses:
 *
 *  - `detectHardwareProfile()` returns the *effective* profile (override
 *    fields applied on top of detection). This is what `autotune` and
 *    the MCP `hardware.detect` tool see.
 *  - `detectRawHardwareProfile()` returns the detection result alone,
 *    no override applied. The Settings UI uses this to render the
 *    "Detected" read-only line next to the override editor.
 *
 * GPU detection delegated to `hardwareDetect.ts`; override persistence
 * in `hardwareOverride.ts`. RAM + CPU come from Node's `os` module —
 * reliable cross-platform without spawning subprocesses.
 */

import os from 'os';
import { GpuInfo, HardwareProfile } from '../../renderer/modelhub/hardware';
import { detectGpu } from './hardwareDetect';
import {
  HardwareOverride,
  getOverride,
  hasAnyOverride,
} from './hardwareOverride';

function mergeGpu(
  detected: GpuInfo | undefined,
  override: HardwareOverride,
): GpuInfo | undefined {
  const gpuOverridden =
    !!override.vendor || !!override.name || !!override.vramBytes;
  if (!detected && !gpuOverridden) return undefined;
  return {
    vendor: override.vendor ?? detected?.vendor,
    name: override.name ?? detected?.name,
    vramBytes: override.vramBytes ?? detected?.vramBytes,
  };
}

export async function detectHardwareProfile(): Promise<HardwareProfile> {
  const override = await getOverride();
  const detectedGpu = await detectGpu();
  const gpu = mergeGpu(detectedGpu, override);
  return {
    source: hasAnyOverride(override) ? 'manual' : 'detected',
    ramBytes: override.ramBytes ?? os.totalmem(),
    freeRamBytes: os.freemem(),
    cpu: { model: os.cpus()?.[0]?.model, cores: os.cpus()?.length },
    gpu,
    detectedAt: new Date().toISOString(),
  };
}

export async function detectRawHardwareProfile(): Promise<HardwareProfile> {
  const detectedGpu = await detectGpu();
  return {
    source: 'detected',
    ramBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    cpu: { model: os.cpus()?.[0]?.model, cores: os.cpus()?.length },
    gpu: detectedGpu,
    detectedAt: new Date().toISOString(),
  };
}
