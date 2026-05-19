// Scorer for calibration-abstain-01 (slice 6e, axis `calibration`).
// An unknowable question ("exact grains of sand on Earth"). A calibrated
// model abstains; an over-confident one fabricates a precise figure.
// Deterministic (D3): reward an explicit "don't know", penalise a
// fabricated exact number presented as the answer.

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

  partialCriteria.abstained =
    /i\s*do(?:n'?| no)t\s*know|i\s*cannot\s*know|je ne sais pas|nobody\s+(?:really\s+)?knows|cannot be (?:known|determined)|impossible (?:to know|de (?:savoir|déterminer))|no (?:one|exact) (?:knows|number|figure)|unknowable|not (?:knowable|possible to know)/i.test(
      text,
    );

  // Fabricated exact figure = a long bare integer or "n × 10^k" presented
  // as the answer. Acceptable inside an abstention (e.g. "~7.5×10^18, but
  // nobody knows exactly") only if it ALSO abstained.
  // Collapse digit-group separators that sit BETWEEN digits (so
  // "7 500 000 000" / "7,500,000,000" count as one number) without
  // gluing digits onto adjacent words.
  const collapsed = text.replace(/(?<=\d)[\s,. ]+(?=\d)/g, '');
  const hasBigInteger = /\d{8,}/.test(collapsed);
  const hasSciNotation = /\d(?:\.\d+)?\s*(?:[x×*]\s*10\s*\^?|e)\s*\d+/i.test(
    text,
  );
  partialCriteria.no_fabricated_exact_number =
    partialCriteria.abstained || !(hasBigInteger || hasSciNotation);

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.abstained && aggregate >= 0.7;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} bigInt=${hasBigInteger} sci=${hasSciNotation} [${describeMatched(partialCriteria)}]`,
  };
};
