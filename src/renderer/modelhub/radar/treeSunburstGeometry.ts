// Slice 6c — Competence-tree readout model (pure, no charting dep — D7).
// Spec: SEMANTIC_ROUTING_FEATURES/SPEC-vector-routing-v0.md §2/§5/§6.
//
// The R5 radar (radarGeometry.ts) plots the COARSE per-axis vector. This
// is the FINE vector-routing tree: the frozen 7-branch ×23-leaf taxonomy
// (COMPETENCE_TREE), projected from a model's behavioral signature into a
// flat, READABLE structure the <CompetenceTree> component renders as
// grouped bars (the earlier sunburst was unreadable — user 2026-05-19).
//
// HONEST by construction: a leaf/branch carries a value ONLY for what was
// actually measured. `provenance` separates a real staircase rung from a
// low-confidence QCM prior (Dyy/D12) from "never measured" (D8.B) — a
// weak/absent domain must never look competent. Stays a unit-testable
// pure core (no React, no I/O).

import {
  COMPETENCE_TREE,
  type BehavioralSignature,
  type CompetenceBranch,
} from '../../../shared/RoutingTypes';

/** tree-v0 ladder ceiling — leaf scores are the breaking rung (1..3),
 *  unsaturated. `safety` is binary (max 1) and normalised on its own. */
export const TREE_MAX_RUNG = 3;

/** SPEC §3 θ_open — a branch is only DEEPENED (real staircase) when its
 *  R5-mapped gate / self-probe reaches this; below ⇒ leaves are only the
 *  low-confidence QCM prior (Dyy/D12), never a measured rung. Mirrors
 *  staircase.DEFAULT_THETA_OPEN (kept local — renderer/main boundary). */
export const TREE_THETA_OPEN = 0.6;

/** Discounted-prior colour ceiling — a low-confidence value must never
 *  fill more than this so it can't read as a strong measurement. */
export const PRIOR_BAR_CAP = 0.28;

/**
 * Where a value comes from — drives honest rendering:
 *  - `rung` : a real staircase breaking-rung measurement;
 *  - `prior`: a discounted QCM prior on a NON-deepened branch, or a
 *             fractional discounted value (low confidence);
 *  - `none` : never measured (render empty, NOT a misleading 0).
 */
export type Provenance = 'rung' | 'prior' | 'none';

export type TreeLeafDatum = {
  branch: CompetenceBranch;
  leaf: string;
  leafId: string;
  /** Breaking-rung score, or null when the leaf was not measured. */
  score: number | null;
  /** Sample size behind the leaf score (small ⇒ noisy). */
  n?: number;
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

/** Normalised competence weight for a score on a branch (safety binary). */
function weightOf(branch: CompetenceBranch, score: number | null): number {
  if (score === null) return 0;
  if (branch === 'safety') return clamp01(score);
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
 * Leaf provenance without per-leaf provenance stored in the signature: a
 * leaf is a real rung only when its branch was deepened AND the score is
 * an integer level (the staircase emits integer rungs); a fractional
 * value is the discounted QCM prior (qcmDiscount·pass — Dyy/D12), and an
 * un-deepened branch can only carry priors.
 */
export function leafProvenance(
  branchScore: number | null,
  score: number | null,
): Provenance {
  if (score === null) return 'none';
  if (!branchOpened(branchScore)) return 'prior';
  return score === Math.round(score) ? 'rung' : 'prior';
}

/** Bar fill for a classified value (prior capped, none ⇒ 0). */
export function barFill(
  branch: CompetenceBranch,
  score: number | null,
  provenance: Provenance,
): number {
  if (provenance === 'none') return 0;
  const w = weightOf(branch, score);
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
  /** 0..1 normalised competence (score/3, safety binary). */
  value: number;
  /** Raw breaking rung (shown next to the axis, like the R5 radar's %). */
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
 * ONLY the leaves the staircase actually measured (`provenance === 'rung'`):
 * QCM priors and never-measured leaves are excluded — an honest chart of
 * what was really tested. Stable `COMPETENCE_TREE` order.
 */
export function measuredRadarData(data: TreeData): LeafRadarDatum[] {
  const out: LeafRadarDatum[] = [];
  for (const b of data) {
    // `safety` is a binary policy flag, not a graded skill: a self-probe
    // pass would otherwise masquerade as a "100% competence" (user
    // 2026-05-19 explicitly rejected it). It stays in the breakdown text.
    if (b.branch === 'safety') continue;
    for (const l of b.leaves) {
      if (l.provenance !== 'rung' || l.score === null) continue;
      const value = weightOf(b.branch, l.score);
      // "Maximal competences only" (user 2026-05-19): keep a leaf ONLY
      // when fully mastered (normalised competence == 1 ⇒ top rung). A
      // measured-but-weak leaf (rung 1/2) is not a strength and never
      // enters the chart; it stays in the copyable breakdown.
      if (value < 1) continue;
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
 * full 7-branch ×23-leaf shape in `COMPETENCE_TREE` order (stable across
 * runs), each value classified by {@link Provenance}. Resilient to a
 * partial / absent signature.
 */
export function treeDataFromSignature(
  beh:
    | Pick<
        BehavioralSignature,
        'scores_per_leaf' | 'branch_scores' | 'n_per_leaf'
      >
    | null
    | undefined,
): TreeData {
  const spl = beh?.scores_per_leaf ?? {};
  const bs = beh?.branch_scores ?? {};
  const npl = beh?.n_per_leaf ?? {};
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
        const lProv = leafProvenance(bScore, lScore);
        return {
          branch,
          leaf,
          leafId,
          score: lScore,
          n: num(npl[leafId]) ?? undefined,
          provenance: lProv,
          fill: barFill(branch, lScore, lProv),
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
          const tag =
            l.provenance === 'prior'
              ? ' ~qcm-prior'
              : l.provenance === 'none'
                ? ''
                : '';
          return `  ${l.leaf} = ${fmt(l.score)}${
            l.n != null ? ` (n${l.n})` : ''
          }${tag}`;
        })
        .join('\n');
      return `${head}\n${leaves}`;
    })
    .join('\n\n');
}
