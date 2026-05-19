// Scorer for summarization-coverage-01 (slice 6f, axis `summarization`).
//
// Embedding-cosine on the characterization path would violate SPEC §4
// (embedder ONLY on the routing path) AND is a known-weak summary metric
// (gameable by extractive copy, blind to hallucination — SummaC/QAGS
// literature). Deterministic instead: curated source whose key entities
// are pre-known, check the summary COVERS them AND respects the
// compression constraint (one sentence, bounded length). Same idiom as
// `factual-*` / `longctx-extract` scorers.

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

  // Mandatory entity coverage (source-curated facts of Apollo 11, 1969,
  // Moon/lunar, Armstrong). Case-insensitive; tolerant variants.
  partialCriteria.must_include_apollo_11 = /apollo\s*[-]?\s*11/i.test(text);
  partialCriteria.must_include_year_1969 = /\b1969\b/.test(text);
  partialCriteria.must_include_moon =
    /\bmoon\b|\blunar\b|\blune\b|\blunaire\b/i.test(text);
  partialCriteria.must_include_armstrong = /\barmstrong\b/i.test(text);

  // Compression: ONE sentence (one terminal punctuation), reasonable length.
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  partialCriteria.one_sentence = sentences.length === 1;

  const words = text.split(/\s+/).filter((w) => w.length > 0);
  partialCriteria.length_under_30_words =
    words.length > 0 && words.length <= 30;

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass =
    partialCriteria.must_include_apollo_11 &&
    partialCriteria.one_sentence &&
    aggregate >= 0.7;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} sentences=${sentences.length} words=${words.length} [${describeMatched(partialCriteria)}]`,
  };
};
