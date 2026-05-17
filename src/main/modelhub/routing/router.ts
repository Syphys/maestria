// Slice 6 — Deterministic model router (R5, embedding-free).
// Arbitration: DECISIONS.md D3 (competence-vector match, no judge/embedder
// in the MVP path), D8 (dynamic, resource-aware weighting — NOT baked into
// any signature hash), D9 (no routing candidate without a COMPLETE
// first-pass behavioral signature).
//
// Pure & dependency-free. The caller supplies each candidate's persisted
// Signature and a live free-memory probe (D8.2); this module just ranks.
// Formula (spec): final = competence_match + wFit·fit + wHot·hot.

import type { DiagnosticAxis, Signature } from '../../../shared/RoutingTypes';
import { memoryFitScore } from './structural';
import { classifyQuery, type AxisWeights } from './classifyQuery';

export interface RouteCandidate {
  /** Stable id (model file path or label). */
  id: string;
  /** Persisted signature, or null/undefined when never characterized. */
  signature?: Signature | null;
  /** Footprint override; defaults to `signature.structural.est_footprint_bytes`. */
  footprintBytes?: number;
  /** Already loaded → cheap to use (hot bonus). */
  running?: boolean;
}

export interface RouteResources {
  freeVramBytes?: number;
  freeRamBytes?: number;
}

export interface RouteWeights {
  /** Competence-match weight. Default 1.0. */
  competence?: number;
  /** Memory-fit weight (D8). Default 0.5. */
  fit?: number;
  /** Hot (already running) bonus. Default 0.1. */
  hot?: number;
  /**
   * How much an UNMEASURED axis trusts the model's `overall` as a prior
   * (0..1). Default 0.5 — measured specialist scores must outweigh a
   * generalist's high overall on an axis it was never tested on.
   */
  priorDiscount?: number;
}

export interface RouteAxisHit {
  axis: DiagnosticAxis;
  weight: number;
  /** Model's measured score on this axis, or its `overall` prior, or null. */
  modelScore: number | null;
  usedPrior: boolean;
}

export interface RouteResult {
  id: string;
  eligible: boolean;
  /** Set when not eligible (uncharacterized / failed / pending). */
  ineligibleReason?: string;
  competenceMatch: number; // 0..1
  fit: number | null; // memoryFitScore (graded; negative ⇒ OOM)
  hot: boolean;
  score: number; // final ranking score
  axes: RouteAxisHit[];
}

const DEFAULTS = { competence: 1.0, fit: 0.5, hot: 0.1, priorDiscount: 0.5 };

/** D9 gate: only a model with a COMPLETE behavioral signature can route. */
function eligibility(sig?: Signature | null): string | null {
  if (!sig) return 'not characterized';
  if (sig.characterization_state === 'failed') return 'quarantined (failed)';
  if (sig.characterization_state !== 'complete') {
    return `not complete (${sig.characterization_state})`;
  }
  if (!sig.behavioral) return 'no behavioral block';
  return null;
}

/**
 * Rank candidates for a query's axis-weight profile. Eligible models are
 * sorted best-first; ineligible ones are kept (for transparency) with
 * `eligible: false` and pushed below every eligible one.
 */
export function rankModels(
  axisWeights: AxisWeights,
  candidates: RouteCandidate[],
  resources: RouteResources = {},
  weights: RouteWeights = {},
): RouteResult[] {
  const w = { ...DEFAULTS, ...weights };
  const entries = Object.entries(axisWeights) as [DiagnosticAxis, number][];
  const wSum = entries.reduce((a, [, v]) => a + v, 0) || 1;

  const results: RouteResult[] = candidates.map((c) => {
    const sig = c.signature;
    const reason = eligibility(sig);
    const beh = sig?.behavioral;

    const axes: RouteAxisHit[] = entries.map(([axis, weight]) => {
      const measured = beh?.scores_per_axis?.[axis];
      let modelScore: number | null;
      let usedPrior = false;
      if (typeof measured === 'number') {
        modelScore = measured;
      } else if (typeof beh?.overall === 'number') {
        modelScore = beh.overall; // D8.B: absent axis ⇒ overall as prior
        usedPrior = true;
      } else {
        modelScore = null;
      }
      return { axis, weight, modelScore, usedPrior };
    });

    const competenceMatch =
      axes.reduce((a, h) => {
        const s = h.modelScore ?? 0;
        const eff = h.usedPrior ? s * w.priorDiscount : s;
        return a + h.weight * eff;
      }, 0) / wSum;

    const footprint =
      c.footprintBytes ?? sig?.structural?.est_footprint_bytes ?? 0;
    const fit = memoryFitScore(
      footprint,
      resources.freeVramBytes,
      resources.freeRamBytes,
    );
    const hot = !!c.running;

    const score = reason
      ? Number.NEGATIVE_INFINITY
      : w.competence * competenceMatch +
        w.fit * (fit ?? 0) +
        w.hot * (hot ? 1 : 0);

    return {
      id: c.id,
      eligible: !reason,
      ineligibleReason: reason ?? undefined,
      competenceMatch,
      fit,
      hot,
      score,
      axes,
    };
  });

  return results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
}

export interface RouteQueryResult {
  axisWeights: AxisWeights;
  ranked: RouteResult[];
  /** Top eligible candidate, or undefined when none can route. */
  best?: RouteResult;
}

/** Classify `query` then rank `candidates`. The one-call entry point. */
export function routeQuery(
  query: string,
  candidates: RouteCandidate[],
  resources: RouteResources = {},
  weights: RouteWeights = {},
): RouteQueryResult {
  const axisWeights = classifyQuery(query);
  const ranked = rankModels(axisWeights, candidates, resources, weights);
  const best = ranked.find((r) => r.eligible);
  return { axisWeights, ranked, best };
}
