/**
 * Slice 6c — Competence tree, MEASURED-ONLY radar.
 * Spec: SEMANTIC_ROUTING_FEATURES/SPEC-vector-routing-v0.md §2/§5/§6 ;
 * arbitration: DECISIONS.md D7 (no charting dependency).
 *
 * User feedback 2026-05-19: a real chart, but ONLY the leaves the
 * staircase actually measured (`provenance === 'rung'`). QCM priors and
 * never-tested domains are excluded — a low-confidence/non-maximal value
 * must not pad the shape. Same SVG idiom as the R5 <CompetenceRadar>, so
 * the two charts read alike; the full per-leaf truth (priors included)
 * stays in the copyable breakdown the parent renders below.
 *
 * Returns an explanatory message (not a fake polygon) when fewer than 3
 * leaves were really measured — D8.B: absent ≠ 0.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Chip, Stack, Typography, alpha, useTheme } from '@mui/material';
import {
  measuredRadarData,
  buildLeafRadar,
  toPointsAttr,
  type ScoringScheme,
  type TreeData,
} from './treeSunburstGeometry';

export interface CompetenceTreeProps {
  data: TreeData;
  /**
   * Scoring scheme tag from the signature — drives the "fully mastered"
   * predicate inside {@link measuredRadarData}. Defaults to the legacy
   * `breaking-rung-v0` to keep pre-étape-1 callers unchanged.
   */
  scheme?: ScoringScheme;
  /** SVG pixel side. Default 300. */
  size?: number;
}

function fmtRaw(n: number): string {
  return n === Math.round(n) ? String(n) : n.toFixed(2);
}

export function CompetenceTree({
  data,
  scheme,
  size,
}: CompetenceTreeProps): JSX.Element | null {
  const { t } = useTranslation();
  const theme = useTheme();
  const [hovered, setHovered] = useState<string | null>(null);
  const px = size ?? 300;

  const items = measuredRadarData(data, scheme);
  const geom = buildLeafRadar(items, {
    size: 100,
    padding: 24,
    labelOffsetFactor: 0.14,
  });

  if (!geom) {
    // 0 mastered ⇒ short honest message; 1–2 ⇒ a real graphic (medal
    // chips), never the sad "not enough for a radar" wall.
    if (items.length === 0) {
      return (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ userSelect: 'text', textAlign: 'center', py: 2 }}
        >
          {t('core:mhTreeRadarEmpty')}
        </Typography>
      );
    }
    return (
      <Box sx={{ py: 1, textAlign: 'center' }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 1 }}
        >
          {t('core:mhTreeMasteredTitle')}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          justifyContent="center"
          flexWrap="wrap"
          useFlexGap
        >
          {items.map((d) => (
            <Chip
              key={d.label}
              color="primary"
              variant="filled"
              size="small"
              label={`${d.label} · ${fmtRaw(d.raw)}${
                d.n != null ? ` ·n${d.n}` : ''
              }`}
              sx={{ fontFamily: 'monospace', userSelect: 'text' }}
            />
          ))}
        </Stack>
      </Box>
    );
  }

  const gridColor = theme.palette.divider;
  const valStroke = theme.palette.primary.main;
  const valFill = alpha(theme.palette.primary.main, 0.22);
  const labelColor = theme.palette.text.secondary;
  const hot = theme.palette.primary.main;

  return (
    <svg
      viewBox={`0 0 ${geom.size} ${geom.size}`}
      width={px}
      height={px}
      role="img"
      aria-label={`Measured competence radar: ${items
        .map((d) => `${d.label} ${fmtRaw(d.raw)}`)
        .join(', ')}`}
      style={{ display: 'block', overflow: 'visible', margin: '0 auto' }}
    >
      {geom.rings.map((ring) => (
        <polygon
          key={`ring-${ring.level}`}
          points={toPointsAttr(ring.points)}
          fill="none"
          stroke={gridColor}
          strokeWidth={0.5}
          opacity={0.7}
        />
      ))}

      {geom.axes.map((a) => (
        <line
          key={`spoke-${a.label}`}
          x1={geom.center.x}
          y1={geom.center.y}
          x2={a.spokeEnd.x}
          y2={a.spokeEnd.y}
          stroke={gridColor}
          strokeWidth={0.5}
          opacity={0.6}
        />
      ))}

      <polygon
        points={toPointsAttr(geom.valuePolygon)}
        fill={valFill}
        stroke={valStroke}
        strokeWidth={1}
        strokeLinejoin="round"
      />

      {geom.axes.map((a) => {
        const isHot = hovered === a.label;
        return (
          <g
            key={`axis-${a.label}`}
            onMouseEnter={() => setHovered(a.label)}
            onMouseLeave={() => setHovered(null)}
          >
            <circle
              cx={a.valuePoint.x}
              cy={a.valuePoint.y}
              r={isHot ? 2.2 : 1.5}
              fill={valStroke}
            />
            <text
              x={a.labelPoint.x}
              y={a.labelPoint.y}
              fontSize={4}
              fontWeight={isHot ? 700 : 500}
              textAnchor={a.labelAnchor}
              dominantBaseline="middle"
              fill={isHot ? hot : labelColor}
            >
              {a.label}
            </text>
            <text
              x={a.labelPoint.x}
              y={a.labelPoint.y + 4.6}
              fontSize={3.6}
              textAnchor={a.labelAnchor}
              dominantBaseline="middle"
              fill={labelColor}
              opacity={0.85}
            >
              {fmtRaw(a.raw)}
              {a.n != null ? ` ·n${a.n}` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default CompetenceTree;
