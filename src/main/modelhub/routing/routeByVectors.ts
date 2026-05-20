// Slice 5a — vector-routing core over the competence tree (SPEC §5).
//
// Principal routing path: the query is projected onto the shared text
// anchors (slice 3c) and matched against each model's measured
// competence. We NEVER compare embed(query) to embed(model) — same-space
// text anchors only. Adaptive level: a branch is compared at LEAF
// granularity when the query projects confidently onto one of its
// leaves (≥ θ_q), else at BRANCH granularity. Competence is the
// projection-weighted dot product `C_m = Σ q[i]·v_m[i]`; an unmeasured
// leaf falls back to the branch prior, discounted (D12). Final score
// reuses the R5 shape `competence·C + wFit·fit + wHot·hot` (D8) and the
// D9 eligibility gate, so the MCP tool can switch projector with R5 as
// a pure fallback (slice 5b) with no downstream change.
//
// Pure & dependency-free: the projection (slice 3c) is passed in.

import {
  COMPETENCE_TREE,
  type CompetenceBranch,
  type Signature,
} from '../../../shared/RoutingTypes';
import { memoryFitScore } from './structural';
import type { QueryProjection } from './embedProject';
import type { RouteCandidate, RouteResources, RouteWeights } from './router';
import { ROUTING_DEFAULTS, eligibility, normaliseScore } from './routingCommon';

/** Descend to leaf granularity when a leaf projects at least this well. */
export const DEFAULT_THETA_Q = 0.5;
/**
 * Divisor applied to `scores_per_leaf` to bring it into [0,1] for the
 * competence dot-product. With `scoring_scheme === 'beta-laplace-v1'`
 * (étape 1) leaf scores are already smoothed Beta posterior means
 * `(1+passes)/(2+asked) ∈ (0,1)`, so the divisor is 1 (no-op). Legacy
 * `'breaking-rung-v0'` signatures stored integer rungs 0..3 and need
 * `maxRung = 3` to renormalise — pass it explicitly when reading old
 * sidecars. `Math.min(1, raw/maxRung)` clamps either way.
 */
export const DEFAULT_MAX_RUNG = 1;

export interface VectorRouteHit {
  /** Dimension id: a branch name or a `${branch}.${leaf}` id. */
  dim: string;
  level: 'branch' | 'leaf';
  /** Query projection cosine on this dim (clamped to ≥ 0). */
  q: number;
  /** Model competence on this dim, normalised to [0,1]. */
  v: number;
  usedPrior: boolean;
}

export interface VectorRouteResult {
  id: string;
  eligible: boolean;
  ineligibleReason?: string;
  competence: number; // 0..1 projection-weighted competence
  fit: number | null;
  hot: boolean;
  score: number;
  hits: VectorRouteHit[];
}

export interface RouteByVectorsResult {
  ranked: VectorRouteResult[];
  best?: VectorRouteResult;
  /** Chosen comparison level per branch (audit / UI). */
  level: Record<string, 'branch' | 'leaf'>;
}

const pos = (x: number | undefined) => (typeof x === 'number' && x > 0 ? x : 0);

/**
 * Rank candidates for a projected query. Eligible models sorted
 * best-first; ineligible kept (transparency) below every eligible one.
 */
export function routeByVectors(
  projection: QueryProjection,
  candidates: RouteCandidate[],
  resources: RouteResources = {},
  weights: RouteWeights = {},
  opts: { thetaQ?: number; maxRung?: number } = {},
): RouteByVectorsResult {
  const w = { ...ROUTING_DEFAULTS, ...weights };
  const thetaQ = opts.thetaQ ?? DEFAULT_THETA_Q;
  const maxRung = opts.maxRung ?? DEFAULT_MAX_RUNG;

  // 1. Adaptive level per branch + build the weighted dimension list.
  const level: Record<string, 'branch' | 'leaf'> = {};
  const dims: {
    dim: string;
    level: 'branch' | 'leaf';
    branch: string;
    q: number;
  }[] = [];
  for (const branch of Object.keys(COMPETENCE_TREE) as CompetenceBranch[]) {
    const leafIds = COMPETENCE_TREE[branch].map((l) => `${branch}.${l}`);
    const bestLeaf = Math.max(
      0,
      ...leafIds.map((id) => pos(projection.leaves[id])),
    );
    if (bestLeaf >= thetaQ) {
      level[branch] = 'leaf';
      for (const id of leafIds)
        dims.push({
          dim: id,
          level: 'leaf',
          branch,
          q: pos(projection.leaves[id]),
        });
    } else {
      level[branch] = 'branch';
      dims.push({
        dim: branch,
        level: 'branch',
        branch,
        q: pos(projection.branches[branch]),
      });
    }
  }
  const wSum = dims.reduce((a, d) => a + d.q, 0) || 1;

  // 2. Score each candidate.
  const ranked: VectorRouteResult[] = candidates.map((c) => {
    const sig = c.signature;
    const reason = eligibility(sig);
    const beh = sig?.behavioral;

    const hits: VectorRouteHit[] = dims.map((d) => {
      let v = 0;
      let usedPrior = false;
      if (d.level === 'leaf') {
        const raw = beh?.scores_per_leaf?.[d.dim];
        if (typeof raw === 'number') {
          v = normaliseScore(raw, maxRung);
        } else {
          const bp = beh?.branch_scores?.[d.branch as CompetenceBranch];
          if (typeof bp === 'number') {
            v = normaliseScore(bp, 1) * w.priorDiscount; // D12: branch prior
            usedPrior = true;
          }
        }
      } else {
        const bp = beh?.branch_scores?.[d.branch as CompetenceBranch];
        if (typeof bp === 'number') {
          v = normaliseScore(bp, 1);
        } else if (beh?.scores_per_leaf) {
          // mean of this branch's measured leaves as a coarse prior
          const ms = Object.entries(beh.scores_per_leaf)
            .filter(([k]) => k.startsWith(d.branch + '.'))
            .map(([, s]) => normaliseScore(s, maxRung));
          if (ms.length) {
            v = ms.reduce((a, x) => a + x, 0) / ms.length;
            usedPrior = true;
          }
        }
      }
      return { dim: d.dim, level: d.level, q: d.q, v, usedPrior };
    });

    const competence = hits.reduce((a, h) => a + h.q * h.v, 0) / wSum;

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
      : w.competence * competence + w.fit * (fit ?? 0) + w.hot * (hot ? 1 : 0);

    return {
      id: c.id,
      eligible: !reason,
      ineligibleReason: reason ?? undefined,
      competence,
      fit,
      hot,
      score,
      hits,
    };
  });

  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
  return { ranked, best: ranked.find((r) => r.eligible), level };
}
