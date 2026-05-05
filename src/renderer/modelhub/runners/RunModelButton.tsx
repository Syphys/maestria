/**
 * Action button placed inside the per-file ModelHubPanel.
 *
 * Default action (clicking the button): launch the auto-picked runner with
 * auto-tuned params and open the local server URL.
 *
 * Dropdown options:
 *  - Copy command (clipboard) — for users who prefer their own terminal
 *  - Stop running instance (when one is active for this file)
 *  - Configure runners… (opens RunnerSetupDialog)
 *
 * If no runner is configured, clicking the button opens the setup dialog
 * directly instead of launching.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  ButtonGroup,
  CircularProgress,
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
  autotuneFor,
  buildCommand,
  launchRunner,
  pickRunnerFor,
  stopRunner,
  useRunners,
} from './useRunners';
import RunnerSetupDialog from './RunnerSetupDialog';
import { dispatchModelhubChatOpen } from '../chat/openChatEvent';

interface Props {
  filePath: string;
}

interface Active {
  pid: number;
  url?: string;
  runnerLabel: string;
}

export default function RunModelButton({ filePath }: Props): JSX.Element {
  const { runners } = useRunners();
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState<Active | undefined>();
  const [snack, setSnack] = useState<
    { msg: string; severity: 'success' | 'error' | 'info' } | undefined
  >();

  // Reset the per-file active state when the user navigates to another file.
  useEffect(() => {
    setActive(undefined);
  }, [filePath]);

  const runner = useMemo(
    () => pickRunnerFor(runners, filePath),
    [runners, filePath],
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

  const onLaunch = useCallback(async () => {
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
          msg: `Launched ${runner.label} — chat opening…`,
          severity: 'success',
        });
        // Auto-open the in-app ChatDialog. RunningModelsPanel (always
        // mounted in the sidebar) listens for this event and pops the
        // dialog. Identical flow to the file-context menu, so both
        // entry points behave the same and never reach the useless
        // `:11434/` "Ollama is running" page.
        dispatchModelhubChatOpen({ pid: result.pid });
      } else {
        setSnack({ msg: result.error ?? 'launch failed', severity: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }, [runner, filePath, computeParams]);

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

  const onStop = useCallback(async () => {
    setMenuAnchor(null);
    if (!active) return;
    await stopRunner(active.pid);
    setActive(undefined);
    setSnack({ msg: 'Stopped', severity: 'info' });
  }, [active]);

  const onOpenChat = useCallback(() => {
    if (!active) return;
    // Re-open the in-app ChatDialog. The RunningModelsPanel listener
    // resolves the pid against its polling cache and mounts the dialog.
    // Avoids the dead-end where clicking "Open chat" used to open
    // `:11434/` ("Ollama is running") in the browser.
    dispatchModelhubChatOpen({ pid: active.pid });
  }, [active]);

  return (
    <>
      <ButtonGroup size="small" variant="contained" disabled={busy}>
        {active ? (
          <Tooltip title={active.url ? `Open ${active.url}` : 'Running'}>
            <Button onClick={onOpenChat} startIcon={<PlayArrowIcon />}>
              {active.url ? 'Open chat' : `pid ${active.pid}`}
            </Button>
          </Tooltip>
        ) : (
          <Tooltip
            title={
              runner
                ? `Launch ${runner.label} with auto-tuned params`
                : 'No runner configured — click to set one up'
            }
          >
            <Button
              onClick={onLaunch}
              startIcon={
                busy ? <CircularProgress size={14} /> : <PlayArrowIcon />
              }
            >
              {runner ? 'Run' : 'Configure runner…'}
            </Button>
          </Tooltip>
        )}
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
          Copy command
        </MenuItem>
        {active && (
          <MenuItem onClick={onStop}>
            <StopIcon fontSize="small" sx={{ mr: 1 }} />
            Stop (pid {active.pid})
          </MenuItem>
        )}
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
