/**
 * Slice 3 — Tile glyph: the competence mini-radar that replaces the
 * generic preview image for characterized model files in the grid
 * perspective. Spec: SEMANTIC_ROUTING_FEATURES.md §R9.8 ; D7 (a).
 *
 * Self-contained so GridCell's diff stays a one-liner and the signature
 * IPC never runs for non-model files or off-screen cells:
 *   - not a model file              → render `fallback` (the EntryIcon)
 *   - model file, no/short signature → render `fallback`
 *   - model file, ≥3 measured axes  → render the mini-radar
 *
 * The fetch is gated on `isVisible` (GridCell already lazy-loads thumbs
 * the same way) so scrolling a large folder doesn't flood IPC.
 */

import { isSupportedModelFile } from '../parsers';
import { useSignature } from '../useSignature';
import { CompetenceRadar } from './CompetenceRadar';
import { axisDataFromSignature, MIN_RADAR_AXES } from './radarGeometry';

interface Props {
  filePath: string;
  isVisible: boolean;
  /** Rendered whenever there's no radar to show (the generic EntryIcon). */
  fallback: JSX.Element;
  /** Glyph side in px. Default 132 (large enough for the axis labels). */
  size?: number;
}

export function ModelTileGlyph({
  filePath,
  isVisible,
  fallback,
  size = 132,
}: Props): JSX.Element {
  const isModel = !!filePath && isSupportedModelFile(filePath);
  const { signature } = useSignature(filePath, isVisible && isModel);

  if (!isModel) return fallback;

  const data = axisDataFromSignature(signature?.behavioral ?? null);
  if (data.length < MIN_RADAR_AXES) return fallback;

  return (
    <CompetenceRadar
      data={data}
      variant="mini"
      size={size}
      showLabels
      title={filePath.replace(/^.*[\\/]/, '')}
    />
  );
}

export default ModelTileGlyph;
