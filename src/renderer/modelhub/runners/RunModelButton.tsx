/**
 * Action button placed inside the per-file ModelHubPanel.
 *
 * Two entry points to "run something with this model":
 *
 *   1. **Run** (test rapide) — launches the auto-picked runner with
 *      auto-tuned params, then opens the runner's native web UI in the
 *      user's default browser. No in-app chat any more — TagSpaces
 *      orchestrates, the browser conducts the conversation.
 *
 *   2. **Run with agent** — pick a registered agent runtime, spawn it
 *      wired to that model URL + the MCP server URL/token. The agent's
 *      own UI opens in the browser.
 *
 * The agent path is currently mocked (UI scaffold only — no real spawn).
 * The model-launch path is real and wired end-to-end.
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
import SmartToyIcon from '@mui/icons-material/SmartToy';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import StopIcon from '@mui/icons-material/Stop';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import SettingsIcon from '@mui/icons-material/Settings';
import { AgentRunningState, RunParams } from '../types';
import {
  autotuneFor,
  buildCommand,
  launchRunner,
  openChatForPid,
  pickRunnerFor,
  stopRunner,
  useRunners,
} from './useRunners';
import { useMainAgent } from '../agents/useMainAgent';
import RunWithAgentDialog from '../agents/RunWithAgentDialog';
import RunnerSetupDialog from './RunnerSetupDialog';

interface Props {
  filePath: string;
}

interface Active {
  pid: number;
  url?: string;
  runnerLabel: string;
}

type SnackSeverity = 'success' | 'error' | 'info' | 'warning';

export default function RunModelButton({ filePath }: Props): JSX.Element {
  const { runners } = useRunners();
  const { agent: mainAgent } = useMainAgent();
  const [setupOpen, setSetupOpen] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState<Active | undefined>();
  const [activeAgent, setActiveAgent] = useState<
    AgentRunningState | undefined
  >();
  const [snack, setSnack] = useState<
    { msg: string; severity: SnackSeverity } | undefined
  >();

  // Reset per-file state when navigating to another file.
  useEffect(() => {
    setActive(undefined);
    setActiveAgent(undefined);
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

  const onRunWithAgent = useCallback(() => {
    setMenuAnchor(null);
    setAgentDialogOpen(true);
  }, []);

  const onAgentLaunched = useCallback((state: AgentRunningState) => {
    setActiveAgent(state);
    setSnack({
      msg: `(stub) Spawned ${state.name}${state.uiUrl ? ` — UI at ${state.uiUrl}` : ''}. Real spawn coming in Phase 4.3.`,
      severity: 'info',
    });
  }, []);

  // Real: call `runnersOpenChat` IPC which does `shell.openExternal(url)`
  // for the running engine. The agent path stays stubbed until Phase 4.5
  // wires the actual spawn — we have no real pid for the mock instance.
  const openModelInBrowser = useCallback(async (pid: number) => {
    const r = await openChatForPid(pid);
    if (!r.ok) {
      setSnack({ msg: r.error ?? 'open failed', severity: 'error' });
      return;
    }
    setSnack({ msg: 'Opened in your browser', severity: 'success' });
  }, []);

  const openAgentInBrowser = useCallback((url?: string, label?: string) => {
    if (!url) {
      setSnack({ msg: 'No UI URL for this agent', severity: 'warning' });
      return;
    }
    setSnack({
      msg: `(stub) Would open ${url}${label ? ` — ${label}` : ''}. Real wiring lands with Phase 4.5.`,
      severity: 'info',
    });
  }, []);

  const onPrimaryClick = useCallback(() => {
    if (activeAgent) {
      openAgentInBrowser(activeAgent.uiUrl, activeAgent.name);
      return;
    }
    if (active) {
      openModelInBrowser(active.pid);
      return;
    }
    onLaunchModel();
  }, [
    activeAgent,
    active,
    openAgentInBrowser,
    openModelInBrowser,
    onLaunchModel,
  ]);

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

  const onStopAgent = useCallback(
    (force: boolean) => {
      setMenuAnchor(null);
      if (!activeAgent) return;
      setActiveAgent(undefined);
      setSnack({
        msg: force
          ? `(stub) Force-stopped ${activeAgent.name} — tree-kill in real impl`
          : `(stub) Gracefully stopped ${activeAgent.name} — SIGTERM/Ctrl-C in real impl`,
        severity: 'info',
      });
    },
    [activeAgent],
  );

  // Visual: primary button label/icon depends on running state.
  const primary = useMemo(() => {
    if (activeAgent) {
      return {
        label: `Open ${activeAgent.name}`,
        icon: <SmartToyIcon />,
        tooltip: activeAgent.uiUrl
          ? `Reopen ${activeAgent.uiUrl} in browser`
          : `Agent running${activeAgent.pid ? ` (pid ${activeAgent.pid})` : ''}`,
      };
    }
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
  }, [activeAgent, active, runner, busy]);

  const stopAgentItems = activeAgent
    ? [
        <MenuItem key="stop-graceful" onClick={() => onStopAgent(false)}>
          <StopIcon fontSize="small" sx={{ mr: 1 }} />
          Stop {activeAgent.name} (graceful)
        </MenuItem>,
        <MenuItem
          key="stop-force"
          onClick={() => onStopAgent(true)}
          sx={{ color: 'error.main' }}
        >
          <StopCircleIcon fontSize="small" sx={{ mr: 1 }} />
          Force stop {activeAgent.name}
        </MenuItem>,
      ]
    : null;

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
            <Typography variant="body2">Run (test rapide)</Typography>
            <Typography variant="caption" color="text.secondary">
              Launches the model + opens its web UI in your browser
            </Typography>
          </Stack>
        </MenuItem>
        {mainAgent ? (
          <MenuItem onClick={onRunWithAgent}>
            <SmartToyIcon fontSize="small" sx={{ mr: 1 }} />
            <Stack>
              <Typography variant="body2">Run with {mainAgent.name}</Typography>
              {mainAgent.description ? (
                <Typography variant="caption" color="text.secondary">
                  {mainAgent.description}
                </Typography>
              ) : null}
            </Stack>
          </MenuItem>
        ) : (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              setSnack({
                msg: '(stub) Settings ▸ AI ▸ Your agent — coming in Phase 4.4',
                severity: 'info',
              });
            }}
          >
            <SmartToyIcon fontSize="small" sx={{ mr: 1 }} />
            <Stack>
              <Typography variant="body2">Configure agent…</Typography>
              <Typography variant="caption" color="text.secondary">
                No agent configured yet
              </Typography>
            </Stack>
          </MenuItem>
        )}
        {mainAgent && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              setSnack({
                msg: '(stub) Settings ▸ AI ▸ Your agent — coming in Phase 4.4',
                severity: 'info',
              });
            }}
          >
            <SettingsIcon fontSize="small" sx={{ mr: 1 }} />
            Configure agent…
          </MenuItem>
        )}

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

        {stopAgentItems}

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

      <RunWithAgentDialog
        open={agentDialogOpen}
        filePath={filePath}
        modelUrl={active?.url}
        onClose={() => setAgentDialogOpen(false)}
        onLaunch={onAgentLaunched}
      />

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
