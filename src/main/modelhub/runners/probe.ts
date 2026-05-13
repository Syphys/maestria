/**
 * Spawn `<binary> --help` and parse the output into a `RunnerProbe`.
 *
 * llama.cpp's CLI surface has shifted across builds — early-2024 vanilla
 * accepted bare `--flash-attn`, late-2025 added 3-state `--flash-attn
 * [on|off|auto]`, ik_llama.cpp forks track upstream loosely with their
 * own quirks. Emitting the wrong syntax crashes the server at boot
 * ("unknown value for --flash-attn: '--mlock'"), so we sniff the help
 * text once at register time and let `buildCommand` adapt.
 *
 * Parsing strategy: scan stderr+stdout for lines that start with `-X,`
 * or `-X<TAB>` or `--Y` patterns. For the two flags that matter most
 * (`--flash-attn`, `--fit`), inspect the suffix on their advertised
 * line to figure out which value form the binary accepts.
 *
 * The probe is cheap (~200 ms) but it does spawn a child process, so
 * we cache the result in the registry and only re-run on user demand.
 */

import { spawn } from 'child_process';
import { RunnerProbe, FlagSyntax } from '../../../renderer/modelhub/types';

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Capture stdout + stderr of `bin --help` into a single string.
 * llama.cpp writes its help to stdout, but some older forks dump it
 * on stderr. We capture both and merge.
 */
async function runHelp(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let timedOut = false;
    const child = spawn(bin, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
      buf += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`--help timed out after ${PROBE_TIMEOUT_MS}ms`));
        return;
      }
      // Some binaries exit non-zero from --help (printed help, then
      // refused to run with no model arg). We still want the captured
      // output — only fail if the buffer is empty.
      if (!buf.trim()) {
        reject(new Error(`--help produced no output (exit ${code})`));
        return;
      }
      resolve(buf);
    });
  });
}

/**
 * Best-effort version extraction. llama.cpp prints a banner line on
 * stderr at startup like `build: 4567 (abc1234)`; the same banner is
 * usually visible at the top of `--help` for forks. We deliberately
 * skip looser fallbacks like `\bversion (\S+)` because the help text
 * also documents the `--version` flag itself ("--version  show version
 * and build info") — that fallback would capture "show" as the version.
 */
function extractVersion(help: string): string | undefined {
  // Common patterns: "build: 4567 (abc1234)", "build 4567 (commit)".
  const buildMatch = help.match(/\bbuild[:\s]+(\d+)(?:\s*\(([^)]+)\))?/i);
  if (buildMatch) {
    return buildMatch[2]
      ? `build ${buildMatch[1]} (${buildMatch[2]})`
      : `build ${buildMatch[1]}`;
  }
  return undefined;
}

/**
 * Pull every long-flag (`--foo-bar`) advertised in the help text.
 * Lowercases for stable lookup. Misses flags that only appear as
 * short aliases (`-fa`) without the long form — fine for our use,
 * we always check the canonical `--flash-attn` etc.
 */
function extractFlags(help: string): string[] {
  const set = new Set<string>();
  // Match --flag or --flag-with-dashes, stopping at whitespace,
  // bracket, comma, equals, or argument descriptor.
  const re = /--[a-z][a-z0-9-]+/gi;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(help))) {
    set.add(m[0].toLowerCase());
  }
  return Array.from(set).sort();
}

/**
 * Find the line documenting a specific long flag and inspect the
 * suffix to decide how to emit the flag at launch time.
 *
 * Patterns:
 *   `--flash-attn [on|off|auto]` → on-off-auto
 *   `--flash-attn [on|off]`      → on-off
 *   `--flash-attn`               → bare (line ends with the flag, no value)
 *   not in help                  → absent
 */
function detectFlagSyntax(help: string, longFlag: string): FlagSyntax {
  // Build a regex that matches the line introducing the flag. We're
  // lenient about column alignment because llama.cpp's help table
  // uses arbitrary spacing.
  const escaped = longFlag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture up to end-of-line or two spaces (which marks the
  // help-text column in llama.cpp's two-column layout).
  const re = new RegExp(
    `${escaped}\\s*(\\[[^\\]]+\\]|[A-Z][A-Z_0-9]*)?(\\s{2,}|$)`,
    'm',
  );
  const m = help.match(re);
  if (!m) return 'absent';
  const valueDescriptor = m[1];
  if (!valueDescriptor) return 'bare';
  const lower = valueDescriptor.toLowerCase();
  if (lower.includes('auto')) return 'on-off-auto';
  if (/on\s*\|\s*off/.test(lower)) return 'on-off';
  // Some flags take an arg that isn't on/off (e.g. `MODEL_FILE`,
  // `MIB0,MIB1,…`). Treat as "needs a value" — we tag it on-off so
  // buildCommand at least appends an explicit value rather than
  // assuming bare-bool. The on-off vs on-off-auto distinction only
  // matters for `--flash-attn` and `--fit` today.
  return 'on-off';
}

/** Safety cap on the persisted help text. Real outputs run ~30-80 KB;
 * anything beyond a few hundred KB is almost certainly a runaway and
 * not worth carrying around in the registry JSON. */
const HELP_TEXT_MAX_BYTES = 200_000;

export async function probeRunner(binPath: string): Promise<RunnerProbe> {
  const help = await runHelp(binPath);
  const flagsKnown = extractFlags(help);
  const helpText =
    help.length > HELP_TEXT_MAX_BYTES
      ? `${help.slice(0, HELP_TEXT_MAX_BYTES)}\n…[truncated]`
      : help;
  return {
    probedAt: new Date().toISOString(),
    version: extractVersion(help),
    helpText,
    flagsKnown,
    quirks: {
      flashAttn: detectFlagSyntax(help, '--flash-attn'),
      fit: detectFlagSyntax(help, '--fit'),
    },
  };
}

/**
 * Convenience: probe but swallow errors into a typed result rather
 * than throwing. Used by the registry's lazy-probe path so a single
 * broken runner doesn't poison the whole list-load.
 */
export async function tryProbeRunner(
  binPath: string,
): Promise<RunnerProbe | undefined> {
  try {
    return await probeRunner(binPath);
  } catch (e) {
    console.warn(
      '[modelhub] runner probe failed for',
      binPath,
      '-',
      (e as Error).message,
    );
    return undefined;
  }
}
