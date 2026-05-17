// Per-axis competence aggregation (D3 — deterministic competence vector).
// Spec: SEMANTIC_ROUTING_FEATURES.md §R2.6 ; arbitration: DECISIONS.md D3.
//
// Pure, embedding-free, judge-free. Folds the deterministic + MCQ scoring
// results (each tagged with the axes it exercises) into a per-axis
// competence vector: the mean score over the items touching that axis.
// `behavior_centroid` stays empty here — that is the embedding track (R1 /
// R2.6.5), deliberately out of scope for now.

import type { DiagnosticAxis } from '../../../shared/RoutingTypes';

/** One scored prompt/MCQ item, tagged with the axes it exercises. */
export type ScoredItem = {
  id: string;
  axes: DiagnosticAxis[];
  /** Weighted aggregate ∈ [0,1] (rubric for prompts, 0|1 for MCQ). */
  score: number;
  pass: boolean;
};

export type CompetenceVector = {
  /** Mean score per axis — only axes with ≥1 scored item appear. */
  per_axis: Partial<Record<DiagnosticAxis, number>>;
  /** Item count behind each axis (sample size — small ⇒ noisy). */
  n_per_axis: Partial<Record<DiagnosticAxis, number>>;
  /** Mean score over every item (axis-agnostic overall competence). */
  overall: number;
  /** Total items aggregated. */
  n: number;
};

/**
 * Aggregate scored items into a competence vector. An item contributes its
 * `score` to every axis in its `axes`. Pure — order-independent, no I/O.
 */
export function aggregateCompetence(items: ScoredItem[]): CompetenceVector {
  const sum: Partial<Record<DiagnosticAxis, number>> = {};
  const cnt: Partial<Record<DiagnosticAxis, number>> = {};
  let total = 0;

  for (const it of items) {
    const s = Number.isFinite(it.score) ? it.score : 0;
    total += s;
    for (const ax of it.axes) {
      sum[ax] = (sum[ax] ?? 0) + s;
      cnt[ax] = (cnt[ax] ?? 0) + 1;
    }
  }

  const per_axis: Partial<Record<DiagnosticAxis, number>> = {};
  for (const ax of Object.keys(cnt) as DiagnosticAxis[]) {
    per_axis[ax] = (sum[ax] as number) / (cnt[ax] as number);
  }

  return {
    per_axis,
    n_per_axis: cnt,
    overall: items.length ? total / items.length : 0,
    n: items.length,
  };
}
