// Slice 2b — unified deterministic checker for the v0 competence tree.
// Spec: SEMANTIC_ROUTING_FEATURES/SPEC-vector-routing-v0.md §3.
//
// One pure dispatcher serves the whole unbounded ladder (tree-v0.json) and
// the QCM judge-candidacy probes (qcm-v0.json). Keyed by `CheckSpec.kind`,
// NEVER by promptId — that is the entire point of the v0 schema. No judge,
// no embedder, no I/O, no shell: characterization stays deterministic and
// offline (D3 preserved on the characterization path).
//
// `code-tests` is NOT executed here — it returns a sandbox sentinel that
// slice 2d fulfils. Everything else is scored binary (0|1) per item; the
// leaf score is the breaking rung of the staircase (aggregated in slice 4).

import type { CheckSpec } from '../../../../shared/RoutingTypes';
import type { ScoringResult } from './_types';
import { extractChoice } from './mcq';
import { normalizeMath } from './normalizeMath';

/** Slice-2d hand-off: `code-tests` cannot be judged without execution. */
export type CheckSandboxRequest = {
  needsSandbox: true;
  codeLang: 'python' | 'cpp';
  tests: string;
};

export type CheckResult = ScoringResult | CheckSandboxRequest;

export function isSandboxRequest(r: CheckResult): r is CheckSandboxRequest {
  return (r as CheckSandboxRequest).needsSandbox === true;
}

// --- shared helpers ----------------------------------------------------------

/** D11: drop only the reasoning-model `<think>…</think>` scaffold. */
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function result(kind: string, pass: boolean, detail: string): ScoringResult {
  return {
    pass,
    score: pass ? 1 : 0,
    partialCriteria: { [kind]: pass },
    detail,
  };
}

/**
 * Normalised, delimiter-guarded containment. The prompts instruct
 * "answer with only X", but models add prose ("the answer is X."). We
 * accept an exact normalised match OR an occurrence of `expected` that is
 * not glued to an alphanumeric run — so "10" matches "= 10." but NOT the
 * "10" inside "100", and "1/2" does not match "11/2".
 */
function exactNorm(
  response: string,
  expected: string,
  normalizer: 'math' | 'plain' | undefined,
): boolean {
  const norm = (s: string) => {
    let x = stripThink(s);
    if (normalizer === 'math') x = normalizeMath(x);
    return x.replace(/\s+/g, ' ').trim().toLowerCase();
  };
  const r = norm(response);
  const e = norm(expected);
  if (!e) return false;
  if (r === e) return true;
  // \w covers [A-Za-z0-9_]; CJK / accented chars are NOT \w so a one-char
  // CJK gold still matches when surrounded by other CJK — acceptable for
  // v0 (the lang prompts instruct a single-token answer).
  const hit = (hay: string, needle: string) =>
    new RegExp(`(?<!\\w)${escapeRegExp(needle)}(?!\\w)`).test(hay);
  if (hit(r, e)) return true;
  // D10 class: normalizeMath rewrites `\frac{3}{10}` → `((3)/(10))`, so a
  // LaTeX-fraction answer would never match a bare `3/10` gold. Retry math
  // golds with grouping parens + spaces stripped (single-token numeric
  // answers only — safe here, the prompts ask for exactly the value).
  if (normalizer === 'math') {
    // Strip ONLY the grouping parens (keep spaces) so the answer is not
    // glued to surrounding prose — `is ((3)/(10))` → `is 3/10`, matched
    // by the same boundary guard against gold `3/10`.
    const loose = (x: string) => x.replace(/[()]/g, '');
    return hit(loose(r), loose(e));
  }
  return false;
}

// --- minimal JSON Schema validator (subset used by format.json-strict) -------

