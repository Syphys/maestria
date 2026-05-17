/**
 * Slice 3 — Competence radar, SVG view.
 * Spec: SEMANTIC_ROUTING_FEATURES.md §R9.8 ; arbitration: DECISIONS.md D7.
 *
 * A thin, theme-aware SVG wrapper over the pure `buildRadarGeometry` core.
 * No charting dependency (D7). Two variants:
 *   - `mini`  — tile glyph: value polygon + faint outer ring, no labels,
 *                non-interactive (replaces the lost generic preview image);
 *   - `full`  — detail view: rings, spokes, labelled axes with score + n,
 *                centre overall, clickable axes (audit drill-down — D7).
 *
 * Returns `null` when there are fewer than 3 measured axes — the caller
 * renders its own placeholder / icon fallback (D8.B: absent ≠ 0).
 */

import { useState } from 'react';
import { useTheme, alpha } from '@mui/material';
import type { DiagnosticAxis } from '../../../shared/RoutingTypes';
import {
  buildRadarGeometry,
  toPointsAttr,
  type RadarAxisDatum,
} from './radarGeometry';

export interface CompetenceRadarProps {
  data: RadarAxisDatum[];
  variant?: 'mini' | 'full';
  /** SVG pixel side. Default: 72 (mini) / 280 (full). */
  size?: number;
  /** Mean over all scored items — shown in the centre (full only). */
  overall?: number;
  /** Audit drill-down: click an axis → caller shows its prompts/responses. */
  onAxisClick?: (axis: DiagnosticAxis) => void;
  /** Optional title for the accessible label. */
  title?: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function CompetenceRadar({
  data,
  variant = 'full',
  size,
  overall,
  onAxisClick,
  title,
}: CompetenceRadarProps): JSX.Element | null {
  const theme = useTheme();
  const [hovered, setHovered] = useState<DiagnosticAxis | null>(null);

  const mini = variant === 'mini';
  const px = size ?? (mini ? 72 : 280);

  // Full mode reserves a ring of space for labels; mini bleeds to the edge.
  const geom = buildRadarGeometry(data, {
    size: 100,
    padding: mini ? 4 : 22,
    rings: mini ? [1] : [0.25, 0.5, 0.75, 1],
    labelOffsetFactor: 0.16,
  });
  if (!geom) return null;

  const gridColor = theme.palette.divider;
  const valStroke = theme.palette.primary.main;
  const valFill = alpha(theme.palette.primary.main, mini ? 0.45 : 0.22);
  const labelColor = theme.palette.text.secondary;
  const hoverColor = theme.palette.primary.main;

  const accLabel =
    title ??
    `Competence radar: ${data
      .map((d) => `${d.axis} ${pct(d.score)}`)
      .join(', ')}`;

  return (
    <svg
      viewBox={`0 0 ${geom.size} ${geom.size}`}
      width={px}
      height={px}
      role="img"
      aria-label={accLabel}
      style={{
        display: 'block',
        overflow: 'visible',
        pointerEvents: mini ? 'none' : undefined,
      }}
    >
      {/* Grid rings */}
      {geom.rings.map((ring) => (
        <polygon
          key={`ring-${ring.level}`}
          points={toPointsAttr(ring.points)}
          fill="none"
          stroke={gridColor}
          strokeWidth={mini ? 0.6 : 0.5}
          opacity={mini ? 0.5 : 0.7}
        />
      ))}

      {/* Spokes (full only) */}
      {!mini &&
        geom.axes.map((a) => (
          <line
            key={`spoke-${a.axis}`}
            x1={geom.center.x}
            y1={geom.center.y}
            x2={a.spokeEnd.x}
            y2={a.spokeEnd.y}
            stroke={gridColor}
            strokeWidth={0.5}
            opacity={0.6}
          />
        ))}

      {/* Value polygon */}
      <polygon
        points={toPointsAttr(geom.valuePolygon)}
        fill={valFill}
        stroke={valStroke}
        strokeWidth={mini ? 1.4 : 1}
        strokeLinejoin="round"
      />

      {/* Value vertices + interactive axis labels (full only) */}
      {!mini &&
        geom.axes.map((a) => {
          const isHot = hovered === a.axis;
          const clickable = !!onAxisClick;
          return (
            <g
              key={`axis-${a.axis}`}
              onClick={clickable ? () => onAxisClick?.(a.axis) : undefined}
              onMouseEnter={() => setHovered(a.axis)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(a.axis)}
              onBlur={() => setHovered(null)}
              tabIndex={clickable ? 0 : undefined}
              role={clickable ? 'button' : undefined}
              aria-label={
                clickable
                  ? `${a.axis}: ${pct(a.score)}${
                      a.n != null ? `, ${a.n} items` : ''
                    }`
                  : undefined
              }
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <circle
                cx={a.valuePoint.x}
                cy={a.valuePoint.y}
                r={isHot ? 2.4 : 1.6}
                fill={valStroke}
              />
              <text
                x={a.labelPoint.x}
                y={a.labelPoint.y}
                fontSize={5.5}
                fontWeight={isHot ? 700 : 500}
                textAnchor={a.labelAnchor}
                dominantBaseline="middle"
                fill={isHot ? hoverColor : labelColor}
              >
                {a.axis}
              </text>
              <text
                x={a.labelPoint.x}
                y={a.labelPoint.y + 6}
                fontSize={4.5}
                textAnchor={a.labelAnchor}
                dominantBaseline="middle"
                fill={labelColor}
                opacity={0.85}
              >
                {pct(a.score)}
                {a.n != null ? ` ·n${a.n}` : ''}
              </text>
            </g>
          );
        })}

      {/* Centre overall (full only) */}
      {!mini && typeof overall === 'number' && Number.isFinite(overall) && (
        <text
          x={geom.center.x}
          y={geom.center.y}
          fontSize={9}
          fontWeight={700}
          textAnchor="middle"
          dominantBaseline="central"
          fill={theme.palette.text.primary}
        >
          {pct(overall)}
        </text>
      )}
    </svg>
  );
}

export default CompetenceRadar;
