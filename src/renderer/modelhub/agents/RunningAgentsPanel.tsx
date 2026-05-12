/**
 * Sidebar panel that visualises every running agent instance as a tree
 * (parent → children), mirroring `RunningModelsPanel` for models.
 *
 * The orchestrator model implies recursion: an agent can spawn another
 * agent via `agents.run`. We render that nesting visibly so the user
 * sees at a glance which agents were user-initiated (roots) and which
 * are children of others.
 *
 * Currently driven by a mock hook (`useRunningAgents`) — replaced by an
 * IPC poll of the active-pids ledger in Phase 4.3.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import StopIcon from '@mui/icons-material/Stop';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { AgentRunningState } from '../types';
import { useRunningAgents } from './useRunningAgents';

interface TreeNode {
  agent: AgentRunningState;
  children: TreeNode[];
  depth: number;
}

interface SnackState {
  msg: string;
  severity: 'success' | 'error' | 'info' | 'warning';
}

const STATUS_COLOR: Record<AgentRunningState['status'], string> = {
  starting: 'info.main',
  running: 'success.main',
  done: 'text.disabled',
  error: 'error.main',
  dead: 'warning.main',
};

const STATUS_LABEL: Record<AgentRunningState['status'], string> = {
  starting: 'starting',
  running: 'running',
  done: 'done',
  error: 'error',
  dead: 'dead',
};

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Build a forest of trees from the flat list using parentAgentInstanceId. */
function buildForest(agents: AgentRunningState[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  agents.forEach((a) => {
    byId.set(a.agentInstanceId, { agent: a, children: [], depth: 0 });
  });
  const roots: TreeNode[] = [];
  agents.forEach((a) => {
    const node = byId.get(a.agentInstanceId);
    if (!node) return;
    if (a.parentAgentInstanceId && byId.has(a.parentAgentInstanceId)) {
      const parent = byId.get(a.parentAgentInstanceId)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });
  // Recurse to fix depths now that parents are set up.
  const setDepth = (node: TreeNode, d: number) => {
    node.depth = d;
    node.children.forEach((c) => setDepth(c, d + 1));
  };
  roots.forEach((r) => setDepth(r, 0));
  return roots;
}

export default function RunningAgentsPanel(): JSX.Element | null {
  const { agents } = useRunningAgents();
  const [snack, setSnack] = useState<SnackState | undefined>();

  const forest = useMemo(() => buildForest(agents), [agents]);

  const onOpen = useCallback((agent: AgentRunningState) => {
    if (!agent.uiUrl) {
      setSnack({ msg: 'No UI URL for this agent', severity: 'warning' });
      return;
    }
    setSnack({
      msg: `(stub) Would open ${agent.uiUrl} in your default browser`,
      severity: 'info',
    });
  }, []);

  const onStop = useCallback((agent: AgentRunningState, force: boolean) => {
    setSnack({
      msg: force
        ? `(stub) Force-stopped ${agent.name} — tree-kill in real impl`
        : `(stub) Sent SIGTERM/Ctrl-C to ${agent.name} (timeout 10s)`,
      severity: 'info',
    });
  }, []);

  const onRemove = useCallback((agent: AgentRunningState) => {
    setSnack({
      msg: `(stub) Removed ${agent.name} from the list`,
      severity: 'info',
    });
  }, []);

  if (agents.length === 0) return null;

  const total = agents.length;
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const errorCount = agents.filter((a) => a.status === 'error').length;

  // Flatten the forest in DFS order to render as a list — easier to
  // reason about than nested components for tree connectors.
  const flat: TreeNode[] = [];
  const flatten = (n: TreeNode) => {
    flat.push(n);
    n.children.forEach(flatten);
  };
  forest.forEach(flatten);

  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
        <SmartToyIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
        <Typography
          variant="caption"
          sx={{ fontWeight: 500, color: 'text.primary' }}
        >
          Running agents ({total})
        </Typography>
        {runningCount > 0 && (
          <Chip
            label={`● ${runningCount}`}
            size="small"
            sx={{
              height: 16,
              fontSize: '0.65em',
              color: 'success.main',
              backgroundColor: 'transparent',
              '& .MuiChip-label': { px: 0.5 },
            }}
          />
        )}
        {errorCount > 0 && (
          <Chip
            label={`× ${errorCount}`}
            size="small"
            sx={{
              height: 16,
              fontSize: '0.65em',
              color: 'error.main',
              backgroundColor: 'transparent',
              '& .MuiChip-label': { px: 0.5 },
            }}
          />
        )}
      </Stack>

      <Stack spacing={0.25} sx={{ maxHeight: 260, overflowY: 'auto', pr: 0.5 }}>
        {flat.map((node) => {
          const { agent, depth, children } = node;
          const isRunning = agent.status === 'running';
          const isTerminal =
            agent.status === 'done' ||
            agent.status === 'error' ||
            agent.status === 'dead';
          return (
            <Box
              key={agent.agentInstanceId}
              sx={{
                pl: depth * 1.5,
                position: 'relative',
                '&::before':
                  depth > 0
                    ? {
                        content: '""',
                        position: 'absolute',
                        left: (depth - 1) * 1.5 * 8 + 6,
                        top: 0,
                        bottom: 0,
                        width: '1px',
                        backgroundColor: 'divider',
                      }
                    : undefined,
              }}
            >
              <Box
                sx={{
                  p: 0.5,
                  borderRadius: 0.5,
                  border: 1,
                  borderColor: 'divider',
                  backgroundColor: 'action.hover',
                  position: 'relative',
                }}
              >
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  {/* Status dot */}
                  <Tooltip title={STATUS_LABEL[agent.status]}>
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: STATUS_COLOR[agent.status],
                        flexShrink: 0,
                      }}
                    />
                  </Tooltip>

                  {/* Name + meta */}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 500,
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '0.78em',
                        color: 'text.primary',
                      }}
                    >
                      {agent.name}
                      {children.length > 0 && (
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ ml: 0.5, fontSize: '0.85em' }}
                        >
                          ↳ {children.length}
                        </Typography>
                      )}
                    </Typography>
                    {agent.task && (
                      <Tooltip title={agent.task} placement="top-start">
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: 'block',
                            fontSize: '0.7em',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontStyle: 'italic',
                          }}
                        >
                          “{agent.task}”
                        </Typography>
                      </Tooltip>
                    )}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: 'block',
                        fontSize: '0.65em',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {agent.pid ? `pid ${agent.pid}` : 'external'}
                      {' · '}
                      {relativeAge(agent.startedAt)} ago
                      {agent.uiUrl ? ` · ${agent.uiUrl}` : ''}
                    </Typography>
                  </Box>

                  {/* Actions */}
                  <Stack direction="row" spacing={0} sx={{ flexShrink: 0 }}>
                    {agent.uiUrl && (
                      <Tooltip title="Open in browser">
                        <IconButton
                          size="small"
                          onClick={() => onOpen(agent)}
                          sx={{ p: 0.25 }}
                        >
                          <OpenInNewIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {isRunning && (
                      <Tooltip title="Stop (graceful, 10s timeout)">
                        <IconButton
                          size="small"
                          onClick={() => onStop(agent, false)}
                          color="warning"
                          sx={{ p: 0.25 }}
                        >
                          <StopIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {isRunning && (
                      <Tooltip title="Force stop (tree-kill — last resort)">
                        <IconButton
                          size="small"
                          onClick={() => onStop(agent, true)}
                          color="error"
                          sx={{ p: 0.25 }}
                        >
                          <StopCircleIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {isTerminal && (
                      <Tooltip title="Remove from list">
                        <IconButton
                          size="small"
                          onClick={() => onRemove(agent)}
                          sx={{ p: 0.25 }}
                        >
                          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                </Stack>
              </Box>
            </Box>
          );
        })}
      </Stack>

      <Snackbar
        open={!!snack}
        autoHideDuration={4000}
        onClose={() => setSnack(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack ? (
          <Alert severity={snack.severity} onClose={() => setSnack(undefined)}>
            {snack.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
