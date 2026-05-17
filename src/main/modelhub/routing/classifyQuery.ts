// Slice 6 — Deterministic query classifier (R5, embedding-free).
// Arbitration: DECISIONS.md D3 (no judge, no embedder in the MVP path).
//
// Turns an incoming query into a weight per competence axis — "which
// skills does answering this need?". Pure, dependency-free, deterministic
// (regex/keyword heuristics, no model call). The router then matches these
// weights against each model's measured competence vector.
//
// This is the embedding-free counterpart of the parked R1 query-embedding
// path: an axis-weight vector instead of a neural one.

import type { DiagnosticAxis } from '../../../shared/RoutingTypes';

export type AxisWeights = Partial<Record<DiagnosticAxis, number>>;

const FRENCH_HINT =
  /[àâäéèêëîïôöùûüçœ]|\b(le|la|les|un|une|des|est|être|avec|pour|dans|quelle?|pourquoi|comment|résous|écris|expliquer?|phrase|correcte?)\b/i;

const CODE_HINT =
  /```|\b(function|def |class |import |return|const |let |var |public |#include|console\.log|System\.out|->|=>|fn |async )\b|\b(python|javascript|typescript|java|rust|c\+\+|golang|sql|regex|bug|stack ?trace|compile)\b/i;

const MATH_HINT =
  /\b(solve|résous|equation|équation|derivative|dérivée|integral|intégrale|prove|démontre|theorem|théorème|factor|simplif|matrix|probabilit|\d+\s*[x-z]\b)\b|[=±√∫∑∏≤≥]|x²|\^2|\d\s*[-+*/]\s*\d/i;

const REASONING_HINT =
  /\b(why|pourquoi|because|donc|therefore|deduce|déduis|logic|logique|puzzle|riddle|énigme|if .* then|si .* alors|consequenc|implies|contradiction)\b/i;

const FACTUAL_HINT =
  /\b(who|qui|when|quand|where|où|what year|quelle année|in which|capital|capitale|date of|inventeur|discovered|président|history|histoire)\b|\?\s*$/i;

const INSTRUCTION_HINT =
  /\b(exactly|exactement|json|yaml|format|bullet|liste? à puces|in \d+ words|en \d+ mots|one line|une ligne|step ?by ?step|étape par étape|table|tableau|markdown)\b/i;

const MULTISTEP_HINT =
  /\b(step ?by ?step|étape par étape|first.*then.*finally|d'abord.*ensuite|plan|décompose|break (it|this) down)\b|(\?[^?]*){3,}/i;

const CREATIVE_HINT =
  /\b(write a (poem|story|song|haiku)|écris (un poème|une histoire|une chanson)|imagine|fiction|brainstorm|slogan|tagline)\b/i;

const META_HINT =
  /\b(classify|classe|categoriz|catégoris|which (domain|category)|quel domaine|is this (a|an)|détecte|detect the)\b/i;

const ZH_HINT = /[一-鿿]/;

/** Long inputs exercise long-context handling regardless of topic. */
const LONGCTX_CHARS = 4000;

/**
 * Classify `query` into competence-axis weights (0..1). Language is always
 * present (zh/fr/en). Domain axes are added on signal. Falls back to a
 * light reasoning+factual profile when nothing else matches, so routing
 * still works on a bare prompt.
 */
export function classifyQuery(query: string): AxisWeights {
  const q = (query ?? '').trim();
  const w: AxisWeights = {};
  const set = (a: DiagnosticAxis, v: number) => {
    if ((w[a] ?? 0) < v) w[a] = v;
  };

  // Language (exactly one dominant).
  if (ZH_HINT.test(q)) set('zh', 1);
  else if (FRENCH_HINT.test(q)) set('fr', 1);
  else set('en', 1);

  if (CODE_HINT.test(q)) set('code', 1);
  if (MATH_HINT.test(q)) set('math', 1);
  if (REASONING_HINT.test(q)) set('reasoning', 0.8);
  if (FACTUAL_HINT.test(q)) set('factual', 0.7);
  if (INSTRUCTION_HINT.test(q)) set('instruction', 0.7);
  if (MULTISTEP_HINT.test(q)) set('multistep', 0.7);
  if (CREATIVE_HINT.test(q)) set('creative', 0.8);
  if (META_HINT.test(q)) set('meta', 0.7);
  if (q.length >= LONGCTX_CHARS) set('longctx', 0.6);

  // Nothing domain-specific → a generic profile so the router still ranks.
  const onlyLang = Object.keys(w).every(
    (k) => k === 'fr' || k === 'en' || k === 'zh',
  );
  if (onlyLang) {
    set('reasoning', 0.5);
    set('factual', 0.5);
  }

  return w;
}
