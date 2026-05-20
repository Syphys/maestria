// Scorer for informatics-general-01 (slice 7a, axis `informatics`).
// Three short canonical-token answers checked in any order across the
// response: loopback 127.0.0.1, HTTPS port 443, "logarithmic" complexity
// class. Deterministic (D3, no judge, no embedder). `<think>` stripped
// (D11). Same idiom as the other multi-criterion scorers (tooluse / cal).

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

export const score: DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
): ScoringResult => {
  const text = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const partialCriteria: Record<string, boolean> = {};

  // 127.0.0.1 — exact dotted-decimal, allow optional surrounding chars
  // but no other dotted-decimal IP (so "10.127.0.0.1.0" doesn't match).
  partialCriteria.loopback_127 = /(?<![\d.])127\.0\.0\.1(?![\d.])/.test(text);

  // HTTPS port 443 — bare integer, not glued to other digits.
  partialCriteria.https_443 = /\b443\b/.test(text);

  // Big-O class word — case-insensitive whole word, French spelling
  // "logarithmique" also accepted (lang.fr cross-tolerance).
  partialCriteria.binary_search_logarithmic = /\blogarithmi(c|que)\b/i.test(
    text,
  );

  const aggregate = aggregateScore(partialCriteria, prompt);
  // Pass-gate: at least 2 of the 3 facts AND aggregate ≥ 0.6 (matches the
  // other multi-criterion scorers' threshold-of-majority pattern).
  const hits = Object.values(partialCriteria).filter(Boolean).length;
  const pass = hits >= 2 && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} hits=${hits}/3 [${describeMatched(partialCriteria)}]`,
  };
};
