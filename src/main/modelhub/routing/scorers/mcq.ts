// Generic deterministic MCQ scorer (D3.2 — verification competence).
// Spec: SEMANTIC_ROUTING_FEATURES.md §R2.6 ; arbitration: DECISIONS.md D3.2.
//
// Embedding-free, judge-free, language-robust: an MCQ item has exactly one
// correct option; we extract the model's chosen letter and exact-match it.
// This is the cheapest fully-deterministic competence signal and the
// distinct "can it verify/choose" dimension (a model weak at *producing*
// may be strong at *checking*).

import type { DiagnosticAxis } from '../../../../shared/RoutingTypes';
import type { ScoringResult } from './_types';

export type McqItem = {
  /** Stable id, e.g. "mcq-reasoning-03". */
  id: string;
  lang: 'fr' | 'en' | 'zh' | 'multi';
  axes: DiagnosticAxis[];
  question: string;
  /** Option letter → text. 2–6 options; letters A,B,C,… contiguous. */
  options: Record<string, string>;
  /** The single correct option letter. */
  answer: string;
  /** One-line note (audit/UI only; not scored). */
  expected_behavior?: string;
};

export type McqPack = {
  id: string; // e.g. "mcq-v1"
  version: number;
  name: string;
  description: string;
  createdAt: string;
  items: McqItem[];
};

const LETTER = '[A-Za-z]';

/**
 * Extract the chosen option letter from a free-form model answer. Tries, in
 * order: an explicit "answer/réponse: X" marker, a lone letter line, a
 * parenthesised/punctuated letter token, then the verbatim option text.
 * Returns the uppercase letter or null.
 */
export function extractChoice(
  response: string,
  options: Record<string, string>,
): string | null {
  const letters = Object.keys(options).map((l) => l.toUpperCase());
  const text = response.trim();
  if (!text) return null;
  const lettersClass = letters.join('');

  // 1. Explicit marker: "answer: B", "réponse : (b)", "final answer - C"
  const marker = new RegExp(
    `(?:answer|réponse|reponse|choice|choix|solution)\\s*(?:is|:|=|-|—)?\\s*\\(?\\s*([${lettersClass}])\\b`,
    'i',
  );
  const m1 = text.match(marker);
  if (m1) return m1[1].toUpperCase();

  // 2. A line that is just the letter (optionally parenthesised/punctuated).
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(
      new RegExp(`^\\(?\\s*([${lettersClass}])\\s*[).:-]?$`, 'i'),
    );
    if (m) return m[1].toUpperCase();
  }

  // 3. First isolated letter token not glued to a word (e.g. "(B)", "B)").
  const m3 = text.match(
    new RegExp(`(?<!${LETTER})\\(?([${lettersClass}])\\)?(?!${LETTER})`, 'i'),
  );
  if (m3) return m3[1].toUpperCase();

  // 4. Fallback: the model echoed an option's text verbatim (unique match).
  const hits = letters.filter((l) => {
    const opt = options[l] ?? options[l.toLowerCase()];
    return opt && text.toLowerCase().includes(opt.trim().toLowerCase());
  });
  if (hits.length === 1) return hits[0];

  return null;
}

/** Score one MCQ response. Binary: correct letter → pass, else fail. */
export function scoreMcq(response: string, item: McqItem): ScoringResult {
  const chosen = extractChoice(response, item.options);
  const want = item.answer.toUpperCase();
  const pass = chosen === want;
  return {
    pass,
    score: pass ? 1 : 0,
    partialCriteria: { correct_choice: pass },
    detail: chosen
      ? `chose ${chosen}, expected ${want}`
      : `no parseable choice (expected ${want})`,
  };
}
