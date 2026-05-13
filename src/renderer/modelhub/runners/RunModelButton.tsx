/**
 * Action button placed inside the per-file ModelHubPanel.
 *
 * Single entry point: **Run** launches the auto-picked runner with
 * auto-tuned params, then opens the runner's native web UI in the
 * user's default browser. No in-app chat surface — TagSpaces is a
 * model orchestrator: it spawns `llama-server`, hands back the URL,
 * and the browser conducts the conversation.
 *
 * External agents (deer-flow, aider, Claude Desktop, Cursor…) drive
 * the library via the MCP server (Phase 4.1) — they're not configured
 * or launched from inside TagSpaces.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  ButtonGroup,
  CircularProgress,
  Divider,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import StopIcon from '@mui/icons-material/Stop';
import SettingsIcon from '@mui/icons-material/Settings';
import { RunParams } from '../types';
import {
  autotuneFor,
  buildCommand,
  launchRunner,
  openChatForPid,
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

interface Active {
  pid: number;
  url?: string;
  runnerLabel: string;
}

type SnackSeverity = 'success' | 'error' | 'info' | 'warning';

export default function RunModelButton({
  filePath,
  preferredRunnerId,
}: Props): JSX.Element {
  const { runners } = useRunners();
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState<Active | undefined>();
  const [snack, setSnack] = useState<
    { msg: string; severity: SnackSeverity } | undefined
  >();

  // Reset per-file state when navigating to another file.
  useEffect(() => {
    setActive(undefined);
  }, [filePath]);

  const runner = useMemo(
    () => pickRunnerFor(runners, filePath, { preferredRunnerId }),
    [runners, filePath, preferredRunnerId],
  );

  const computeParams = useCallback(async (): Promise<
    RunParams | undefined
  > => {
    const r = await autotuneFor(filePath);
    if (!r.ok || !r.params) {
      setSnack({ msg: r.error ?? 'autotune failed', severity: 'error' });
      return undefined;
    }
    return r.params;
  }, [filePath]);

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
        setActive({
          pid: result.pid,
          url: result.url,
          runnerLabel: runner.label,
        });
        setSnack({
          msg: `Launched ${runner.label}${result.url ? ` on ${result.url}` : ` (pid ${result.pid})`}. Open in browser via 🌐.`,
          severity: 'success',
        });
      } else {
        setSnack({ msg: result.error ?? 'launch failed', severity: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }, [runner, filePath, computeParams]);

  const openModelInBrowser = useCallback(async (pid: number) => {
    const r = await openChatForPid(pid);
    if (!r.ok) {
      setSnack({ msg: r.error ?? 'open failed', severity: 'error' });
      return;
    }
    setSnack({ msg: 'Opened in your browser', severity: 'success' });
  }, []);

  const onPrimaryClick = useCallback(() => {
    if (active) {
      openModelInBrowser(active.pid);
      return;
    }
    onLaunchModel();
  }, [active, openModelInBrowser, onLaunchModel]);

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
        msg: built.error ?? 'failed to build command',
        severity: 'error',
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(built.shell);
      setSnack({ msg: 'Command copied to clipboard', severity: 'success' });
    } catch (e) {
      setSnack({
        msg: `Clipboard failed: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }, [runner, filePath, computeParams]);

  const onStopModel = useCallback(async () => {
    setMenuAnchor(null);
    if (!active) return;
    await stopRunner(active.pid);
    setActive(undefined);
    setSnack({ msg: 'Stopped model', severity: 'info' });
  }, [active]);

  // Visual: primary button label/icon depends on running state.
  const primary = useMemo(() => {
    if (active) {
      return {
        label: 'Open in browser',
        icon: <OpenInBrowserIcon />,
        tooltip: active.url
          ? `Reopen ${active.url} in browser`
          : `Running (pid ${active.pid})`,
      };
    }
    if (!runner) {
      return {
        label: 'Configure runner…',
        icon: busy ? <CircularProgress size={14} /> : <PlayArrowIcon />,
        tooltip: 'No runner configured — click to set one up',
      };
    }
    return {
      label: 'Run',
      icon: busy ? <CircularProgress size={14} /> : <PlayArrowIcon />,
      tooltip: `Launch ${runner.label} with auto-tuned params, then open in browser`,
    };
  }, [active, runner, busy]);

  return (
    <>
      <ButtonGroup size="small" variant="contained" disabled={busy}>
        <Tooltip title={primary.tooltip}>
          <Button onClick={onPrimaryClick} startIcon={primary.icon}>
            {primary.label}
          </Button>
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
        <ListSubheader sx={{ lineHeight: '32px' }}>Launch</ListSubheader>
        <MenuItem onClick={onLaunchModel}>
          <PlayArrowIcon fontSize="small" sx={{ mr: 1 }} />
          <Stack>
            <Typography variant="body2">Run</Typography>
            <Typography variant="caption" color="text.secondary">
              Launches the model + opens its web UI in your browser
            </Typography>
          </Stack>
        </MenuItem>

        <Divider />

        <MenuItem onClick={onCopy}>
          <ContentCopyIcon fontSize="small" sx={{ mr: 1 }} />
          Copy command
        </MenuItem>

        {active && (
          <MenuItem onClick={onStopModel}>
            <StopIcon fontSize="small" sx={{ mr: 1 }} />
            Stop model (pid {active.pid})
          </MenuItem>
        )}

        <Divider />

        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setSetupOpen(true);
          }}
        >
          <SettingsIcon fontSize="small" sx={{ mr: 1 }} />
          Configure runners…
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
