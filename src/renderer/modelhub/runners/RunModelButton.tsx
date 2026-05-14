/**
 * Action button placed inside the per-file ModelHubPanel.
 *
 * "Run" always means "launch a new instance" — multiple instances of the
 * same model can run side-by-side on auto-picked ports. A small `Badge`
 * on the button shows how many instances of THIS file are currently
 * alive; per-instance actions (Open in browser, Stop, view logs) live in
 * the always-mounted `RunningModelsPanel` (Launch logs) below the
 * sidebar — that's where multi-instance state is managed.
 *
 * The split-button dropdown also exposes "Stop all running instances"
 * as a one-shot convenience when the user just wants to clear out this
 * model from the runtime.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Badge,
  Button,
  ButtonGroup,
  CircularProgress,
  Divider,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import StopIcon from '@mui/icons-material/Stop';
import SettingsIcon from '@mui/icons-material/Settings';
import { RunParams } from '../types';
import {
  RunningEntry,
  autotuneFor,
  buildCommand,
  launchRunner,
  listRunningModels,
  pickRunnerFor,
  stopRunner,
  useRunners,
} from './useRunners';
import RunnerSetupDialog from './RunnerSetupDialog';

interface Props {
  filePath: string;
  /**
   * Per-file runner override read from the sidecar by `ModelHubPanel`.
   * Drives `pickRunnerFor` so the display + launch use the same runner
   * the user picked in the dropdown below. Undefined → global priority.
   */
  preferredRunnerId?: string;
}

type SnackSeverity = 'success' | 'error' | 'info' | 'warning';

/** Poll cadence for the per-file running-instance badge. Mirrors the
 * Launch logs panel cadence so both stay roughly in sync. */
const RUNNING_POLL_MS = 3000;

/** Match an entry to the editor's filePath. Tolerates differing
 * path separators (Windows ↔ POSIX) by normalizing both sides. */
