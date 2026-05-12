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

export function buildCommand(
  runner: RunnerConfig,
  modelPath: string,
  params: RunParams,
): BuildCommandResult {
  const args: string[] = ['-m', modelPath];
  if (typeof params.ngl === 'number') {
    args.push('--n-gpu-layers', String(params.ngl));
  }
  if (typeof params.ctx === 'number') {
    args.push('-c', String(params.ctx));
  }
  if (typeof params.threads === 'number') {
    args.push('-t', String(params.threads));
  }
  if (typeof params.batchSize === 'number') {
    args.push('-b', String(params.batchSize));
  }
  if (params.flashAttn) {
    args.push('--flash-attn');
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
