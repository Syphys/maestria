// Deterministic scorer types for R2.6 (judge-free, DECISIONS.md D3).

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';

/**
 * Result of a deterministic scoring run on one model response.
 *
 * `score` is the weighted aggregate ∈ [0, 1] matching the format the judge
 * LLM would produce — same data shape, so the upstream pipeline doesn't care
 * whether it came from a deterministic check or a judge.
 *
 * `pass` is the binary verdict — useful for quick filtering and dashboards.
 *
 * `partialCriteria` maps each rubric criterion → boolean pass.
 * `detail` is a short human-readable explanation for the audit log.
 */
export type ScoringResult = {
  pass: boolean;
  score: number; // 0..1, weighted by rubric
  partialCriteria: Record<string, boolean>;
  detail: string;
};

/**
 * Pure function: (response, prompt) → ScoringResult.
 * Must be deterministic and dependency-free (no I/O, no network, no shell).
 */
export type DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
) => ScoringResult;

/**
 * Helper: compute the weighted aggregate from per-criterion booleans.
 * Missing criteria default to false (0 weight contribution).
 */
export function aggregateScore(
  partialCriteria: Record<string, boolean>,
  prompt: DiagnosticPrompt,
): number {
  return prompt.rubric.reduce(
    (acc, r) => acc + (partialCriteria[r.criterion] ? r.weight : 0),
    0,
  );
}

/**
 * Helper: render the matched criteria as a short comma-separated label.
 */
export function describeMatched(
  partialCriteria: Record<string, boolean>,
): string {
  return Object.entries(partialCriteria)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
}
