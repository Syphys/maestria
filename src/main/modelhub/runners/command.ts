/**
 * Build the command-line invocation for a llama.cpp binary + model + params.
 *
 * Models Hub targets the llama.cpp family exclusively (llama.cpp proper +
 * forks like ik_llama.cpp that ship the same `llama-server` flag surface),
 * so there is no per-runner dispatch any more — one builder fits all.
 *
 * The output is `[binary, ...args]` so it's both:
 *  - directly spawnable via child_process.spawn (no shell, no quoting bugs)
 *  - and trivially serializable to a copy-paste-friendly string with proper
 *    quoting (see `formatCommandForShell`).
 *
 * `safetensors` files: llama.cpp can only ingest them via the `--hf` flag or
 * after conversion. For now we still build a command but tag it with a
 * warning the UI can surface.
 */

import { RunnerConfig, RunParams } from '../../../renderer/modelhub/types';

export interface BuildCommandResult {
  command: string[];
  /** Server URL the user can hit, when applicable. */
  url?: string;
  warnings?: string[];
}

/**
 * Single-GPU pinning args. Without them llama.cpp's default `--split-mode
 * layer` spreads tensors across every visible adapter, which crashes on
 * heterogeneous boxes (e.g. AMD dGPU + iGPU compiled only for the dGPU's
 * gfx target) with "invalid kernel file", and triggers the
 * GGML_SCHED_MAX_SPLIT_INPUTS=10 assert in ik_llama when FA is on.
 * `--tensor-split 1,0,0,…` is the unambiguous knob — surplus values are
 * harmless on systems with fewer GPUs. Configurable per-runner policy
 * lands with 4.0.16.
 */
const SINGLE_GPU_ARGS = [
  '--tensor-split',
  '1,0,0,0,0,0,0,0',
  '--split-mode',
  'none',
  '--main-gpu',
  '0',
];

export function buildCommand(
  runner: RunnerConfig,
  modelPath: string,
  params: RunParams,
): BuildCommandResult {
  const args: string[] = ['-m', modelPath];

  // --fit on tells llama-server to size ngl / ctx / batch-size itself
  // from free VRAM at boot. It only fills in UNSET memory args, so when
  // fit is on we must NOT emit --n-gpu-layers / -c / -b — sending them
  // explicitly would nullify the fit pass on those fields. Threads,
  // flash-attn, mlock, host, port are orthogonal and stay.
  const fitOn = params.fit === true;
  if (fitOn) {
    args.push('--fit', 'on');
    args.push(...SINGLE_GPU_ARGS);
  } else {
    if (typeof params.ngl === 'number') {
      args.push('--n-gpu-layers', String(params.ngl));
      if (params.ngl > 0) {
        args.push(...SINGLE_GPU_ARGS);
      }
    }
    if (typeof params.ctx === 'number') {
      args.push('-c', String(params.ctx));
    }
    if (typeof params.batchSize === 'number') {
      args.push('-b', String(params.batchSize));
    }
  }
  if (typeof params.threads === 'number') {
    args.push('-t', String(params.threads));
  }
  if (params.flashAttn) {
    // Recent llama.cpp builds (late 2025+) made `--flash-attn` a
    // 3-state option: `on|off|auto`. A bare `--flash-attn` consumes
    // the NEXT positional as its value and crashes
    // ("unknown value for --flash-attn: '--mlock'"). Always emit the
    // explicit value — older binaries that took it as bare boolean
    // are out of scope at this point.
    args.push('--flash-attn', 'on');
  }
  if (params.mlock) {
    args.push('--mlock');
  }
  // llama-server binds an HTTP port; llama-cli is interactive only.
  const isServer = runner.path.toLowerCase().includes('server');
  if (isServer) {
    args.push('--host', '127.0.0.1', '--port', String(params.port ?? 8080));
  }
  return {
    command: [runner.path, ...args],
    url: isServer ? `http://127.0.0.1:${params.port ?? 8080}` : undefined,
  };
}

/**
 * Quote the command for a shell so the user can paste it. Uses platform
 * conventions: PowerShell-friendly on Windows (single quotes for paths
 * with spaces), POSIX shell quoting elsewhere.
 */
export function formatCommandForShell(cmd: string[]): string {
  const isWin = process.platform === 'win32';
  return cmd
    .map((arg) => {
      if (!arg) return '""';
      if (isWin) {
        // PowerShell single-quote rules: any ' becomes ''.
        if (/[\s"'`$&|;()<>]/.test(arg)) {
          return `'${arg.replace(/'/g, "''")}'`;
        }
        return arg;
      }
      if (/[\s"'`$&|;()<>\\!]/.test(arg)) {
        return `'${arg.replace(/'/g, `'\\''`)}'`;
      }
      return arg;
    })
    .join(' ');
}
