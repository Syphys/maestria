/**
 * Slice 5 — "Characterize all models" encart, pinned just above the
 * Console. Spec: SEMANTIC_ROUTING_FEATURES.md §R3 ; D7/R9.8.
 *
 * Bulk-characterizes every model in the opened location, smallest first,
 * skipping already-characterized ones. Shows a global progress bar (model
 * X/N) plus the current model's sub-progress (Question i/n …), with a
 * cancel that stops after the current model. Disabled on read-only
 * locations (the result can't be persisted) — same rule as the per-model
 * trigger.
 */

import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ScienceIcon from '@mui/icons-material/Science';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useCharacterizeAll } from './useCharacterizeAll';
import type { CharacterizeRunStatus } from './useCharacterize';

function CharacterizeAllPanel(): JSX.Element {
  const { t } = useTranslation();
  const { currentLocation } = useCurrentLocationContext();
  const { running, progress, start, cancel } = useCharacterizeAll();

  const rootDir = currentLocation?.path;
  const readOnly = !!currentLocation?.isReadOnly;
  const disabled = !rootDir || readOnly || running;

  const modelStatusLabel = (s?: CharacterizeRunStatus): string => {
    if (!s) return '';
    if (s.stage === 'preparing') {
      if (s.detail === 'reuse') return t('core:mhCharacterizePrepReuse');
      if (s.detail === 'launching') return t('core:mhCharacterizePrepLaunch');
      return t('core:mhCharacterizePrepWait');
    }
    if (s.stage === 'running' && s.progress.kind === 'prompt_started') {
      return t('core:mhCharacterizeProgress', {
        i: s.progress.index + 1,
        n: s.progress.total,
      });
    }
    return t('core:mhCharacterizeRunning');
  };

  const globalPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : undefined;

  const blockedTip = !rootDir
    ? t('core:mhCharAllNoLocation')
    : readOnly
      ? t('core:mhCharacterizeReadOnly')
      : '';

  const startBtn = (
    <span>
      <Button
        size="small"
        variant="outlined"
        startIcon={<ScienceIcon />}
        disabled={disabled}
        onClick={() => rootDir && start(rootDir, readOnly)}
        data-tid="characterizeAllTID"
      >
        {t('core:mhCharAllStart')}
      </Button>
    </span>
  );

  return (
    <Box
      sx={{
        px: 1,
        py: 0.75,
        borderTop: (theme) => `1px solid ${theme.palette.divider}`,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 600 }}
        >
          {t('core:mhCharAllTitle')}
        </Typography>
        {running ? (
          <Tooltip title={t('core:mhCharAllCancel')}>
            <IconButton
              size="small"
              onClick={cancel}
              aria-label={t('core:mhCharAllCancel')}
            >
              <StopCircleIcon fontSize="small" color="error" />
            </IconButton>
          </Tooltip>
        ) : blockedTip ? (
          <Tooltip title={blockedTip}>{startBtn}</Tooltip>
        ) : (
          startBtn
        )}
      </Stack>

      {running && progress && (
        <Box sx={{ mt: 0.75 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', userSelect: 'text' }}
          >
            {progress.phase === 'enumerating'
              ? t('core:mhCharAllScanning')
              : t('core:mhCharAllModel', {
                  i: Math.min(progress.currentIndex + 1, progress.total),
                  n: progress.total,
                  name: progress.currentName ?? '',
                })}
          </Typography>
          <LinearProgress
            variant={globalPct == null ? 'indeterminate' : 'determinate'}
            value={globalPct}
            sx={{ mt: 0.5, borderRadius: 1, height: 6 }}
          />
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ display: 'block', mt: 0.25 }}
          >
            {modelStatusLabel(progress.modelStatus)}
            {progress.skipped > 0
              ? ` · ${t('core:mhCharAllSkippedCount', { n: progress.skipped })}`
              : ''}
          </Typography>
        </Box>
      )}

      {!running && progress && progress.phase !== 'enumerating' && (
        <Typography
          variant="caption"
          color="text.disabled"
          sx={{ display: 'block', mt: 0.5, userSelect: 'text' }}
        >
          {progress.phase === 'cancelled'
            ? t('core:mhCharAllCancelledMsg', {
                done: progress.done,
                total: progress.total,
              })
            : t('core:mhCharAllDone', {
                ok: progress.ok,
                skipped: progress.skipped,
                errors: progress.errors,
              })}
        </Typography>
      )}
    </Box>
  );
}

export default CharacterizeAllPanel;
