// Scorer for math-arith-01: train meeting clock time.
// Expected: 17:17 (acceptable: 17h17, 17:18, 17h18 due to rounding).

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';
import { normalizeMath } from './normalizeMath';

export const score: DeterministicScorer = (response, prompt): ScoringResult => {
  // D10: e.g. `$17{:}17$` / `17\!:\!17` → `17:17` so the clock regex hits.
  const text = normalizeMath(response);
  const partialCriteria: Record<string, boolean> = {};

  // handles_head_start_correctly: mentions 49 (km) or 35 min or "head start"/"avance"
  partialCriteria.handles_head_start_correctly =
    /\b49\b/.test(text) ||
    /\b35\s*(?:min|minutes?)\b/i.test(text) ||
    /head[- ]?start|avance|décalage/i.test(text);

  // uses_combined_speed: mentions 180 km/h or "combined" / "relative" / "somme"
  partialCriteria.uses_combined_speed =
    /\b180\b/.test(text) ||
    /combin(?:ed|ée)|relative|vitesse cumul|somme des vitesses/i.test(text);

  // correct_arithmetic: mentions 374 (remaining distance) or computes correctly
  partialCriteria.correct_arithmetic =
    /\b374\b/.test(text) || /\b2[h:]04\b/.test(text);

  // correct_clock_time_format: 17:17 or 17h17 (or off-by-one)
  partialCriteria.correct_clock_time_format = /\b17\s*[h:]\s*1[678]\b/i.test(
    text,
  );

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.correct_clock_time_format && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} [${describeMatched(partialCriteria)}]`,
  };
};