function sameFile(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

export default function RunModelButton({
  filePath,
  preferredRunnerId,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const { runners } = useRunners();
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [running, setRunning] = useState<RunningEntry[]>([]);
  const [snack, setSnack] = useState<
    { msg: string; severity: SnackSeverity } | undefined
  >();
  const aliveRef = useRef(true);

  // Poll running list so the badge tracks instances launched by THIS
  // editor view, by other editor instances opened on the same file,
  // or by an MCP client. listRunningModels is cheap (it just maps an
  // in-memory map in the main process).
  useEffect(() => {
    aliveRef.current = true;
    const refresh = () => {
      listRunningModels()
        .then((r) => {
          if (aliveRef.current) setRunning(r);
        })
        .catch(() => {
          /* poll loop swallows errors */
        });
    };
    refresh();
    const id = setInterval(refresh, RUNNING_POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, []);

  /**
   * Live instances of this exact file. `filePath` on RunningEntry is
   * the canonical absolute path set by the main process at launch
   * time, so a non-canonical shard opened in the editor matches
   * launches that targeted the canonical sibling.
   */
  const liveForThisFile = useMemo(
    () => running.filter((e) => !e.exited && sameFile(e.filePath, filePath)),
    [running, filePath],
  );
  const runningCount = liveForThisFile.length;

  const runner = useMemo(
    () => pickRunnerFor(runners, filePath, { preferredRunnerId }),
    [runners, filePath, preferredRunnerId],
  );

  const computeParams = useCallback(async (): Promise<
    RunParams | undefined
  > => {
    const r = await autotuneFor(filePath);
    if (!r.ok || !r.params) {
      setSnack({
        msg: r.error ?? t('core:mhAutotuneFailed'),
        severity: 'error',
      });
      return undefined;
    }
    return r.params;
  }, [filePath, t]);

  const onLaunchModel = useCallback(async () => {
    setMenuAnchor(null);
    if (!runner) {
      setSetupOpen(true);
      return;
    }
    setBusy(true);
    try {
      const params = await computeParams();
      if (!params) return;
      const result = await launchRunner(runner, filePath, params);
      if (result.ok && result.pid) {
        setSnack({
          msg: t('core:mhRunSnackLaunched', {
            label: runner.label,
            target: result.url
              ? result.url
              : t('core:mhRunSnackPid', { pid: result.pid }),
          }),
          severity: 'success',
        });
      } else {
        setSnack({
          msg: result.error ?? t('core:mhRunSnackFailed'),
          severity: 'error',
        });
      }
    } finally {
      setBusy(false);
    }
  }, [runner, filePath, computeParams, t]);

  const onCopy = useCallback(async () => {
    setMenuAnchor(null);
    if (!runner) {
      setSetupOpen(true);
      return;
    }
    const params = await computeParams();
    if (!params) return;
    const built = await buildCommand(runner, filePath, params);
    if (!built.ok || !built.shell) {
      setSnack({
        msg: built.error ?? t('core:mhRunSnackBuildFailed'),
        severity: 'error',
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(built.shell);
      setSnack({ msg: t('core:mhRunSnackCopied'), severity: 'success' });
    } catch (e) {
      setSnack({
        msg: t('core:mhRunSnackClipboardFailed', {
          err: (e as Error).message,
        }),
        severity: 'error',
      });
    }
  }, [runner, filePath, computeParams, t]);

  const onStopAll = useCallback(async () => {
    setMenuAnchor(null);
    if (runningCount === 0) return;
    setBusy(true);
    try {
      // Iterate over a copy — stopRunner mutates the underlying map.
      for (const e of [...liveForThisFile]) {
        try {
          await stopRunner(e.pid);
        } catch {
          /* keep going — best-effort batch stop */
        }
      }
      setSnack({
        msg: t('core:mhRunSnackStoppedAll', { count: runningCount }),
        severity: 'info',
      });
    } finally {
      setBusy(false);
    }
  }, [liveForThisFile, runningCount, t]);

  const primary = useMemo(() => {
    if (!runner) {
      return {
        label: t('core:mhConfigureRunner'),
        tooltip: t('core:mhNoRunnerTooltip'),
      };
    }
    return {
      label: t('core:mhRun'),
      tooltip:
        runningCount > 0
          ? t('core:mhRunTooltipMulti', {
              count: runningCount,
              label: runner.label,
            })
          : t('core:mhRunTooltip', { label: runner.label }),
    };
  }, [runner, runningCount, t]);

  return (
    <>
      <ButtonGroup size="small" variant="contained" disabled={busy}>
        <Tooltip title={primary.tooltip}>
          {/*
           * Badge wraps the Run button only; the dropdown caret stays
           * unbadged. `overlap="rectangular"` keeps the count nub in the
           * top-right corner of the button. `invisible` short-circuits
           * the dot when nothing's running so the button looks normal.
           */}
          <Badge
            badgeContent={runningCount}
            color="success"
            invisible={runningCount === 0}
            overlap="rectangular"
            sx={{ '& .MuiBadge-badge': { right: 6, top: 6 } }}
          >
            <Button
              onClick={onLaunchModel}
              startIcon={
                busy ? <CircularProgress size={14} /> : <PlayArrowIcon />
              }
            >
              {primary.label}
            </Button>
          </Badge>
        </Tooltip>
        <Button onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <ArrowDropDownIcon />
        </Button>
      </ButtonGroup>

      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={() => setMenuAnchor(null)}
      >
        <MenuItem onClick={onCopy}>
          <ContentCopyIcon fontSize="small" sx={{ mr: 1 }} />
          {t('core:mhCopyCommand')}
        </MenuItem>

        {runningCount > 0 && (
          <>
            <Divider />
            <MenuItem onClick={onStopAll}>
              <StopIcon fontSize="small" sx={{ mr: 1 }} />
              {t('core:mhStopAll', { count: runningCount })}
            </MenuItem>
          </>
        )}

        <Divider />

        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setSetupOpen(true);
          }}
        >
          <SettingsIcon fontSize="small" sx={{ mr: 1 }} />
          {t('core:mhConfigureRunners')}
        </MenuItem>
      </Menu>

      <RunnerSetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />

      <Snackbar
        open={!!snack}
        autoHideDuration={6000}
        onClose={() => setSnack(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack ? (
          <Alert
            severity={snack.severity}
            onClose={() => setSnack(undefined)}
            sx={{ whiteSpace: 'pre-line' }}
          >
            {snack.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </>
  );
}
