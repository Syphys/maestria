/**
 * Platform-specific GPU detection.
 *
 * Strategy (in order of accuracy):
 *   1. `nvidia-smi` — works on Windows, Linux, even some macOS rigs with
 *      eGPU; reports VRAM accurately for the full range
 *   2. Platform-native:
 *       - Windows: `Get-CimInstance Win32_VideoController` (note:
 *         AdapterRAM is uint32, wraps to wrong value for >4 GB cards
 *         not running through NVIDIA — best-effort)
 *       - macOS: `system_profiler SPDisplaysDataType -json` (gives
 *         VRAM as a string like "30 GB", parsed)
 *       - Linux: `lspci -v -d ::0300` (name only, no VRAM)
 *
 * Each path is fail-tolerant: a missing binary, a timeout, malformed
 * output → returns undefined and the next strategy is tried. The
 * caller treats `undefined` as "no GPU info" rather than an error.
 *
 * Detection is slow (50-1500ms depending on platform + driver), so the
 * caller (`detectHardwareProfile`) shouldn't call this on a hot path.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { GpuInfo } from '../../renderer/modelhub/hardware';

const execAsync = promisify(exec);

const EXEC_TIMEOUT_MS = 8_000;

async function detectGpuViaNvidiaSmi(): Promise<GpuInfo | undefined> {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      { timeout: EXEC_TIMEOUT_MS },
    );
    // First card wins — multi-GPU support is deferred.
    const line = stdout.trim().split('\n')[0]?.trim();
    if (!line) return undefined;
    const parts = line.split(',').map((s) => s.trim());
    const name = parts[0];
    const vramMiB = parseInt(parts[1] ?? '', 10);
    if (!name) return undefined;
    return {
      vendor: 'NVIDIA',
      name,
      vramBytes: Number.isFinite(vramMiB) ? vramMiB * 1024 * 1024 : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Inspect the Windows display-adapter registry class for the canonical
 * uint64 VRAM size. `Win32_VideoController.AdapterRAM` is a uint32 and
 * wraps for any card > 4 GiB (a 24 GiB RX 7900 XTX shows up as
 * "~4.3 GB", which is nonsense). The registry key
 * `HardwareInformation.qwMemorySize` is the same value as a uint64 and
 * doesn't wrap. NVIDIA + AMD + Intel drivers all populate it.
 */
