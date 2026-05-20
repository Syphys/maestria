// Slice 6c → slice 8a — competence-tree readout model (pure, no charting
// dep — D7). Spec: SEMANTIC_ROUTING_FEATURES.md §2/§5/§6.
//
// The R5 radar (radarGeometry.ts) plots the COARSE per-axis vector. This
// is the FINE vector-routing tree: the FROZEN COMPETENCE_TREE taxonomy
// projected from a model's behavioral signature into a flat, READABLE
// structure the <CompetenceTree> component renders as a polygon radar
// (the earlier sunburst was unreadable — user 2026-05-19).
//
// HONEST by construction: a leaf/branch carries a value ONLY for what was
// actually measured. `provenance` separates a real staircase climb from a
// low-confidence QCM prior (Dyy/D12) from "never measured" (D8.B) — a
// weak/absent domain must never look competent. Stays a unit-testable
// pure core (no React, no I/O).
//
// Slice 8a (2026-05-20) — étape 1 (Beta-Laplace) made the old breaking-
// rung shape obsolete: `scores_per_leaf` now carries `(1+passes)/(2+asked)`
// in (0,1], NEVER integer, so the previous `score===Math.round(score)`
// rung detection and `score/TREE_MAX_RUNG` weighting were broken (the
// measured radar would render empty because Beta-Laplace caps at 0.80).
// Fix: the signature's `scoring_scheme` tag drives the math; legacy
// `breaking-rung-v0` signatures keep their old normalisation, and
// `beta-laplace-v1` (current) uses `passes_per_leaf` for honest
// provenance + a saturation-aware "fully mastered" predicate.

import {
  COMPETENCE_TREE,
  type BehavioralSignature,
  type CompetenceBranch,
} from '../../../shared/RoutingTypes';

/**
 * Legacy `breaking-rung-v0` ladder ceiling — leaf scores were the
 * breaking rung (1..3), and weights normalised via `score / TREE_MAX_RUNG`.
 *
 * Under `beta-laplace-v1` (current), scores are ALREADY in [0,1] (Laplace-
 * smoothed pass rate), so this constant is **not used for weighting**:
 * it stays exported for the legacy code path + tests that target the
 * pre-étape-1 shape.
 */
export const TREE_MAX_RUNG = 3;

/**
 * Beta-Laplace upper bound for a Phase-A full climb (`passes === asked ===
 * 3`): `(1+3)/(2+3) = 0.8`. Anything ≥ this == "passed every item the
 * ladder asked", which is what the radar treats as "fully mastered" under
 * the current scheme. Phase B (more items) lifts the ceiling toward 1.
 */
export const BETA_LAPLACE_SATURATION = 0.8;

/** SPEC §3 θ_open — a branch is only DEEPENED (real staircase) when its
 *  R5-mapped gate / self-probe reaches this; below ⇒ leaves are only the
 *  low-confidence QCM prior (Dyy/D12), never a measured rung. Mirrors
 *  staircase.DEFAULT_THETA_OPEN (kept local — renderer/main boundary). */
export const TREE_THETA_OPEN = 0.6;

/** Discounted-prior colour ceiling — a low-confidence value must never
 *  fill more than this so it can't read as a strong measurement. */
export const PRIOR_BAR_CAP = 0.28;

/**
 * Scoring scheme tag from the signature. Mirrors
 * `BehavioralSignature.scoring_scheme`; the geometry math switches on it.
 * Absent ⇒ legacy `breaking-rung-v0` (pre-étape-1 signatures).
 */
export type ScoringScheme = 'beta-laplace-v1' | 'breaking-rung-v0';

/**
 * Where a value comes from — drives honest rendering:
 *  - `rung` : a real staircase measurement (Beta-Laplace climb OR a
 *             legacy breaking-rung integer);
 *  - `prior`: a discounted QCM prior on a NON-deepened branch, or any
 *             other low-confidence/fractional value;
 *  - `none` : never measured (render empty, NOT a misleading 0).
 */
export type Provenance = 'rung' | 'prior' | 'none';

export type TreeLeafDatum = {
  branch: CompetenceBranch;
  leaf: string;
  leafId: string;
  /** Normalised competence in [0,1] (or null when not measured). */
  score: number | null;
  /** Sample size behind the leaf score (small ⇒ noisy). */
  n?: number;
  /**
   * Beta-Laplace only — number of items PASSED at this leaf (audit + the
   * "fully mastered" predicate). Absent under `breaking-rung-v0`.
   */
  passes?: number;
  provenance: Provenance;
  /** 0..1 bar fill (prior is capped; none ⇒ 0). */
  fill: number;
};