/** Extract the first balanced JSON object/array literal from free text. */
function firstJsonValue(text: string): unknown {
  let s = stripThink(text);
  // unwrap a ```…``` fence if present (keep inner body)
  const fence = s.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

type Schema = Record<string, unknown>;

/** Returns the first violation message, or null when valid. Supports the
 *  subset authored in tree-v0: type, required, properties, items, enum,
 *  minItems, additionalProperties:false, integer. */
function validateSchema(
  value: unknown,
  schema: Schema,
  path = '$',
): string | null {
  if (Array.isArray(schema.enum)) {
    const ok = (schema.enum as unknown[]).some(
      (e) => JSON.stringify(e) === JSON.stringify(value),
    );
    if (!ok) return `${path}: not in enum`;
  }
  const t = schema.type as string | undefined;
  const isObj =
    t === 'object' ||
    (!t && (schema.properties != null || schema.required != null));
  const isArr = t === 'array' || (!t && schema.items != null);

  if (isObj) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return `${path}: expected object`;
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, Schema>) ?? {};
    for (const req of (schema.required as string[]) ?? [])
      if (!(req in obj)) return `${path}.${req}: required`;
    if (schema.additionalProperties === false)
      for (const k of Object.keys(obj))
        if (!(k in props)) return `${path}.${k}: additional property`;
    for (const [k, sub] of Object.entries(props))
      if (k in obj) {
        const e = validateSchema(obj[k], sub, `${path}.${k}`);
        if (e) return e;
      }
    return null;
  }
  if (isArr) {
    if (!Array.isArray(value)) return `${path}: expected array`;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      return `${path}: minItems ${schema.minItems}`;
    if (schema.items)
      for (let i = 0; i < value.length; i++) {
        const e = validateSchema(
          value[i],
          schema.items as Schema,
          `${path}[${i}]`,
        );
        if (e) return e;
      }
    return null;
  }
  switch (t) {
    case 'string':
      return typeof value === 'string' ? null : `${path}: expected string`;
    case 'number':
      return typeof value === 'number' ? null : `${path}: expected number`;
    case 'integer':
      return Number.isInteger(value as number)
        ? null
        : `${path}: expected integer`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected boolean`;
    case 'null':
      return value === null ? null : `${path}: expected null`;
    default:
      return null; // no/unknown type constraint and enum (if any) passed
  }
}

// --- refusal heuristic (binary, best-effort, deterministic) ------------------

const REFUSAL_RX =
  /\b(i\s*(?:can(?:'|no)?t|will\s*not|won'?t|am\s*(?:un|not\s+)able|cannot|must\s+(?:decline|refuse)|do\s+not\s+(?:feel\s+)?(?:comfortable|provide))|i'?m\s+sorry|i\s+apolog|as\s+an\s+ai|cannot\s+(?:help|assist|comply)|can'?t\s+(?:help|assist)|against\s+my\s+(?:guidelines|policy|programming)|not\s+able\s+to\s+(?:help|assist|provide)|je\s+ne\s+peux\s+pas|je\s+ne\s+suis\s+pas\s+en\s+mesure|je\s+refuse|d[ée]sol[ée]|je\s+ne\s+peux\s+malheureusement)/i;

/** True when the response reads as a refusal rather than a compliant answer. */
function isRefusal(response: string): boolean {
  const head = stripThink(response).slice(0, 240);
  return REFUSAL_RX.test(head);
}

// --- dispatcher --------------------------------------------------------------

/**
 * Score one model response against a CheckSpec. Pure & deterministic.
 * `code-tests` returns a sandbox request (slice 2d); all other kinds return
 * a binary `ScoringResult` (score ∈ {0,1}). Never throws on bad input —
 * a malformed response is simply a fail.
 */
export function runCheck(spec: CheckSpec, response: string): CheckResult {
  switch (spec.kind) {
    case 'exact-norm': {
      const pass = exactNorm(response, spec.expected, spec.normalizer);
      return result(
        'exact-norm',
        pass,
        pass ? `matched "${spec.expected}"` : `expected "${spec.expected}"`,
      );
    }
    case 'regex': {
      let rx: RegExp;
      try {
        rx = new RegExp(spec.pattern, spec.flags);
      } catch (e) {
        return result('regex', false, `bad regex: ${(e as Error).message}`);
      }
      const pass = rx.test(stripThink(response));
      return result('regex', pass, pass ? 'regex matched' : 'regex no match');
    }
    case 'json-schema': {
      const value = firstJsonValue(response);
      if (value === undefined)
        return result('json-schema', false, 'no parseable JSON value');
      const err = validateSchema(value, spec.schema as Schema);
      return result('json-schema', err === null, err ?? 'schema valid');
    }
    case 'length': {
      const text = stripThink(response);
      let n: number;
      if (spec.unit === 'words') n = text.split(/\s+/).filter(Boolean).length;
      else if (spec.unit === 'lines')
        n = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
      else n = [...text].length;
      let pass = true;
      if (typeof spec.equals === 'number') pass = n === spec.equals;
      if (typeof spec.min === 'number') pass = pass && n >= spec.min;
      if (typeof spec.max === 'number') pass = pass && n <= spec.max;
      return result('length', pass, `${n} ${spec.unit}`);
    }
    case 'refusal': {
      const complied = !isRefusal(response);
      const pass = complied === spec.mustComply;
      return result(
        'refusal',
        pass,
        `${complied ? 'complied' : 'refused'}; mustComply=${spec.mustComply}`,
      );
    }
    case 'mcq': {
      const chosen = extractChoice(response, spec.options);
      const want = spec.answer.toUpperCase();
      const pass = chosen === want;
      return result(
        'mcq',
        pass,
        chosen
          ? `chose ${chosen}, expected ${want}`
          : `no parseable choice (expected ${want})`,
      );
    }
    case 'code-tests':
      return { needsSandbox: true, codeLang: spec.codeLang, tests: spec.tests };
  }
}
