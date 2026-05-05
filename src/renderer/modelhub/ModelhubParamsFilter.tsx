/**
 * Models Hub — parameter-count filter chips.
 *
 * Sister widget to `ModelhubSizeFilter` (which gates on disk bytes). This
 * one filters on the abstract model size — `7B`, `30B`, `70B+` — using
 * the `size:<bucket>` system tags posted by `autoTags.ts` during
 * enrichment. Matters because a 70B model can be 35 GB (Q4) or 75 GB
 * (Q8) on disk; the disk-size slider can't tell those apart by capability.
 *
 * Multi-select: clicking N chips means "any of these" (OR within group).
 * Combines with the GB slider as AND (both filters must pass).
 *
 * Drives `tempSearchQuery.paramBuckets` via `setTempSearchQuery`. The
 * actual filter lives in `services/search.ts::applyModelhubFilters`.
 */

import { useCallback } from 'react';
import { Box, Chip, FormHelperText, Stack } from '@mui/material';
import { useSearchQueryContext } from '-/hooks/useSearchQueryContext';

/**
 * Bucket labels — must stay in sync with PARAM_BUCKETS in
 * `src/renderer/modelhub/autoTags.ts`. The `size:<label>` tag is what we
 * filter on, so any drift between this list and the auto-tag emitter
 * silently breaks chips.
 */
const BUCKETS = [
  '<1B',
  '1-3B',
  '3-7B',
  '7-13B',
  '13-30B',
  '30-70B',
  '70B+',
] as const;

export default function ModelhubParamsFilter(): JSX.Element {
  const { tempSearchQuery, setTempSearchQuery } = useSearchQueryContext();
  const selected = new Set<string>(tempSearchQuery?.paramBuckets ?? []);

  const toggle = useCallback(
    (b: string) => {
      const next = new Set(selected);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      setTempSearchQuery({
        paramBuckets: next.size > 0 ? Array.from(next) : undefined,
      });
    },
    [selected, setTempSearchQuery],
  );

  return (
    <Box sx={{ width: '100%', boxSizing: 'border-box' }}>
      <FormHelperText sx={{ marginLeft: 0 }}>
        Parameters (model size)
      </FormHelperText>
      <Stack
        direction="row"
        spacing={0.5}
        flexWrap="wrap"
        useFlexGap
        sx={{ mt: 0.25 }}
      >
        {BUCKETS.map((b) => {
          const isOn = selected.has(b);
          return (
            <Chip
              key={b}
              label={b}
              size="small"
              clickable
              variant={isOn ? 'filled' : 'outlined'}
              color={isOn ? 'primary' : 'default'}
              onClick={() => toggle(b)}
              sx={{ fontSize: '0.72em', height: 22 }}
            />
          );
        })}
      </Stack>
    </Box>
  );
}