export type TreeBranchDatum = {
  branch: CompetenceBranch;
  /** Branch prior (R5-mapped gate / self-probe), or null when absent. */
  score: number | null;
  provenance: Provenance;
  /** True once the branch cleared θ_open (real staircase deepening). */
  opened: boolean;
  leaves: TreeLeafDatum[];
};

export type TreeData = TreeBranchDatum[];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Normalised competence weight for a score on a branch, scheme-aware:
 *  - `safety` is binary 0/1 regardless of scheme;
 *  - `beta-laplace-v1`: score is ALREADY in [0,1] — clamp only;
 *  - `breaking-rung-v0`: legacy 1..3 ladder — normalise via `/TREE_MAX_RUNG`.
 */
function weightOf(
  branch: CompetenceBranch,
  score: number | null,
  scheme: ScoringScheme,
): number {
  if (score === null) return 0;
  if (branch === 'safety') return clamp01(score);
  if (scheme === 'beta-laplace-v1') return clamp01(score);
  return clamp01(score / TREE_MAX_RUNG);
}

/** A branch is "deepened" (real staircase) iff its prior cleared θ_open. */
export function branchOpened(branchScore: number | null): boolean {
  return branchScore !== null && branchScore >= TREE_THETA_OPEN;
}

export function branchProvenance(branchScore: number | null): Provenance {
  if (branchScore === null) return 'none';
  return branchScore >= TREE_THETA_OPEN ? 'rung' : 'prior';
}

/**
 * Leaf provenance, scheme-aware:
 *  - `score === null` ⇒ never measured ⇒ `none`.
 *  - `beta-laplace-v1`: a leaf carries a real climb iff its branch was
 *    deepened AND `passes_per_leaf` has an entry (the staircase emits one
 *    per measured leaf; QCM priors don't — see characterizeTree.ts).
 *  - `breaking-rung-v0` (legacy): a real rung is an integer; a fractional
 *    value is the discounted QCM prior (qcmDiscount·pass — Dyy/D12), and
 *    an un-deepened branch can only carry priors.
 */
export function leafProvenance(
  branchScore: number | null,
  score: number | null,
  scheme: ScoringScheme,
  hasPasses = false,
): Provenance {
  if (score === null) return 'none';
  if (!branchOpened(branchScore)) return 'prior';
  if (scheme === 'beta-laplace-v1') return hasPasses ? 'rung' : 'prior';
  return score === Math.round(score) ? 'rung' : 'prior';
}

/** Bar fill for a classified value (prior capped, none ⇒ 0). */
export function barFill(
  branch: CompetenceBranch,
  score: number | null,
  provenance: Provenance,
  scheme: ScoringScheme = 'breaking-rung-v0',
): number {
  if (provenance === 'none') return 0;
  const w = weightOf(branch, score, scheme);
  return provenance === 'prior' ? Math.min(PRIOR_BAR_CAP, w) : w;
}

// ---------------------------------------------------------------------------
// Measured-only radar (user 2026-05-19: a CHART, only what was really tested
// — exclude untested AND QCM priors, which are low-confidence/non-maximal).
// Self-contained geometry (the R5 radarGeometry is typed to DiagnosticAxis;
// duplicating ~40 lines beats casting leaf ids through that boundary).
// ---------------------------------------------------------------------------

export type RadarPoint = { x: number; y: number };

export type LeafRadarDatum = {
  /** `${branch}·${leaf}` — the axis label. */
  label: string;
  /** 0..1 normalised competence. */
  value: number;
  /** Raw signature score (shown next to the axis, like the R5 radar's %). */
  raw: number;
  n?: number;
};

export type LeafRadarAxis = LeafRadarDatum & {
  angleDeg: number;
  spokeEnd: RadarPoint;
  valuePoint: RadarPoint;
  labelPoint: RadarPoint;
  labelAnchor: 'start' | 'middle' | 'end';
};

export type LeafRadarGeometry = {
  size: number;
  center: RadarPoint;
  radius: number;
  axes: LeafRadarAxis[];
  rings: { level: number; points: RadarPoint[] }[];
  valuePolygon: RadarPoint[];
} | null;

/** A radar needs ≥ this many spokes to be a polygon, not a line. */
export const MIN_RADAR_AXES = 3;

