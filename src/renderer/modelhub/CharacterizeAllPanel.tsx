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
 *
 * Single-pass protocol (2026-05-23 rev.): each model is tested, then
 * (optionally) its monologue is projected via `llama-embedding` CLI
 * (one-shot, no resident server) immediately after. Three checkboxes
 * tune the run:
 *   - « Forcer » — re-characterize complete + failed models.
 *   - « Parler libre » — make each model write a 600-800-word monologue
 *     (persisted as `freegen_text`). On by default.
 *   - « Sans calcul vectoriel » — generate the monologue but skip the
 *     embedder projection step. Useful when projection isn't urgent, or
 *     when no embedder is configured (in which case the main process
 *     applies the same fallback silently).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ScienceIcon from '@mui/icons-material/Science';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import QuizIcon from '@mui/icons-material/Quiz';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useCharacterizeAll } from './useCharacterizeAll';
import { listRunners } from './runners/useRunners';
import { useOpenQuestionsLocation } from './useOpenQuestionsLocation';
import RunnerSetupDialog from './runners/RunnerSetupDialog';
import CharacterizeAllLogsTabs from './CharacterizeAllLogsTabs';
import type { CharacterizeRunStatus } from './useCharacterize';

function CharacterizeAllPanel(): JSX.Element {
  const { t } = useTranslation();
  const { currentLocation } = useCurrentLocationContext();
  const { running, progress, start, cancel } = useCharacterizeAll();
  // Opens the bundled questions/ folder as a read-only Maestria location
  // so the user can audit the source-of-truth JSON for every QCM/anchor.
  const openQuestions = useOpenQuestionsLocation();
  // No llama.cpp runner ⇒ nothing can launch at all. Blocked with a
  // dialog that opens the runner setup directly.
  const [runnerDialogOpen, setRunnerDialogOpen] = useState(false);
  const [runnerSetupOpen, setRunnerSetupOpen] = useState(false);
  // Slice 6b — force toggle: when on, skipExisting=false so the bulk run
  // re-characterizes every model (complete + failed). Local UI state only;
  // resets implicitly when the panel unmounts. No accidental persistence.
  const [force, setForce] = useState(false);
  // « Parler libre » toggle: when on, each model writes a ~600-800-word
  // free-gen monologue (persisted as `freegen_text`, projected if the
  // embedder is reachable AND `noVector` is off). ON by default.
  const [freegen, setFreegen] = useState(true);
  // « Sans calcul vectoriel » toggle: when on, the monologue is still
  // generated but the embedder projection step is skipped. Off by
  // default — projection runs whenever an embedder is available. The
  // main process applies the same fallback silently when no embedder is
  // configured, so users without a routing embedder can leave this off
  // and still complete a bulk run without errors.
  const [noVector, setNoVector] = useState(false);

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

  const handleStart = async () => {
    if (!rootDir) return;
    // A llama.cpp runner is the prerequisite for ANY characterization —
    // every model launches through llama-server (and the embedder CLI
    // lives next to it in the same build folder).
    const runners = await listRunners();
    if (runners.length === 0) {
      setRunnerDialogOpen(true);
      return;
    }
    start(rootDir, readOnly, force, freegen, noVector);
  };

  const startBtn = (
    <span>
      <Button
        size="small"
        variant={force ? 'contained' : 'outlined'}
        color={force ? 'warning' : 'primary'}
        startIcon={<ScienceIcon />}
        disabled={disabled}
        onClick={handleStart}
        data-tid="characterizeAllTID"
        // Prevent the narrow-sidebar layout from truncating the label
        // with an ellipsis ("TOUT CARACTÉR…"). Wrapping to two lines is
        // fine; truncating hides the action.
        sx={{ whiteSpace: 'nowrap' }}
      >
        {force ? t('core:mhCharAllStartForce') : t('core:mhCharAllStart')}
      </Button>
    </span>
  );

  // « Voir les questions sources » — same labelled button as the per-
  // model panel (CompetenceSection). Stacked UNDER the Start button so
  // the label stays visible without competing with the start action
  // for horizontal space in the narrow sidebar.
  const questionsBtn = (
    <Tooltip title={t('core:mhSeeSourceQuestionsHint')}>
      <Button
        size="small"
        variant="text"
        startIcon={<QuizIcon />}
        onClick={() => void openQuestions()}
        data-tid="seeSourceQuestionsTID"
        sx={{ whiteSpace: 'nowrap' }}
      >
        {t('core:mhSeeSourceQuestions')}
      </Button>
    </Tooltip>
  );

  return (
    <Box
      sx={{
        pb: 0.75,
        mb: 0.75,
        borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
      }}
    >
      {/* Title row — kept alone so a narrow sidebar can wrap the label
          without squeezing the action area below. */}
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
        {running && (
          <Tooltip title={t('core:mhCharAllCancel')}>
            <IconButton
              size="small"
              onClick={cancel}
              aria-label={t('core:mhCharAllCancel')}
            >
              <StopCircleIcon fontSize="small" color="error" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Action row — checkboxes on the left, [Start button + Questions
          icon] on the right. Vertical stacking of the right side keeps
          the button's text from truncating in the narrow sidebar layout.
          Hidden entirely while a run is in progress (the Cancel icon
          above is the only available action then). */}
      {!running && (
        <Stack
          direction="row"
          alignItems="flex-end"
          justifyContent="space-between"
          spacing={1}
          sx={{ mt: 0.5 }}
        >
          <Stack direction="column" spacing={0}>
            <Tooltip title={t('core:mhCharAllForceHint')}>
              <FormControlLabel
                sx={{ m: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={force}
                    onChange={(e) => setForce(e.target.checked)}
                    disabled={disabled}
                    inputProps={{ 'aria-label': t('core:mhCharAllForce') }}
                  />
                }
                label={
                  <Typography variant="caption" color="text.secondary">
                    {t('core:mhCharAllForce')}
                  </Typography>
                }
              />
            </Tooltip>
            <Tooltip title={t('core:mhCharAllFreegenHint')}>
              <FormControlLabel
                sx={{ m: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={freegen}
                    onChange={(e) => setFreegen(e.target.checked)}
                    disabled={disabled}
                    inputProps={{ 'aria-label': t('core:mhCharAllFreegen') }}
                  />
                }
                label={
                  <Typography variant="caption" color="text.secondary">
                    {t('core:mhCharAllFreegen')}
                  </Typography>
                }
              />
            </Tooltip>
            <Tooltip title={t('core:mhCharAllNoVectorHint')}>
              <FormControlLabel
                sx={{ m: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={noVector}
                    onChange={(e) => setNoVector(e.target.checked)}
                    // Only meaningful when « Parler libre » is on —
                    // there's nothing to project otherwise. Greyed out,
                    // value preserved so toggling freegen back on
                    // restores it.
                    disabled={disabled || !freegen}
                    inputProps={{
                      'aria-label': t('core:mhCharAllNoVector'),
                    }}
                  />
                }
                label={
                  <Typography variant="caption" color="text.secondary">
                    {t('core:mhCharAllNoVector')}
                  </Typography>
                }
              />
            </Tooltip>
          </Stack>
          {/* Action area: « TOUT CARACTÉRISER » on top, « Questions
              sources » stacked directly under it. Column layout keeps
              both labels readable on the narrow sidebar, matching the
              per-model CompetenceSection pattern (same labelled button,
              same icon). */}
          <Stack
            direction="column"
            alignItems="stretch"
            spacing={0.25}
            sx={{ flexShrink: 0 }}
          >
            {blockedTip ? (
              <Tooltip title={blockedTip}>{startBtn}</Tooltip>
            ) : (
              startBtn
            )}
            {questionsBtn}
          </Stack>
        </Stack>
      )}

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
                projected: progress.projected ?? 0,
              })}
        </Typography>
      )}

      {/* Tabbed log surface — Errors / Server logs / Interactions. Shown
          as soon as we have a progress object so the user has a place
          to land between runs (errors from the last run stay visible).
          The component handles its own scroll + live polling internally. */}
      {progress && (
        <CharacterizeAllLogsTabs progress={progress} running={running} />
      )}

      <Dialog
        open={runnerDialogOpen}
        onClose={() => setRunnerDialogOpen(false)}
      >
        <DialogTitle>{t('core:mhCharAllRunnerRequiredTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ userSelect: 'text' }}>
            {t('core:mhCharAllRunnerRequiredText')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRunnerDialogOpen(false)}>
            {t('core:cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setRunnerDialogOpen(false);
              setRunnerSetupOpen(true);
            }}
          >
            {t('core:mhConfigureRunners')}
          </Button>
        </DialogActions>
      </Dialog>

      <RunnerSetupDialog
        open={runnerSetupOpen}
        onClose={() => setRunnerSetupOpen(false)}
      />
    </Box>
  );
}

export default CharacterizeAllPanel;
