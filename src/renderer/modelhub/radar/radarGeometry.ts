// Slice 3 — Competence radar, pure geometry.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R9.8 ; arbitration: DECISIONS.md D7.
//
// Turns the already-computed deterministic competence vector
// (signature.behavioral.scores_per_axis) into deterministic SVG geometry:
// concentric grid rings, axis spokes, and the value polygon. No React, no
// I/O, no charting dependency (D7) — this is the unit-testable core; the
// <CompetenceRadar> component is a thin SVG wrapper over it.
//
// Coordinate system: SVG screen space (y grows downward). Spoke 0 points
// straight up (−90°), the rest go clockwise, evenly spaced.

import type {
  BehavioralSignature,
  DiagnosticAxis,
} from '../../../shared/RoutingTypes';

export type RadarAxisDatum = {
  axis: DiagnosticAxis;
  /** 0..1; clamped + NaN-guarded by buildRadarGeometry. */
  score: number;
  /** Sample size behind the axis (small ⇒ noisy). Surfaced by the UI. */
  n?: number;
};

export type RadarPoint = { x: number; y: number };

export type RadarAxisGeometry = {
  axis: DiagnosticAxis;
  score: number;
  n?: number;
  angleDeg: number;
  /** On the outer ring (full radius) — the spoke tip. */
  spokeEnd: RadarPoint;
  /** On the value polygon — at radius·score. */
  valuePoint: RadarPoint;
  /** Just outside the outer ring — where a text label sits (full mode). */
  labelPoint: RadarPoint;
  /** SVG text-anchor matching the label side, so labels never overlap the chart. */
  labelAnchor: 'start' | 'middle' | 'end';
};

export type RadarGeometry = {
  /** viewBox is `0 0 size size` (square). */
  size: number;
  center: RadarPoint;
  radius: number;
  axes: RadarAxisGeometry[];
  /** Concentric grid polygons, one per `rings` level (0..1). */
  rings: { level: number; points: RadarPoint[] }[];
  /** Closed polygon (axis order) of every `valuePoint`. */
  valuePolygon: RadarPoint[];
};

export type RadarOptions = {
  /** Square viewBox side. Default 100. */
  size?: number;
  /** Inset from the edge (reserve room for labels in full mode). Default 0. */
  padding?: number;
  /** Grid ring levels in (0,1]. Default [0.25, 0.5, 0.75, 1]. */
  rings?: number[];
  /** Angle of spoke 0, degrees. Default −90 (straight up). */
  startAngleDeg?: number;
  /** Fraction of `radius` to push labels beyond the outer ring. Default 0.18. */
  labelOffsetFactor?: number;
};

/** A radar needs at least this many spokes to be a polygon (not a line). */
export const MIN_RADAR_AXES = 3;

/**
 * Axis / branch key → i18n key (single source of truth, used by the R5
 * radar and the per-axis drill-down). `lang` is the presentation-only
 * merged language axis. Pure constant — translation happens in the view.
 */
export const AXIS_I18N: Record<string, string> = {
  code: 'core:mhAxisCode',
  math: 'core:mhAxisMath',
  reasoning: 'core:mhAxisReasoning',
  multistep: 'core:mhAxisMultistep',
  meta: 'core:mhAxisMeta',
  instruction: 'core:mhAxisInstruction',
  factual: 'core:mhAxisFactual',
  longctx: 'core:mhAxisLongctx',
  lang: 'core:mhAxisLang',
  creative: 'core:mhAxisCreative',
  vision: 'core:mhAxisVision',
  fim: 'core:mhAxisFim',
  refusal: 'core:mhAxisRefusal',
  qcm: 'core:mhAxisQcm',
  tooluse: 'core:mhAxisTooluse',
  robustness: 'core:mhAxisRobustness',
  calibration: 'core:mhAxisCalibration',
};

/** Axis / branch key → i18n key for the human-readable DEFINITION shown
 *  on hover (SVG title) and at the top of the click drill-down. */