const RADAR_EPS = 1e-9;
function r3(n: number): number {
  const v = Math.round((n + RADAR_EPS) * 1000) / 1000;
  return v === 0 ? 0 : v;
}
function pointAt(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): RadarPoint {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: r3(cx + radius * Math.cos(rad)),
    y: r3(cy + radius * Math.sin(rad)),
  };
}

/**
 * Scheme-aware "fully mastered" predicate for a measured leaf:
 *
 *  - `beta-laplace-v1` (current): `passes === n && n > 0`. The Beta-
 *    Laplace value at full mastery saturates at 0.8 for a 3-item ladder
 *    (no Phase B), so `value === 1` would be empirically unreachable —
 *    we key the predicate on the underlying pass counts instead.
 *  - `breaking-rung-v0` (legacy): `value === 1` (i.e. top of the 1..3
 *    ladder after the `/TREE_MAX_RUNG` normalisation). Preserves the
 *    "only the top rung" intent users approved on 2026-05-19.
 */
function isFullyMastered(
  leaf: TreeLeafDatum,
  value: number,
  scheme: ScoringScheme,
): boolean {
  if (scheme === 'beta-laplace-v1') {
    return leaf.passes !== undefined && leaf.n !== undefined && leaf.n > 0
      ? leaf.passes === leaf.n
      : false;
  }
  return value === 1;
}

/**
 * ONLY the leaves the staircase actually measured (`provenance === 'rung'`)
 * AND fully mastered (every item passed). QCM priors, partial climbs and
 * never-measured leaves are excluded — an honest chart of strengths only.
 * Stable `COMPETENCE_TREE` order.
 *
 * Scheme is taken from the first leaf's enclosing branch via
 * `treeDataFromSignature` — every leaf in a single TreeData uses the same
 * scheme, so we accept it as an explicit second arg to keep the function
 * pure (no peeking at module-level state).
 */
export function measuredRadarData(
  data: TreeData,
  scheme: ScoringScheme = 'breaking-rung-v0',
): LeafRadarDatum[] {
  const out: LeafRadarDatum[] = [];
  for (const b of data) {
    // `safety` is a binary policy flag, not a graded skill: a self-probe
    // pass would otherwise masquerade as a "100% competence" (user
    // 2026-05-19 explicitly rejected it). It stays in the breakdown text.
    if (b.branch === 'safety') continue;
    for (const l of b.leaves) {
      if (l.provenance !== 'rung' || l.score === null) continue;
      const value = weightOf(b.branch, l.score, scheme);
      if (!isFullyMastered(l, value, scheme)) continue;
      out.push({
        label: `${b.branch}·${l.leaf}`,
        value,
        raw: l.score,
        n: l.n,
      });
    }
  }
  return out;
}

/**
 * Deterministic radar geometry over measured-only leaves. Returns `null`
 * when fewer than {@link MIN_RADAR_AXES} were really measured (caller
 * shows an explanatory message instead — D8.B: don't pad a fake polygon).
 */
export function buildLeafRadar(
  items: LeafRadarDatum[],
  opts: {
    size?: number;
    padding?: number;
    rings?: number[];
    startAngleDeg?: number;
    labelOffsetFactor?: number;
  } = {},
): LeafRadarGeometry {
  if (!Array.isArray(items) || items.length < MIN_RADAR_AXES) return null;
  const size = opts.size ?? 100;
  const padding = opts.padding ?? 0;
  const startAngleDeg = opts.startAngleDeg ?? -90;
  const ringLevels = (opts.rings ?? [0.25, 0.5, 0.75, 1])
    .filter((l) => l > 0 && l <= 1)
    .sort((a, b) => a - b);
  const labelOffsetFactor = opts.labelOffsetFactor ?? 0.18;
  const cx = size / 2;
  const cy = size / 2;
  const radius = Math.max(0, size / 2 - padding);
  const n = items.length;
  const step = 360 / n;

  const axes: LeafRadarAxis[] = items.map((d, i) => {
    const angleDeg = startAngleDeg + step * i;
    const value = clamp01(d.value);
    const c = Math.cos((angleDeg * Math.PI) / 180);
    let labelAnchor: LeafRadarAxis['labelAnchor'];
    if (Math.abs(c) < 0.05) labelAnchor = 'middle';
    else labelAnchor = c > 0 ? 'start' : 'end';
    return {
      ...d,
      value,
      angleDeg,
      spokeEnd: pointAt(cx, cy, radius, angleDeg),
      valuePoint: pointAt(cx, cy, radius * value, angleDeg),
      labelPoint: pointAt(cx, cy, radius * (1 + labelOffsetFactor), angleDeg),
      labelAnchor,
    };
  });
  const rings = ringLevels.map((level) => ({
    level,
    points: items.map((_, i) =>
      pointAt(cx, cy, radius * level, startAngleDeg + step * i),
    ),
  }));
  return {
    size,
    center: { x: r3(cx), y: r3(cy) },
    radius: r3(radius),
    axes,
    rings,
    valuePolygon: axes.map((a) => a.valuePoint),
  };
}

