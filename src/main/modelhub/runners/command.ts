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

import {
  FlagSyntax,
  RunnerConfig,
  RunParams,
} from '../../../renderer/modelhub/types';

export interface BuildCommandResult {
  command: string[];
  /** Server URL the user can hit, when applicable. */
  url?: string;
  warnings?: string[];
}

/**
 * Emit a tri-state flag with the syntax the runner advertises in its
 * `--help` output. When `syntax === 'absent'` we drop the flag entirely
 * (emitting an unknown flag to llama-server crashes the boot with
 * "unknown argument"). `'bare'` keeps the legacy no-value form for
 * binaries that pre-date the on/off variant. Returns a tuple to append.
 */
function emitTriState(
  flag: string,
  value: boolean,
  syntax: FlagSyntax | undefined,
  warnings: string[],
): string[] {
  if (syntax === 'absent') {
    if (value) {
      warnings.push(
        `${flag} requested but the runner doesn't advertise it — skipping`,
      );
    }
    return [];
  }
  if (!value) {
    // `off` semantics depend on syntax. Bare-bool: omit. on-off / on-off-auto:
    // explicit `off`. Omitting on the explicit variants is also valid
    // (the binary defaults), so we leave it off.
    return [];
  }
  if (syntax === 'bare' || syntax === undefined) return [flag];
  return [flag, 'on'];
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
  const warnings: string[] = [];

  // Pull the quirk profile from the probe. When no probe is on file
  // (legacy runner created before 4.0.28) we fall back to current
  // upstream syntax: `--flash-attn on` and `--fit on` — wrong only
  // for very old binaries, which we accept as a residual papercut.
  const flashAttnSyntax: FlagSyntax =
    runner.probed?.quirks.flashAttn ?? 'on-off-auto';
  const fitSyntax: FlagSyntax = runner.probed?.quirks.fit ?? 'on-off';

  // --fit on tells llama-server to size ngl / ctx / batch-size itself
  // from free VRAM at boot. It only fills in UNSET memory args, so when
  // fit is on we must NOT emit --n-gpu-layers / -c / -b — sending them
  // explicitly would nullify the fit pass on those fields. Threads,
  // flash-attn, mlock, host, port are orthogonal and stay.
  const fitOn = params.fit === true && fitSyntax !== 'absent';
  if (fitOn) {
    args.push(...emitTriState('--fit', true, fitSyntax, warnings));
    args.push(...SINGLE_GPU_ARGS);
  } else {
    if (params.fit === true && fitSyntax === 'absent') {
      warnings.push(
        '--fit requested but this runner does not support it — falling back to explicit ngl/ctx/batch',
      );
    }
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
  // Honour the probed flash-attn syntax — bare for early-2024, explicit
  // on/off/auto for late-2025. emitTriState drops the flag entirely
  // when the runner doesn't advertise it (warning collected).
  args.push(
    ...emitTriState(
      '--flash-attn',
      !!params.flashAttn,
      flashAttnSyntax,
      warnings,
    ),
  );
  if (params.mlock) {
    args.push('--mlock');
  }
  // llama-server binds an HTTP port; llama-cli is interactive only.
  const isServer = runner.path.toLowerCase().includes('server');
  if (isServer) {
    args.push('--host', '127.0.0.1', '--port', String(params.port ?? 8080));
    // Push the server-side read/write timeout to "effectively
    // forever" (24 h) — llama.cpp PR #22907 added `--timeout N`
    // with a 600 s default that silently cancels long completions
    // (the response comes back 200 with empty content, surfacing
    // as `(empty)` in the characterization tab for long reasoning
    // prompts). The flag's semantics are `N seconds`, so `0` does
    // NOT mean "disabled" — it means "0 seconds = immediate kill".
    // 86 400 s = 24 h is enough for any plausible characterization
    // chat (a 31B Q6 multistep prompt tops out around 4 min).
    // Users can override with their own `--timeout` value via
    // customArgs (pushed AFTER this default).
    args.push('--timeout', '86400');
  }
  // Custom user args from the "Advanced parameters" dialog. Parsed
  // line-by-line so the user can stack arbitrary flags llama-server
  // accepts but our editor doesn't expose as a dedicated row. Pushed
  // AFTER `--timeout 0` so a user-supplied `--timeout N` wins.
  if (params.customArgs) {
    const parsed = parseCustomArgs(params.customArgs);
    args.push(...parsed.args);
    if (parsed.warnings.length > 0) warnings.push(...parsed.warnings);
  }
  return {
    command: [runner.path, ...args],
    url: isServer ? `http://127.0.0.1:${params.port ?? 8080}` : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Tokenize the multi-line `customArgs` field into a flat argv list.
 *
 * Format:
 *   - one "--flag [value]" per line
 *   - lines starting with `#` (after trimming) are comments
 *   - empty lines ignored
 *   - whitespace inside a value is preserved by splitting on the
 *     FIRST whitespace only (so `--system "You are X"` stays one
 *     argument, no shell-quoting required)
 *
 * Returns a flat args list (the spawn call does not need quoting)
 * plus warnings for lines that don't start with `-` (probable typos).
 */
export function parseCustomArgs(raw: string): {
  args: string[];
  warnings: string[];
} {
  const args: string[] = [];
  const warnings: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    // Split on the first whitespace run; everything after is the value
    // (preserved verbatim, including embedded spaces).
    const ws = line.search(/\s/);
    const flag = ws === -1 ? line : line.slice(0, ws);
    const value = ws === -1 ? undefined : line.slice(ws).trim();
    if (!flag.startsWith('-')) {
      warnings.push(
        `custom arg "${flag}" doesn't start with - or -- — skipping`,
      );
      continue;
    }
    args.push(flag);
    if (value && value.length > 0) args.push(value);
  }
  return { args, warnings };
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