async function detectGpuWindowsRegistry(): Promise<GpuInfo | undefined> {
  try {
    // ConvertTo-Json on a 0/1 length collection collapses to a single
    // object, not an array — we force `@($r)` so the parser path is
    // consistent. Sort descending so [0] is the highest-VRAM adapter
    // (= the discrete GPU on hybrid-graphics rigs).
    const ps =
      "$base='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';" +
      '$r=@();' +
      'Get-ChildItem $base -EA SilentlyContinue ' +
      "| Where-Object {$_.PSChildName -match '^\\d+$'} " +
      '| ForEach-Object {' +
      '  $p=Get-ItemProperty $_.PSPath -EA SilentlyContinue;' +
      "  if ($p -and $p.'HardwareInformation.qwMemorySize' -and $p.DriverDesc) {" +
      "    $r += [PSCustomObject]@{Name=$p.DriverDesc;VramBytes=[int64]$p.'HardwareInformation.qwMemorySize'}" +
      '  }' +
      '};' +
      '@($r) | Sort-Object VramBytes -Descending | ConvertTo-Json -Compress';
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "${ps}"`,
      {
        timeout: EXEC_TIMEOUT_MS,
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0) return undefined;
    const top = list[0];
    if (!top || typeof top !== 'object') return undefined;
    const vramBytes =
      typeof top.VramBytes === 'number'
        ? top.VramBytes
        : Number(top.VramBytes ?? 0);
    if (!Number.isFinite(vramBytes) || vramBytes <= 0) return undefined;
    const name = typeof top.Name === 'string' ? top.Name : undefined;
    // Cheap vendor inference from the friendly name — covers the three
    // shipping desktop GPU families.
    let vendor: string | undefined;
    if (name) {
      const low = name.toLowerCase();
      if (low.includes('nvidia') || low.includes('geforce')) vendor = 'NVIDIA';
      else if (low.includes('amd') || low.includes('radeon')) vendor = 'AMD';
      else if (low.includes('intel')) vendor = 'Intel';
    }
    return { vendor, name, vramBytes };
  } catch {
    return undefined;
  }
}

async function detectGpuWindowsWmi(): Promise<GpuInfo | undefined> {
  try {
    // -NoProfile keeps it fast (skips $PROFILE), ConvertTo-Json gives us
    // a parseable shape.
    const cmd =
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterCompatibility, AdapterRAM | ConvertTo-Json -Compress"';
    const { stdout } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS });
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0) return undefined;
    // Pick the highest AdapterRAM card — discrete GPU on hybrid rigs,
    // even though the value caps at ~4 GB.
    const sorted = [...list].sort(
      (a, b) => (b?.AdapterRAM ?? 0) - (a?.AdapterRAM ?? 0),
    );
    const top = sorted[0];
    return {
      vendor:
        typeof top?.AdapterCompatibility === 'string'
          ? top.AdapterCompatibility
          : undefined,
      name: typeof top?.Name === 'string' ? top.Name : undefined,
      // AdapterRAM is uint32. Values within ~0.5 GiB of 4 GiB are
      // suspect (real 4 GiB cards typically report ~3.95 GiB) — mark
      // them as unknown so the user reaches for the override field.
      vramBytes:
        typeof top?.AdapterRAM === 'number' &&
        top.AdapterRAM > 0 &&
        top.AdapterRAM < 4_000_000_000
          ? top.AdapterRAM
          : undefined,
    };
  } catch {
    return undefined;
  }
}

async function detectGpuWindows(): Promise<GpuInfo | undefined> {
  // Registry first — it has the canonical uint64 VRAM size. WMI is the
  // safety net for systems where the registry path doesn't surface
  // anything usable (unusual drivers, GPUs in passthrough, etc.).
  const fromRegistry = await detectGpuWindowsRegistry();
  if (fromRegistry) return fromRegistry;
  return detectGpuWindowsWmi();
}

interface SpdisplaysEntry {
  _name?: string;
  sppci_model?: string;
  sppci_vendor?: string;
  spdisplays_vram?: string;
  spdisplays_vram_shared?: string;
}

function parseAppleVramString(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2].toUpperCase() === 'GB' ? n * 1024 ** 3 : n * 1024 ** 2;
}

async function detectGpuMac(): Promise<GpuInfo | undefined> {
  try {
    const { stdout } = await execAsync(
      'system_profiler SPDisplaysDataType -json',
      { timeout: EXEC_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout);
    const arr: SpdisplaysEntry[] | undefined = parsed?.SPDisplaysDataType;
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const top = arr[0];
    const name = top.sppci_model ?? top._name;
    const vendor = top.sppci_vendor;
    // Apple Silicon: VRAM is unified memory; spdisplays_vram_shared
    // holds it. Discrete eGPUs use spdisplays_vram.
    const vramBytes =
      parseAppleVramString(top.spdisplays_vram) ??
      parseAppleVramString(top.spdisplays_vram_shared);
    if (!name && !vramBytes && !vendor) return undefined;
    return { vendor, name, vramBytes };
  } catch {
    return undefined;
  }
}

async function detectGpuLinux(): Promise<GpuInfo | undefined> {
  try {
    // 0300 is the PCI class for VGA-compatible controllers.
    const { stdout } = await execAsync('lspci -mm -d ::0300', {
      timeout: EXEC_TIMEOUT_MS,
    });
    const line = stdout.trim().split('\n')[0];
    if (!line) return undefined;
    // -mm output: "01:00.0 "VGA compatible controller" "NVIDIA Corporation" "TU102 [GeForce RTX 2080 Ti]" ...
    const fields = line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1));
    if (!fields || fields.length < 3) return undefined;
    return {
      vendor: fields[1],
      name: fields[2],
      // No reliable VRAM source without nvidia-smi or rocm-smi.
      vramBytes: undefined,
    };
  } catch {
    return undefined;
  }
}

export async function detectGpu(): Promise<GpuInfo | undefined> {
  // Always prefer nvidia-smi when available — most accurate VRAM value.
  const nv = await detectGpuViaNvidiaSmi();
  if (nv) return nv;

  if (process.platform === 'win32') return detectGpuWindows();
  if (process.platform === 'darwin') return detectGpuMac();
  return detectGpuLinux();
}
