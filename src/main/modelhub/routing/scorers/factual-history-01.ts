// Scorer for prompt factual-history-01: Peace of Westphalia.
// Expected: year 1648, locations Münster + Osnabrück, main parties, one sentence.

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

const PARTY_PATTERNS: RegExp[] = [
  /\b(?:saint[- ]empire|holy roman empire|hre|sacro romano)\b/i,
  /\b(?:france|french|royaume de france)\b/i,
  /\b(?:su[èe]de|sweden|swedish)\b/i,
  /\b(?:provinces[- ]unies|dutch republic|netherlands|hollande)\b/i,
  /\b(?:espagne|spain|spanish)\b/i,
];

export const score: DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
): ScoringResult => {
  const partialCriteria: Record<string, boolean> = {};

  // correct_year_1648
  partialCriteria.correct_year_1648 = /\b1648\b/.test(response);

  // correct_locations_munster_osnabruck — both cities cited
  const munster = /m[üu]nster/i.test(response);
  const osnabruck = /osnabr[üu]ck/i.test(response);
  partialCriteria.correct_locations_munster_osnabruck = munster && osnabruck;

  // lists_main_parties — at least 2 of the 5 main parties
  const matchedParties = PARTY_PATTERNS.filter((re) =>
    re.test(response),
  ).length;
  partialCriteria.lists_main_parties = matchedParties >= 2;

  // single_sentence_constraint — at most one sentence-ending punctuation
  // (allow trailing period; disallow multiple sentences)
  const sentences = response
    .trim()
    .split(/[.!?]+\s/)
    .filter((s) => s.trim().length > 0);
  partialCriteria.single_sentence_constraint = sentences.length === 1;

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass =
    partialCriteria.correct_year_1648 &&
    partialCriteria.correct_locations_munster_osnabruck &&
    aggregate >= 0.7;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} parties=${matchedParties}/5 sentences=${sentences.length} [${describeMatched(partialCriteria)}]`,
  };
};
