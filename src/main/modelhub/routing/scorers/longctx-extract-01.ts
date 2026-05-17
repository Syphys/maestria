// Scorer for prompt longctx-extract-01: needle in haystack.
// Expected: the number "7-19-3-42" + a position fraction in [0.6, 0.95].

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
  const partialCriteria: Record<string, boolean> = {};

  // correct_number_7_19_3_42 — accept any separator between numbers (-, –, —, ., space)
  partialCriteria.correct_number_7_19_3_42 =
    /\b7\s*[-–—.]\s*19\s*[-–—.]\s*3\s*[-–—.]\s*42\b/.test(response);

  // approximate_position_in_second_half — extract any plausible position indicator
  // Accept: fraction 0.6-0.95, percentage 60-95%, vague mentions like "near the end"/"~80%"
  let positionOk = false;
  const fractionMatches = response.match(/\b0?\.\d+\b/g) || [];
  for (const f of fractionMatches) {
    const v = parseFloat(f);
    if (v >= 0.6 && v <= 0.95) {
      positionOk = true;
      break;
    }
  }
  if (!positionOk) {
    const pctMatches = response.match(/\b(\d{1,3})\s*%/g) || [];
    for (const p of pctMatches) {
      const v = parseFloat(p) / 100;
      if (v >= 0.6 && v <= 0.95) {
        positionOk = true;
        break;
      }
    }
  }
  partialCriteria.approximate_position_in_second_half = positionOk;

  // no_extra_text — the prompt says "No other text". Short response = good.
  const trimmed = response.trim();
  partialCriteria.no_extra_text = trimmed.length < 200;

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.correct_number_7_19_3_42 && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} length=${trimmed.length} [${describeMatched(partialCriteria)}]`,
  };
};
