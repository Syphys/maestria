/**
 * Side-panel section displayed inside EntryProperties for model files.
 *
 * Slimmed down: this is now strictly about *running* the model. The data
 * actions (Parse header / Fetch from HF / Reset) have been co-located
 * with their effects — "Generate tags" lives next to the tags chips in
 * EntryProperties, "Fetch from Hugging Face" lives in the Description
 * tab next to the HF encart. Bulk equivalents stay in the always-on
 * Models Hub status bar at the bottom of the sidebar.
 *
 * What's left here:
 *  - Run button + the (warning) non-canonical-shard pointer.
 *  - RunParamsEditor — model-specific launch params.
 */

import { useEffect, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { isSupportedModelFile } from './parsers';
import { fetchModelMeta } from './useModelMeta';
import { ModelMeta } from './types';
import RunModelButton from './runners/RunModelButton';
import { canonicalShardName, detectShardInfo, isCanonicalShard } from './shard';
import RunParamsEditor from './RunParamsEditor';
import CompetenceSection from './radar/CompetenceSection';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

interface Props {
  filePath?: string;
  /** When true, sidecar writes are skipped (read-only location). */
  readOnly?: boolean;
}

export function ModelHubPanel({
  filePath,
  readOnly,
}: Props): JSX.Element | null {
  const [meta, setMeta] = useState<ModelMeta | undefined>();

  const supported = !!filePath && isSupportedModelFile(filePath);

  useEffect(() => {
    let cancelled = false;
    setMeta(undefined);
    if (!supported || !filePath) return;
    fetchModelMeta(filePath)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
      })
      .catch(() => {
        /* non-fatal — RunParamsEditor will load empty defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, supported]);

  if (!supported) return null;

  // When the user opens a non-canonical shard (e.g. shard 7/12), surface a
  // pointer to the canonical entry so they understand why the Run button
  // is tied to a different file. We don't auto-navigate — the
  // location/file manager is the user's, not ours to pilot.
  const fileBase = filePath ? basename(filePath) : '';
  const nonCanonical =
    !!fileBase && !!detectShardInfo(fileBase) && !isCanonicalShard(fileBase);
  const canonicalSibling = nonCanonical ? canonicalShardName(fileBase) : '';

  return (
    <Box
      data-tid="modelhubPanel"
      sx={{
        // Hosted inside the dedicated Inférence tab — the tab content
        // already has its own outer chrome, so a second border + radius
        // here would draw a redundant frame inside a frame. The
        // "Models Hub" title that used to sit here is dropped for the
        // same reason: the tab label already says "Inférence", a second
        // heading inside its body is noise.
        mt: 1,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        sx={{ mb: 1 }}
        flexWrap="wrap"
        gap={1}
      >
        {filePath && (
          <RunModelButton
            filePath={filePath}
            preferredRunnerId={meta?.preferredRunnerId}
          />
        )}
        {nonCanonical && (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ width: '100%', display: 'block', mt: 0.5 }}
          >
            This is a non-canonical shard. Run applies to the canonical sibling:{' '}
            <code>{canonicalSibling}</code>.
          </Typography>
        )}
      </Stack>

      <Stack spacing={1.5}>
        {filePath && (
          <RunParamsEditor
            filePath={filePath}
            initialUserParams={meta?.userRunParams}
            initialPreferredRunnerId={meta?.preferredRunnerId}
            initialFitProbe={meta?.fitProbe}
            onSaved={(next) =>
              setMeta((prev) =>
                prev ? { ...prev, userRunParams: next } : prev,
              )
            }
            onPreferredRunnerSaved={(next) =>
              setMeta((prev) =>
                prev ? { ...prev, preferredRunnerId: next } : prev,
              )
            }
            onFitProbeSaved={(next) =>
              setMeta((prev) => (prev ? { ...prev, fitProbe: next } : prev))
            }
          />
        )}
        {filePath && (
          <CompetenceSection filePath={filePath} readOnly={readOnly} />
        )}
      </Stack>
    </Box>
  );
}

export default ModelHubPanel;