export const AXIS_DESC_I18N: Record<string, string> = {
  code: 'core:mhAxisDescCode',
  math: 'core:mhAxisDescMath',
  reasoning: 'core:mhAxisDescReasoning',
  multistep: 'core:mhAxisDescMultistep',
  meta: 'core:mhAxisDescMeta',
  instruction: 'core:mhAxisDescInstruction',
  factual: 'core:mhAxisDescFactual',
  longctx: 'core:mhAxisDescLongctx',
  lang: 'core:mhAxisDescLang',
  creative: 'core:mhAxisDescCreative',
  vision: 'core:mhAxisDescVision',
  fim: 'core:mhAxisDescFim',
  refusal: 'core:mhAxisDescRefusal',
  qcm: 'core:mhAxisDescQcm',
  tooluse: 'core:mhAxisDescTooluse',
  robustness: 'core:mhAxisDescRobustness',
  calibration: 'core:mhAxisDescCalibration',
};

const TWO_DECIMAL_EPS = 1e-9;

/** Round to 3 decimals — compact, stable SVG output + deterministic tests. */
function r3(n: number): number {
  const v = Math.round((n + TWO_DECIMAL_EPS) * 1000) / 1000;
  // Normalise -0 to 0 so snapshots/string output never flip sign.
  return v === 0 ? 0 : v;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
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
 * Build deterministic radar geometry from the per-axis competence data.
 * Returns `null` when there are fewer than {@link MIN_RADAR_AXES} axes — the
 * caller renders the "not characterized" placeholder instead (D8.B: an absent
 * axis is "no data", never a misleading 0, so we don't pad up to 3).
 */
export function buildRadarGeometry(
  data: RadarAxisDatum[],
  opts: RadarOptions = {},
): RadarGeometry | null {
  if (!Array.isArray(data) || data.length < MIN_RADAR_AXES) return null;

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
  const center: RadarPoint = { x: r3(cx), y: r3(cy) };

  const n = data.length;
  const step = 360 / n;

  const axes: RadarAxisGeometry[] = data.map((d, i) => {
    const angleDeg = startAngleDeg + step * i;
    const score = clamp01(d.score);
    const c = Math.cos((angleDeg * Math.PI) / 180);
    let labelAnchor: RadarAxisGeometry['labelAnchor'];
    if (Math.abs(c) < 0.05) labelAnchor = 'middle';
    else labelAnchor = c > 0 ? 'start' : 'end';
    return {
      axis: d.axis,
      score,
      n: d.n,
      angleDeg,
      spokeEnd: pointAt(cx, cy, radius, angleDeg),
      valuePoint: pointAt(cx, cy, radius * score, angleDeg),
      labelPoint: pointAt(cx, cy, radius * (1 + labelOffsetFactor), angleDeg),
      labelAnchor,
    };
  });

  const rings = ringLevels.map((level) => ({
    level,
    points: data.map((_, i) =>
      pointAt(cx, cy, radius * level, startAngleDeg + step * i),
    ),
  }));

  return {
    size,
    center,
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
 * Extract the radar input from a behavioral signature. Only axes that were
 * actually measured (present in `scores_per_axis` with a finite number) are
 * returned; ordering is alphabetical so the radar shape is stable across runs
 * regardless of suite/worklist order.
 */
export function axisDataFromSignature(
  beh:
    | Pick<BehavioralSignature, 'scores_per_axis' | 'n_per_axis'>
    | null
    | undefined,
): RadarAxisDatum[] {
  if (!beh || !beh.scores_per_axis) return [];
  const out: RadarAxisDatum[] = [];
  const axes = Object.keys(beh.scores_per_axis).sort() as DiagnosticAxis[];
  for (const axis of axes) {
    const score = beh.scores_per_axis[axis];
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    out.push({ axis, score, n: beh.n_per_axis?.[axis] });
  }
  return out;
}
