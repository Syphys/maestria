/**
 * Probe `llama-fit-params --fit-print on` for a model + params and return
 * a structured per-device memory cost.
 *
 * The binary lives next to `llama-server` in every llama.cpp build, so we
 * derive its path by swapping the basename. When the binary is missing
 * (e.g. a slimmed-down distribution) the probe surfaces a typed error
 * instead of crashing — the renderer can fall back to the heuristic
 * autotune column.
 *
 * Output format (machine-readable, on stdout):
 *
 *     ROCm0 13247 2160 340
 *     Host  164    0   24
 *
 * one line per device, fields = name, model_mib, context_mib, compute_mib.
 * llama.cpp's wide human-readable breakdown goes to stderr; we ignore it.
 *
 * The probe loads the full weights into device memory, so it's measurably
 * slow (~5 s on a 16 GB model). Callers should debounce + show a spinner;
 * results are cached in the sidecar by the renderer.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import {
  FitProbeDevice,
  FitProbeResult,
  RunnerConfig,
  RunParams,
} from '../../../renderer/modelhub/types';

export interface FitProbeOk {
  ok: true;
  probe: FitProbeResult;
  /** Raw stderr — handy when the result looks off. */
  stderr?: string;
}

export interface FitProbeErr {
  ok: false;
  error: string;
  /** Raw stderr — surfaces diagnostic when the binary printed an error. */
  stderr?: string;
}

export type FitProbeOutcome = FitProbeOk | FitProbeErr;

/**
 * Hard cap on probe runtime. llama-fit-params normally finishes in <10 s
 * but a corrupted GGUF can hang on the metadata parse. Killing the child
 * is the only way to recover the worker, so we set a generous-but-finite
 * ceiling rather than letting the renderer wait forever.
 */
const PROBE_TIMEOUT_MS = 60_000;

function deriveProbeBinaryPath(runner: RunnerConfig): string {
  const dir = path.dirname(runner.path);
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(dir, `llama-fit-params${ext}`);
}

/**
 * Parse one stdout line: `<name> <model> <context> <compute>`.
 * Name can contain spaces only if llama.cpp's print pads with a single
 * trailing space; in practice device names are single tokens
 * ("ROCm0", "CUDA0", "Host"). Falls back to splitting from the right so
 * a multi-word name still leaves the three trailing numbers parseable.
 */
function parseDeviceLine(line: string): FitProbeDevice | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 4) return undefined;
  const compute = Number(parts[parts.length - 1]);
  const context = Number(parts[parts.length - 2]);
  const model = Number(parts[parts.length - 3]);
  if (
    !Number.isFinite(model) ||
    !Number.isFinite(context) ||
    !Number.isFinite(compute)
  ) {
    return undefined;
  }
  const name = parts.slice(0, parts.length - 3).join(' ');
  return { name, modelMiB: model, contextMiB: context, computeMiB: compute };
}

function summarize(devices: FitProbeDevice[]): {
  totalVramMiB?: number;
  hostMiB?: number;
} {
  let vram = 0;
  let host: number | undefined;
  for (const d of devices) {
    const isHost = /^host$/i.test(d.name);
    const total = d.modelMiB + d.contextMiB + d.computeMiB;
    if (isHost) host = (host ?? 0) + total;
    else vram += total;
  }
  return {
    totalVramMiB: vram > 0 ? vram : undefined,
    hostMiB: host,
  };
}

/**
 * Build the argv passed to llama-fit-params.
 *
 * Suggest mode (`suggest === true`): we want llama.cpp to *compute* the
 * best ngl/ctx/batch for the current hardware. Pass `--fit on` and DO
 * NOT pre-set those args — fit only adjusts unset values, so any
 * explicit number we send freezes that dimension. Verbose flag is added
 * so the stderr exposes the resolved n_ctx / n_batch / offloaded layers
 * lines we parse downstream.
 *
 * Validate mode (`suggest === false`): we want a memory cost prediction
 * for the user's specific tuning. Pass `--fit off` and forward the
 * explicit ngl/ctx/batch so the breakdown matches what'll run.
 *
 * `-n 0 -p x` short-circuits generation in both modes — only the load
 * phase + memory layout pass runs.
 */
