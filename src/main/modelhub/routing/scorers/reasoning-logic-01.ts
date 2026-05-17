// Scorer for reasoning-logic-01: three liars puzzle. Answer: Bob.

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

export const score: DeterministicScorer = (response, prompt): ScoringResult => {
  const text = response;
  const lower = text.toLowerCase();
  const partialCriteria: Record<string, boolean> = {};

  // correct_final_answer_Bob: response identifies Bob as the truthful one
  // Look for "Bob" as the answer, not just any mention (Alice/Carol mentioned in the puzzle setup)
  const bobAsAnswer =
    /(?:answer|réponse|réponse :|the truthful|the one|c'est|is)\s*(?:is\s+|:\s+)?\*?\*?bob\*?\*?\b/i.test(
      text,
    ) ||
    /\bbob\b\s+(?:is telling|is the truthful|dit la vérité|est celui)/i.test(
      lower,
    ) ||
    // last line "Bob" alone counts as final answer
    /\bbob\b\s*\.?\s*$/i.test(text.trim().split(/\n/).pop() ?? '');
  partialCriteria.correct_final_answer_Bob = bobAsAnswer;

  // systematically_tests_hypotheses: mentions testing/supposing/hypothesis for each
  const testMarkers = [
    /\b(?:if|si|suppos|assume|hypoth)/i,
    /\balice\b/i,
    /\bbob\b/i,
    /\bcarol\b/i,
  ];
  partialCriteria.systematically_tests_hypotheses =
    testMarkers.every((re) => re.test(text)) && response.length > 100;

  // consistency_check_shown: response mentions contradiction / consistent / consistency
  partialCriteria.consistency_check_shown =
    /(?:contradict|inconsist|consistent|coh[éee]rent|impossible|incompatib)/i.test(
      lower,
    );

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.correct_final_answer_Bob && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} [${describeMatched(partialCriteria)}]`,
  };
};
