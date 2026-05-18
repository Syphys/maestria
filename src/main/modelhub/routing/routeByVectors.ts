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

/** Descend to leaf granularity when a leaf projects at least this well. */
export const DEFAULT_THETA_Q = 0.5;
/** Rung scale of `scores_per_leaf` → normalised to [0,1] (v0: 3 levels). */
export const DEFAULT_MAX_RUNG = 3;
const DEFAULTS = { competence: 1.0, fit: 0.5, hot: 0.1, priorDiscount: 0.5 };

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

/** D9 gate: only a COMPLETE behavioral signature can route. */
function eligibility(sig?: Signature | null): string | null {
  if (!sig) return 'not characterized';
  if (sig.characterization_state === 'failed') return 'quarantined (failed)';
  if (sig.characterization_state !== 'complete')
    return `not complete (${sig.characterization_state})`;
  if (!sig.behavioral) return 'no behavioral block';
  return null;
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
  const w = { ...DEFAULTS, ...weights };
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
          v = Math.min(1, raw / maxRung);
        } else {
          const bp = beh?.branch_scores?.[d.branch as CompetenceBranch];
          if (typeof bp === 'number') {
            v = Math.min(1, bp) * w.priorDiscount; // D12: branch prior
            usedPrior = true;
          }
        }
      } else {
        const bp = beh?.branch_scores?.[d.branch as CompetenceBranch];
        if (typeof bp === 'number') {
          v = Math.min(1, bp);
        } else if (beh?.scores_per_leaf) {
          // mean of this branch's measured leaves as a coarse prior
          const ms = Object.entries(beh.scores_per_leaf)
            .filter(([k]) => k.startsWith(d.branch + '.'))
            .map(([, s]) => Math.min(1, s / maxRung));
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
