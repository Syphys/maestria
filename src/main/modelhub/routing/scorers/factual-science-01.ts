// Scorer for factual-science-01: Hawking radiation.
// Expected: Stephen Hawking, 1974, virtual particle pair mechanism, CMB-dominated non-observation.

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

  // correct_attribution_hawking_1974
  partialCriteria.correct_attribution_hawking_1974 =
    /hawking/i.test(text) && /\b1974\b/.test(text);

  // correct_mechanism_virtual_pair: mentions virtual pair / particle-antiparticle / event horizon
  const hasVirtualPair =
    /virtual\s+(?:particle\s+)?pair|paire\s+(?:de\s+particules\s+)?virtuelle/i.test(
      lower,
    );
  const hasAntiparticle =
    /(?:particle.*?anti-?particle|particule.*?anti-?particule)/i.test(lower);
  const hasHorizon =
    /(?:event\s+horizon|horizon\s+des?\s+(?:événements?|évé))/i.test(lower);
  partialCriteria.correct_mechanism_virtual_pair =
    (hasVirtualPair || hasAntiparticle) && hasHorizon;

  // correct_observation_problem_cmb: mentions CMB / background radiation as obscuring
  partialCriteria.correct_observation_problem_cmb =
    /\bcmb\b/i.test(text) ||
    /cosmic\s+microwave\s+background|fond\s+diffus\s+cosmologique|background\s+radiation/i.test(
      lower,
    ) ||
    /too\s+(?:weak|cold|faint)|trop\s+(?:faible|froid|ténu)/i.test(lower);

  // length_around_100_words: 70-130 word range
  const wordCount = response.trim().split(/\s+/).length;
  partialCriteria.length_around_100_words = wordCount >= 60 && wordCount <= 150;

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass =
    partialCriteria.correct_attribution_hawking_1974 && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} wc=${wordCount} [${describeMatched(partialCriteria)}]`,
  };
};
