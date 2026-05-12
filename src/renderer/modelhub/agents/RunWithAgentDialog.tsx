/**
 * "Run with agent…" dialog — UI-first mock.
 *
 * Triggered from the RunModelButton dropdown. Since the project settled
 * on a single configured main agent (no in-app catalog), this dialog
 * has no picker — it just shows the configured agent's name, asks for
 * a task, displays the model URL that'll be injected, and launches.
 *
 * Currently non-functional: onLaunch is a mock that just calls the
 * caller-provided callback with synthesized data — no actual spawn,
 * no MCP server. The point of this iteration is to validate the flow
 * and field set.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { AgentRunningState } from '../types';
import { useMainAgent } from './useMainAgent';

interface Props {
  open: boolean;
  /** The model file the agent will reason about. Surfaced for context. */
  filePath: string;
  /** URL of a model currently running, if any. The agent will be wired to it. */
  modelUrl?: string;
  onClose: () => void;
  /**
   * Mock launch callback. In the final version this triggers the IPC
   * to spawn the agent process and returns its real running state.
   */
  onLaunch: (state: AgentRunningState) => void;
}

const PLACEHOLDER_TASK =
  'e.g. "Audit my coding models and pick the best fit for refactoring this codebase."';

export default function RunWithAgentDialog({
  open,
  filePath,
  modelUrl,
  onClose,
  onLaunch,
}: Props): JSX.Element {
  const { agent } = useMainAgent();
  const [task, setTask] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setTask('');
  }, [open]);

  const effectiveModelUrl =
    modelUrl ?? 'http://127.0.0.1:8080 (will auto-launch)';
  const isExternal = !!agent?.external;
  const canLaunch = !!agent && (isExternal || task.trim().length > 0);

  const handleLaunch = () => {
    if (!agent) return;
    // Mock running state — no actual spawn.
    const state: AgentRunningState = {
      agentInstanceId: `mock-${Date.now()}`,
      agentConfigId: agent.id,
      name: agent.name,
      pid: isExternal ? undefined : 99000 + Math.floor(Math.random() * 1000),
      uiUrl: agent.uiUrl?.replace('${PORT}', '8123') ?? agent.externalUrl,
      task: task.trim() || undefined,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    onLaunch(state);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <SmartToyIcon fontSize="small" />
          <span>Run with {agent?.name ?? 'agent'}</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!agent && (
            <Alert severity="warning" variant="outlined">
              <Typography variant="body2">
                No main agent configured yet. Set one up in Settings ▸ AI ▸ Your
                agent first.
              </Typography>
            </Alert>
          )}

          {agent && agent.description && (
            <Typography variant="caption" color="text.secondary">
              {agent.description}
            </Typography>
          )}

          {isExternal ? (
            <Alert severity="info" variant="outlined">
              <Typography variant="body2">
                {agent?.name} is an external service — TagSpaces won't spawn it.
                The browser will open <code>{agent?.externalUrl}</code>{' '}
                directly. Tasks aren't injectable for external agents; paste
                your task in their UI.
              </Typography>
            </Alert>
          ) : (
            <TextField
              label="Task"
              placeholder={PLACEHOLDER_TASK}
              multiline
              minRows={4}
              maxRows={10}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              size="small"
              fullWidth
              disabled={!agent}
              helperText="Substituted into the agent's args via ${TASK}."
            />
          )}

          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              Model file
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', fontSize: 12 }}
            >
              {filePath}
            </Typography>
          </Stack>

          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              Model URL (substituted as <code>${'${MODEL_URL}'}</code>)
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', fontSize: 12 }}
            >
              {effectiveModelUrl}
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleLaunch}
          variant="contained"
          startIcon={<PlayArrowIcon />}
          disabled={!canLaunch}
        >
          Launch
        </Button>
      </DialogActions>
    </Dialog>
  );
}
