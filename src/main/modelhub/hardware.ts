/**
 * Hardware detection — Phase 3 placeholder.
 *
 * Returns the data we can read trivially today (RAM/CPU from `os` module).
 * GPU detection is intentionally NOT wired yet: it requires per-OS calls
 * (`nvidia-smi`, DXGI on Windows, `system_profiler` on macOS, `lspci` on Linux)
 * and benches better in Phase 3 alongside the run-fit estimator.
 *
 * The renderer hook (`fetchHardwareProfile`) and the IPC channel are in place
 * so UI components can already call the function. They get a partial profile
 * (RAM only) for now and graceful undefined for GPU.
 */

import os from 'os';
import { HardwareProfile } from '../../renderer/modelhub/hardware';

export async function detectHardwareProfile(): Promise<HardwareProfile> {
  const profile: HardwareProfile = {
    source: 'detected',
    ramBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    cpu: {
      model: os.cpus()?.[0]?.model,
      cores: os.cpus()?.length,
    },
    detectedAt: new Date().toISOString(),
  };
  // GPU detection deferred to Phase 3. Intentionally left undefined so callers
  // know the profile is partial.
  return profile;
}
