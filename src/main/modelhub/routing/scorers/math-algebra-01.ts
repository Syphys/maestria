// Scorer for prompt math-algebra-01: solve 3x² − 12x + 7 = 0 exactly.
// Expected canonical answer: x = 2 ± √15/3 (equivalent forms accepted).

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
  const text = response.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const partialCriteria: Record<string, boolean> = {};

  // correct_discriminant: response mentions 60, or 144-84, or b²-4ac expression
  partialCriteria.correct_discriminant =
    /\b144\s*[-−–]\s*84\b/.test(text) ||
    /(?:discrim|delta|Δ)[^.]{0,40}\b60\b/i.test(text) ||
    /b\s*\^?2\s*[-−–]\s*4\s*a\s*c[^.]{0,40}\b60\b/i.test(lower);

  // correct_simplification_sqrt60: √60 = 2√15 simplification shown
  partialCriteria.correct_simplification_sqrt60 =
    /(?:sqrt|√)\s*\(?\s*60[^.]{0,30}2\s*(?:sqrt|√)\s*\(?\s*15/i.test(lower) ||
    /2\s*(?:sqrt|√)\s*\(?\s*15[^.]{0,30}(?:sqrt|√)\s*\(?\s*60/i.test(lower);

  // correct_final_answer_exact: 2 ± √15/3 or (12 ± 2√15)/6 or equivalent
  const finalForm1 =
    /x\s*=?\s*2\s*[±+\-∓][^.]{0,15}(?:sqrt|√)\s*\(?\s*15[^.]{0,5}\/\s*3/i.test(
      lower,
    );
  const finalForm2 =
    /\(\s*12\s*[±+\-∓][^.]{0,15}2\s*(?:sqrt|√)\s*\(?\s*15[^.]{0,5}\)\s*\/\s*6/i.test(
      lower,
    );
  const finalForm3 =
    /\(\s*12\s*[±+\-∓][^.]{0,15}(?:sqrt|√)\s*\(?\s*60[^.]{0,5}\)\s*\/\s*6/i.test(
      lower,
    );
  // Catch the two roots stated separately: x₁ = 2 + √15/3, x₂ = 2 − √15/3
  const finalForm4 =
    /x[\s_₁1][\s=]+2\s*\+[^.]{0,15}(?:sqrt|√)\s*\(?\s*15[^.]{0,5}\/\s*3/i.test(
      lower,
    ) &&
    /x[\s_₂2][\s=]+2\s*[-−][^.]{0,15}(?:sqrt|√)\s*\(?\s*15[^.]{0,5}\/\s*3/i.test(
      lower,
    );
  partialCriteria.correct_final_answer_exact =
    finalForm1 || finalForm2 || finalForm3 || finalForm4;

  // shows_clear_steps: at least 3 non-trivial lines OR explicit step markers
  const lines = response.split(/\n/).filter((l) => l.trim().length > 5);
  partialCriteria.shows_clear_steps =
    lines.length >= 3 ||
    /(?:étape|step)\s*\d/i.test(lower) ||
    /(?:premièrement|deuxièmement|first|then|next|finally)/i.test(lower);

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.correct_final_answer_exact && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} [${describeMatched(partialCriteria)}]`,
  };
};
