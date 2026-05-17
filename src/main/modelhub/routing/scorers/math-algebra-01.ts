// Scorer for prompt math-algebra-01: solve 3x² − 12x + 7 = 0 exactly.
// Expected canonical answer: x = 2 ± √15/3 (equivalent forms accepted).

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';
import { normalizeMath } from './normalizeMath';

export const score: DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
): ScoringResult => {
  // D10: fold LaTeX (\sqrt{15}, \frac{a}{b}, \pm, $…$) into the plain
  // forms the regexes below already accept. Idempotent on plain text.
  const text = normalizeMath(response).replace(/\s+/g, ' ');
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

  // correct_final_answer_exact: 2 ± √15/3 or (12 ± 2√15)/6 or equivalent.
  // D10: tolerate the parens `normalizeMath` introduces for \frac — it
  // emits `((A)/(B))`, so a LaTeX answer becomes e.g.
  // `((12 ± 2sqrt(15))/(6))` / `((6 ± sqrt(15))/(3))` / `2 ± ((sqrt(15))/(3))`.
  const PM = '[±+\\-∓]';
  const SQ15 = '(?:sqrt|√)\\s*\\(?\\s*15\\s*\\)?'; // sqrt(15) | √15 | sqrt 15
  const SQ60 = '(?:sqrt|√)\\s*\\(?\\s*60\\s*\\)?';
  const D3 = '\\/\\s*\\(?\\s*3\\s*\\)?'; // / 3 | /(3)
  const D6 = '\\/\\s*\\(?\\s*6\\s*\\)?'; // / 6 | /(6)
  const GAP = '[^.]{0,8}'; // swallows the `))` between radical and divisor
  const re = (src: string) => new RegExp(src, 'i').test(lower);

  const finalForm1 = re(`x\\s*=?\\s*2\\s*${PM}[^.]{0,15}${SQ15}${GAP}${D3}`);
  const finalForm2 = re(`\\(+\\s*12\\s*${PM}[^.]{0,15}2\\s*${SQ15}${GAP}${D6}`);
  const finalForm3 = re(`\\(+\\s*12\\s*${PM}[^.]{0,15}${SQ60}${GAP}${D6}`);
  // Two roots stated separately: x₁ = 2 + √15/3, x₂ = 2 − √15/3.
  const finalForm4 =
    re(`x[\\s_₁1][\\s=]+2\\s*\\+[^.]{0,15}${SQ15}${GAP}${D3}`) &&
    re(`x[\\s_₂2][\\s=]+2\\s*[-−][^.]{0,15}${SQ15}${GAP}${D3}`);
  // D10: the cleanest fully-simplified plain form, (6 ± √15)/3.
  const finalForm5 = re(`\\(+\\s*6\\s*${PM}[^.]{0,15}${SQ15}${GAP}${D3}`);
  // D10: optional numeric fallback — the two roots ≈ 3.2910 / 0.7090.
  const numericFallback =
    /\b3\.290?9?\d*\b/.test(text) &&
    (/\b0\.709\d*\b/.test(text) || /\b0\.71\b/.test(text));
  partialCriteria.correct_final_answer_exact =
    finalForm1 ||
    finalForm2 ||
    finalForm3 ||
    finalForm4 ||
    finalForm5 ||
    numericFallback;

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
