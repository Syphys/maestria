/**
 * Parse llama.cpp / llama-server `--help` output into a structured
 * per-flag list. Drives the structured form in `AdvancedParamsDialog`:
 * lets the user pick from every flag the binary advertises, with the
 * default value pre-filled, instead of having to memorize syntax.
 *
 * Help format (two-column, fixed-width):
 *
 *     -fa,   --flash-attn [on|off|auto]       set Flash Attention use
 *                                             ('on', 'off', or 'auto',
 *                                             default: 'auto')
 *                                             (env: LLAMA_ARG_FLASH_ATTN)
 *     -c,    --ctx-size N                     size of the prompt context
 *                                             (default: 0, 0 = loaded
 *                                             from model)
 *
 * The parser is line-oriented + tolerant: continuation lines (indented
 * past column ~30) extend the description of the previous flag; the
 * env-var line is captured separately; unknown shapes are skipped
 * rather than throwing.
 *
 * Pure, no IO. Safe to call on any string.
 */

export type FlagValueKind =
  | 'bool-bare'
  | 'bool-on-off'
  | 'bool-on-off-auto'
  | 'number'
  | 'string'
  | 'unknown';

export interface ParsedFlag {
  /** Long flag (canonical), e.g. `--flash-attn`. Lowercased. */
  flag: string;
  /** Short alias when advertised (e.g. `-fa`). Undefined when no alias. */
  shortFlag?: string;
  /** Value descriptor as printed in help (`[on|off|auto]`, `N`, `FNAME`). */
  valueDescriptor?: string;
  /** Inferred type for the value input. */
  kind: FlagValueKind;
  /** Default value parsed from "(default: X)" in the description. */
  defaultValue?: string;
  /** Allowed values when the descriptor lists them (e.g. ['on','off','auto']). */
  choices?: string[];
  /** Free-form description text, possibly multi-line collapsed to one. */
  description: string;
  /** Environment variable when advertised on a `(env: VAR)` line. */
  envVar?: string;
}

/**
 * Decide how to render the value input from the descriptor + the
 * raw line content. Conservative — falls through to 'string' or
 * 'unknown' rather than guessing wrong (which would silently corrupt
 * the launch command).
 */
function classifyDescriptor(descriptor: string | undefined): {
  kind: FlagValueKind;
  choices?: string[];
} {
  if (!descriptor) return { kind: 'bool-bare' };
  const inside = descriptor.replace(/^\[|\]$/g, '').trim();
  // "on|off|auto" or "on|off"
  if (/^on\s*\|\s*off(\s*\|\s*auto)?$/i.test(inside)) {
    const choices = inside
      .split('|')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return {
      kind: choices.length === 3 ? 'bool-on-off-auto' : 'bool-on-off',
      choices,
    };
  }
  // Generic "|"-separated choice list (e.g. "linear|yarn|none").
  if (inside.includes('|')) {
    const choices = inside
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (choices.length >= 2 && choices.every((c) => /^[a-z0-9_-]+$/i.test(c))) {
      return { kind: 'string', choices };
    }
  }
  // Single uppercase token = number-or-string. `N`, `MIB`, `PORT`
  // are numbers; `FNAME`, `PATH`, `MODEL`, `PROMPT` are strings.
  if (/^[A-Z][A-Z0-9_]*$/.test(inside)) {
    if (/^(N|MIB|PORT|SIZE|COUNT|MS|SEC|HZ|TEMP|BIAS)$/i.test(inside)) {
      return { kind: 'number' };
    }
    return { kind: 'string' };
  }
  // Comma-separated (e.g. `MIB0,MIB1,MIB2,...`)
  if (/[A-Z0-9_,…]/.test(inside)) return { kind: 'string' };
  return { kind: 'unknown' };
}

function extractDefault(description: string): string | undefined {
  // Match "default: 'foo'", "default: foo", "default: foo, ..."
  const m = description.match(
    /default[:\s]+(?:'([^']*)'|"([^"]*)"|([^,)\s]+))/i,
  );
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

/** Line shape: optional short flag, then long flag, then optional value descriptor, then description. */
const FLAG_LINE_RE =
  /^\s*(?:(-[A-Za-z]+),\s+)?(--[a-z][a-z0-9-]+)(?:\s+(\[[^\]]+\]|[A-Z][A-Z0-9_,…]*))?(?:\s{2,}(.+))?$/;

const ENV_LINE_RE = /^\s+\(env:\s*([A-Z_][A-Z0-9_]*)\)\s*$/;

export function parseHelpText(help: string): ParsedFlag[] {
  if (!help) return [];
  const lines = help.split(/\r?\n/);
  const flags: ParsedFlag[] = [];
  let current: ParsedFlag | undefined;
  /** Column at which descriptions start on the previous flag line — used
   * to detect continuation lines (those that indent past this column). */
  let descColumn = 0;

  const finalize = () => {
    if (!current) return;
    current.description = current.description.replace(/\s+/g, ' ').trim();
    const def = extractDefault(current.description);
    if (def) current.defaultValue = def;
    flags.push(current);
    current = undefined;
  };

  for (const line of lines) {
    if (!line.trim()) {
      // Blank line ends the current flag block.
      finalize();
      continue;
    }
    const envMatch = line.match(ENV_LINE_RE);
    if (envMatch && current) {
      current.envVar = envMatch[1];
      continue;
    }
    const flagMatch = line.match(FLAG_LINE_RE);
    if (flagMatch) {
      finalize();
      const [, shortFlag, longFlag, descriptor, desc] = flagMatch;
      const { kind, choices } = classifyDescriptor(descriptor);
      current = {
        flag: longFlag.toLowerCase(),
        shortFlag: shortFlag,
        valueDescriptor: descriptor,
        kind,
        choices,
        description: (desc ?? '').trim(),
      };
      descColumn = line.indexOf(descriptor ? descriptor : longFlag) + 30;
      continue;
    }
    // Continuation line: significant leading whitespace + we have a
    // current flag to append to.
    if (current && /^\s{6,}/.test(line)) {
      current.description += ' ' + line.trim();
      // Width-based heuristic — keep descColumn used (silence noUnused).
      void descColumn;
    }
  }
  finalize();
  return flags;
}

/** Stable lookup helper. */
export function parsedFlagByName(
  flags: ParsedFlag[],
  name: string,
): ParsedFlag | undefined {
  const lower = name.toLowerCase();
  return flags.find((f) => f.flag === lower);
}
