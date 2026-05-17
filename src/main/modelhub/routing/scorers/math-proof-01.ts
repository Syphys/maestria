// Scorer for math-proof-01: prove sum of 3 consecutive integers is divisible by 3.
// Expected: algebraic setup (n-1, n, n+1 or n, n+1, n+2), sum = 3n or 3(n+1), divisibility conclusion.

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

export const score: DeterministicScorer = (response, prompt): ScoringResult => {
  const text = response.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const partialCriteria: Record<string, boolean> = {};

  // correct_algebraic_setup: introduces 3 consecutive integers symbolically
  partialCriteria.correct_algebraic_setup =
    /\bn\s*[-−]\s*1[,\s]*n[,\s]*n\s*\+\s*1\b/i.test(text) ||
    /\bn[,\s]*n\s*\+\s*1[,\s]*n\s*\+\s*2\b/i.test(text) ||
    /\bk[,\s]*k\s*\+\s*1[,\s]*k\s*\+\s*2\b/i.test(text);

  // valid_conclusion: sum = 3n or 3(n+1) or 3k
  partialCriteria.valid_conclusion =
    /=\s*3\s*[nk]\b/i.test(text) ||
    /=\s*3\s*\(\s*[nk]\s*[+-]\s*1\s*\)/i.test(text) ||
    /divisib(?:le|ility) by 3|divisible par 3|multiple de 3|multiple of 3/i.test(
      lower,
    );

  // concise: response ≤ 6 lines or ≤ 350 chars
  const lineCount = response.split(/\n/).filter((l) => l.trim()).length;
  partialCriteria.concise = lineCount <= 6 || response.length <= 350;

  // uses_proper_mathematical_language: "let" / "soit" / "donc" / "therefore" / "QED" / "∎" / "CQFD"
  partialCriteria.uses_proper_mathematical_language =
    /\b(?:let|soit|posons|donc|therefore|hence|thus|q\.?e\.?d\.?|cqfd)\b|∎/i.test(
      lower,
    );

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass =
    partialCriteria.correct_algebraic_setup &&
    partialCriteria.valid_conclusion &&
    aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} lines=${lineCount} [${describeMatched(partialCriteria)}]`,
  };
};