/** SVG `points=""` string for a closed polygon. */
export function toPointsAttr(points: RadarPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/**
 * Project a behavioral signature onto the FROZEN tree. Always returns the
 * full COMPETENCE_TREE shape (stable across runs), each value classified
 * by {@link Provenance}. Resilient to a partial / absent signature. The
 * `scoring_scheme` field drives the math; absent ⇒ legacy
 * `'breaking-rung-v0'`.
 */
export function treeDataFromSignature(
  beh:
    | Pick<
        BehavioralSignature,
        | 'scores_per_leaf'
        | 'branch_scores'
        | 'n_per_leaf'
        | 'passes_per_leaf'
        | 'scoring_scheme'
      >
    | null
    | undefined,
): TreeData {
  const spl = beh?.scores_per_leaf ?? {};
  const bs = beh?.branch_scores ?? {};
  const npl = beh?.n_per_leaf ?? {};
  const ppl = beh?.passes_per_leaf ?? {};
  const scheme: ScoringScheme = beh?.scoring_scheme ?? 'breaking-rung-v0';
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  return (Object.keys(COMPETENCE_TREE) as CompetenceBranch[]).map((branch) => {
    const bScore = num(bs[branch]);
    const bProv = branchProvenance(bScore);
    return {
      branch,
      score: bScore,
      provenance: bProv,
      opened: branchOpened(bScore),
      leaves: COMPETENCE_TREE[branch].map((leaf) => {
        const leafId = `${branch}.${leaf}`;
        const lScore = num(spl[leafId]);
        const passes = num(ppl[leafId]);
        const hasPasses = passes !== null;
        const lProv = leafProvenance(bScore, lScore, scheme, hasPasses);
        return {
          branch,
          leaf,
          leafId,
          score: lScore,
          n: num(npl[leafId]) ?? undefined,
          passes: hasPasses ? (passes as number) : undefined,
          provenance: lProv,
          fill: barFill(branch, lScore, lProv, scheme),
        };
      }),
    };
  });
}

/** True iff any branch prior or leaf score was actually measured. */
export function hasTreeData(
  beh:
    | Pick<BehavioralSignature, 'scores_per_leaf' | 'branch_scores'>
    | null
    | undefined,
): boolean {
  const finite = (o: Record<string, unknown> | undefined) =>
    !!o &&
    Object.values(o).some((v) => typeof v === 'number' && Number.isFinite(v));
  return finite(beh?.scores_per_leaf) || finite(beh?.branch_scores);
}

/**
 * Plain-text breakdown of the tree (copyable — every UI text block must
 * be copyable). One block per branch with its R5 prior + deepening state,
 * then each leaf with its value, sample size and a `~qcm-prior` tag.
 *
 * Under `beta-laplace-v1`, the leaf line also shows `passes/n` when both
 * are present so the user can read the underlying pass counts behind the
 * smoothed score (e.g. `proba = 0.80 (3/3)` reads as "3 of 3 items passed,
 * Laplace-smoothed to 0.80").
 */
export function treeBreakdownText(data: TreeData): string {
  const fmt = (s: number | null) => (s === null ? '—' : s.toFixed(2));
  return data
    .map((b) => {
      const state =
        b.score === null
          ? 'no R5 data'
          : b.opened
            ? 'deepened'
            : 'closed (prior only)';
      const head = `${b.branch}  [R5 ${fmt(b.score)} · ${state}]`;
      const leaves = b.leaves
        .map((l) => {
          const tag = l.provenance === 'prior' ? ' ~qcm-prior' : '';
          const counts =
            l.passes !== undefined && l.n !== undefined
              ? ` (${l.passes}/${l.n})`
              : l.n != null
                ? ` (n${l.n})`
                : '';
          return `  ${l.leaf} = ${fmt(l.score)}${counts}${tag}`;
        })
        .join('\n');
      return `${head}\n${leaves}`;
    })
    .join('\n\n');
}
