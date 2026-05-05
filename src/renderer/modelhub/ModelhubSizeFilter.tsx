/**
 * Models Hub — file-size range field for the advanced search panel.
 *
 * Lives inside `EditSearchQuery`, replaces the upstream "Size" bucket select
 * (tiny/small/.../huge) which is too coarse for multi-GB model files. Drives
 * `tempSearchQuery.sizeMin/sizeMax` (bytes) via `setTempSearchQuery`; the
 * actual search fires when the user clicks the panel's Search button (which
 * goes through `executeSearch()` — that whitelists sizeMin/sizeMax).
 *
 * "Hardware-safe" preset clamps the max to the detected RAM/VRAM budget.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  FormHelperText,
  Slider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import MemoryIcon from '@mui/icons-material/Memory';
import { useSearchQueryContext } from '-/hooks/useSearchQueryContext';
import {
  fetchHardwareProfile,
  estimateRuntime,
  HardwareProfile,
} from './hardware';

interface Props {
  /** Slider lower bound (default 0 GB). */
  minGB?: number;
  /** Slider upper bound (default 200 GB — covers 70B-class models). */
  maxGB?: number;
}

const GB = 1_000_000_000;

export default function ModelhubSizeFilter({
  minGB = 0,
  maxGB = 200,
}: Props): JSX.Element {
  const { tempSearchQuery, setTempSearchQuery } = useSearchQueryContext();
  const [hardware, setHardware] = useState<HardwareProfile | undefined>();

  // Initialize from existing query so reopening the panel preserves state.
  const initialLo =
    typeof tempSearchQuery?.sizeMin === 'number'
      ? Math.max(minGB, Math.round(tempSearchQuery.sizeMin / GB))
      : minGB;
  const initialHi =
    typeof tempSearchQuery?.sizeMax === 'number'
      ? Math.min(maxGB, Math.round(tempSearchQuery.sizeMax / GB))
      : maxGB;
  const [range, setRange] = useState<[number, number]>([initialLo, initialHi]);

  useEffect(() => {
    let alive = true;
    fetchHardwareProfile().then((p) => {
      if (alive) setHardware(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const runtime = useMemo(() => estimateRuntime(hardware), [hardware]);
  const safeMaxGB = useMemo(() => {
    if (!runtime.safeBudgetBytes) return undefined;
    return Math.max(1, Math.floor(runtime.safeBudgetBytes / 1_000_000_000));
  }, [runtime.safeBudgetBytes]);

  const isActive = range[0] > minGB || range[1] < maxGB;

  const commit = useCallback(
    (lo: number, hi: number) => {
      const isFullRange = lo <= minGB && hi >= maxGB;
      setTempSearchQuery({
        sizeMin: isFullRange ? undefined : lo * GB,
        sizeMax: isFullRange ? undefined : hi * GB,
      });
    },
    [minGB, maxGB, setTempSearchQuery],
  );

  const onSliderChange = useCallback((_e: Event, val: number | number[]) => {
    if (Array.isArray(val) && val.length === 2) {
      setRange([val[0], val[1]]);
    }
  }, []);

  const onSliderCommit = useCallback(
    (_e: any, val: number | number[]) => {
      if (Array.isArray(val) && val.length === 2) {
        commit(val[0], val[1]);
      }
    },
    [commit],
  );

  const onClear = useCallback(() => {
    setRange([minGB, maxGB]);
    setTempSearchQuery({ sizeMin: undefined, sizeMax: undefined });
  }, [minGB, maxGB, setTempSearchQuery]);

  const onApplySafe = useCallback(() => {
    if (!safeMaxGB) return;
    const hi = Math.min(safeMaxGB, maxGB);
    setRange([minGB, hi]);
    commit(minGB, hi);
  }, [minGB, maxGB, safeMaxGB, commit]);

  const safeBadge = useMemo(() => {
    if (!hardware) return null;
    const ramGb = hardware.ramBytes
      ? Math.round(hardware.ramBytes / 1_000_000_000)
      : undefined;
    const vramGb = hardware.gpu?.vramBytes
      ? Math.round(hardware.gpu.vramBytes / 1_000_000_000)
      : undefined;
    const parts: string[] = [];
    if (ramGb) parts.push(`${ramGb} GB RAM`);
    if (vramGb) parts.push(`${vramGb} GB VRAM`);
    if (parts.length === 0) return null;
    return parts.join(' · ');
  }, [hardware]);

  return (
    <Box
      data-tid="modelhubSizeFilter"
      sx={{ width: '100%', boxSizing: 'border-box' }}
    >
      <FormHelperText sx={{ marginLeft: 0 }}>File size (GB)</FormHelperText>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {isActive ? `${range[0]}–${range[1]} GB` : 'any size'}
        </Typography>
        {isActive && (
          <Button
            size="small"
            variant="text"
            onClick={onClear}
            sx={{ minWidth: 0, px: 0.75, py: 0, fontSize: '0.72em' }}
          >
            Clear
          </Button>
        )}
      </Stack>
      <Box sx={{ px: 1.25 }}>
        <Slider
          value={range}
          onChange={onSliderChange}
          onChangeCommitted={onSliderCommit}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => `${v} GB`}
          step={1}
          marks={false}
          min={minGB}
          max={maxGB}
          size="small"
          sx={{ py: 0.5, mt: 0 }}
        />
      </Box>
      {safeMaxGB !== undefined && (
        <Tooltip
          title={
            safeBadge
              ? `Cap max to fit hardware budget (${safeBadge})`
              : 'Cap max to estimated hardware budget'
          }
        >
          <Button
            size="small"
            variant="outlined"
            onClick={onApplySafe}
            startIcon={<MemoryIcon sx={{ fontSize: 14 }} />}
            sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: '0.72em' }}
          >
            Hardware-safe (≤ {safeMaxGB} GB)
          </Button>
        </Tooltip>
      )}
    </Box>
  );
}