function buildProbeArgs(
  modelPath: string,
  params: RunParams,
  suggest: boolean,
): string[] {
  const args = [
    '-m',
    modelPath,
    '--fit-print',
    'on',
    '-n',
    '0',
    '-p',
    'x',
    '-v',
  ];
  if (suggest) {
    args.push('--fit', 'on');
  } else {
    args.push('--fit', 'off');
    if (typeof params.ngl === 'number')
      args.push('--n-gpu-layers', String(params.ngl));
    if (typeof params.ctx === 'number') args.push('-c', String(params.ctx));
    if (typeof params.batchSize === 'number')
      args.push('-b', String(params.batchSize));
  }
  if (params.flashAttn) args.push('--flash-attn', 'on');
  return args;
}

/**
 * Pull ngl / ctx / batch values out of llama.cpp's stderr verbose output.
 * Patterns are stable across recent llama.cpp builds — these are the same
 * lines llama-server logs at startup, just earlier in the load pass.
 *
 * Matches `load_tensors: offloaded N/M layers to GPU` for ngl, then
 * `llama_context: n_ctx = N` and `llama_context: n_batch = N` for the
 * two memory knobs. Returns an undefined field when the pattern is
 * absent (older binary, parse mismatch) — UI falls back to heuristic.
 */
function parseResolvedParams(stderr: string): {
  ngl?: number;
  ctx?: number;
  batchSize?: number;
} {
  const out: { ngl?: number; ctx?: number; batchSize?: number } = {};
  const nglMatch = stderr.match(
    /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers\s+to\s+GPU/i,
  );
  if (nglMatch) {
    const offloaded = Number(nglMatch[1]);
    const total = Number(nglMatch[2]);
    if (Number.isFinite(offloaded) && Number.isFinite(total)) {
      // -1 in llama-server == "all". Surface that intent when offloaded
      // hit the ceiling so the editor row shows -1 instead of e.g. 25.
      out.ngl = offloaded >= total ? -1 : offloaded;
    }
  }
  const ctxMatch = stderr.match(/n_ctx\s*=\s*(\d+)/);
  if (ctxMatch) {
    const n = Number(ctxMatch[1]);
    if (Number.isFinite(n)) out.ctx = n;
  }
  const batchMatch = stderr.match(/n_batch\s*=\s*(\d+)/);
  if (batchMatch) {
    const n = Number(batchMatch[1]);
    if (Number.isFinite(n)) out.batchSize = n;
  }
  return out;
}

export interface ProbeOptions {
  /**
   * Suggest mode = ask llama-fit-params to compute the best ngl/ctx/batch.
   * Validate mode (`false`) = ask for the memory cost of the user's
   * explicit numbers. The renderer drives this: it sets `suggest: true`
   * the moment Auto-fit is toggled off so the Estimated column fills
   * with the runtime's own answers, then switches to validate mode
   * when the user starts overriding fields.
   */
  suggest: boolean;
}

export async function probeFitParams(
  runner: RunnerConfig,
  modelPath: string,
  params: RunParams,
  options: ProbeOptions,
): Promise<FitProbeOutcome> {
  const binary = deriveProbeBinaryPath(runner);
  try {
    await fs.access(binary);
  } catch {
    return {
      ok: false,
      error: `llama-fit-params not found next to runner (looked in ${binary})`,
    };
  }
  const args = buildProbeArgs(modelPath, params, options.suggest);

  return new Promise<FitProbeOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stderr });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          error: `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`,
          stderr,
        });
        return;
      }
      const devices: FitProbeDevice[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const dev = parseDeviceLine(line);
        if (dev) devices.push(dev);
      }
      if (devices.length === 0) {
        resolve({
          ok: false,
          error:
            code !== 0
              ? `llama-fit-params exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
              : 'no parseable device lines in stdout',
          stderr,
        });
        return;
      }
      const { totalVramMiB, hostMiB } = summarize(devices);
      const resolved = parseResolvedParams(stderr);
      const probe: FitProbeResult = {
        ranAt: new Date().toISOString(),
        runnerPath: runner.path,
        params: {
          ngl: params.ngl,
          ctx: params.ctx,
          batchSize: params.batchSize,
          flashAttn: params.flashAttn,
          fit: params.fit,
        },
        resolved:
          resolved.ngl !== undefined ||
          resolved.ctx !== undefined ||
          resolved.batchSize !== undefined
            ? resolved
            : undefined,
        devices,
        totalVramMiB,
        hostMiB,
      };
      resolve({ ok: true, probe, stderr });
    });
  });
}
