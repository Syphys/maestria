// Scorer for reasoning-counter-01: Euler's polynomial trap.
// Expected counter-example: n=40 (40² + 40 + 41 = 1681 = 41²).

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';
import { normalizeMath } from './normalizeMath';

export const score: DeterministicScorer = (response, prompt): ScoringResult => {
  // D10: `41^{2}` / `41 \times 41` → `41^2` / `41 * 41` for the factor check.
  const text = normalizeMath(response);
  const lower = text.toLowerCase();
  const partialCriteria: Record<string, boolean> = {};

  // finds_valid_counter_example: mentions n=40 OR n=41 (both work, 40 is smallest)
  partialCriteria.finds_valid_counter_example = /\bn\s*=\s*(?:40|41)\b/i.test(
    text,
  );

  // proves_it_factors: shows 1681 = 41² or 41 × 41, or computes 41 × 43 (for n=41)
  const proves1681 =
    /\b1681\b.*?(?:41\s*[\^²2]|41\s*[×\*x×]\s*41)/i.test(lower) ||
    /(?:41\s*[\^²2]|41\s*[×\*x]\s*41).*?\b1681\b/i.test(lower);
  const provesFactoring41 =
    /\b41\s*[×\*x×]\s*43\b/i.test(text) || /\b1763\b/.test(text); /* 41*43 */
  partialCriteria.proves_it_factors = proves1681 || provesFactoring41;

  // identifies_smallest_n_40: explicitly says 40 is the smallest
  partialCriteria.identifies_smallest_n_40 =
    /\b(?:smallest|petit|minimum|plus petit|premier|first)[^.]{0,30}\b40\b/i.test(
      lower,
    ) ||
    /\b40\b[^.]{0,30}(?:smallest|petit|minimum|first|premier)/i.test(lower);

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.finds_valid_counter_example && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} [${describeMatched(partialCriteria)}]`,
  };
};
