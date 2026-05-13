/**
 * "Launch logs" panel — always-mounted, collapsible side-panel listing
 * every model launch attempt the user has triggered this session,
 * including:
 *
 *   - currently running llama-server children
 *   - children that have exited (any cause: graceful Stop, crash, the
 *     binary refusing a flag, etc.) — kept around with `exited` flag
 *   - spawn failures that never produced a real OS pid (synthetic
 *     negative pid, status = exited immediately with the error in the
 *     log buffer)
 *
 * Default state is **collapsed** with just a "Launch logs (N)" header,
 * so the sidebar stays compact for users who don't need it. The
 * expansion state is persisted to `localStorage` so the user's
 * preference survives across sessions.
 *
 * Polls `runnersRunning` every 3s; refreshes immediately after Stop /
 * Dismiss actions. Each row exposes:
 *   - the model name + status sub-label
 *   - a "view captured stdout/stderr" icon → opens a Dialog with the
 *     full ring buffer + the spawned command
 *   - per-row actions (Open in browser / Stop while alive, Dismiss
 *     when exited)
 *
 * Lives in `ModelhubGlobalStatus` (sidebar footer).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import StopIcon from '@mui/icons-material/Stop';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DescriptionIcon from '@mui/icons-material/Description';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  RunningEntry,
  dismissRunner,
  getRunnerLog,
  listRunningModels,
  openChatForPid,
  stopRunner,
} from './runners/useRunners';

const POLL_INTERVAL_MS = 3000;
const EXPANDED_STORAGE_KEY = 'modelhub.launchLogs.expanded';

interface SnackState {
  msg: string;
  severity: 'success' | 'error' | 'info';
}

interface LogDialogState {
  entry: RunningEntry;
  log: string[];
  loading: boolean;
  error?: string;
}

export default function RunningModelsPanel(): JSX.Element {
  const [running, setRunning] = useState<RunningEntry[]>([]);
  const [snack, setSnack] = useState<SnackState | undefined>();
  const [busyPid, setBusyPid] = useState<number | undefined>();
  const [logDialog, setLogDialog] = useState<LogDialogState | undefined>();
  /**
   * Expanded by default = false. Restored from localStorage so the
   * user's preference survives across sessions. We don't return null
   * any more — the panel is always mounted so it's discoverable even
   * before any launch.
   */
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(EXPANDED_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(EXPANDED_STORAGE_KEY, String(next));
      } catch {
        /* private mode / disabled storage — ignore */
      }
      return next;
    });
  }, []);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await listRunningModels();
      if (!aliveRef.current) return;
      setRunning(r);
    } catch {
      /* poll loop swallows errors — no point spamming the UI */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  const onStop = useCallback(
    async (entry: RunningEntry) => {
      setBusyPid(entry.pid);
      try {
        await stopRunner(entry.pid);
        setSnack({
          msg: `Stopped ${entry.runnerLabel ?? 'runner'}${entry.modelName ? ` — ${entry.modelName}` : ''}`,
          severity: 'info',
        });
        await refresh();
      } catch (e) {
        setSnack({
          msg: `Stop failed: ${(e as Error).message}`,
          severity: 'error',
        });
      } finally {
        setBusyPid(undefined);
      }
    },
    [refresh],
  );

  const onOpenInBrowser = useCallback(async (entry: RunningEntry) => {
    setBusyPid(entry.pid);
    try {
      const r = await openChatForPid(entry.pid);
      if (!r.ok) {
        setSnack({ msg: r.error ?? 'open failed', severity: 'error' });
        return;
      }
      setSnack({ msg: 'Opened in your browser', severity: 'success' });
    } finally {
      setBusyPid(undefined);
    }
  }, []);

  const onOpenLog = useCallback(async (entry: RunningEntry) => {
    setLogDialog({ entry, log: [], loading: true });
    try {
      const log = await getRunnerLog(entry.pid);
      setLogDialog({ entry, log, loading: false });
    } catch (e) {
      setLogDialog({
        entry,
        log: [],
        loading: false,
        error: (e as Error).message,
      });
    }
  }, []);

  const onDismiss = useCallback(
    async (entry: RunningEntry) => {
      setBusyPid(entry.pid);
      try {
        await dismissRunner(entry.pid);
        await refresh();
      } catch (e) {
        setSnack({
          msg: `Dismiss failed: ${(e as Error).message}`,
          severity: 'error',
        });
      } finally {
        setBusyPid(undefined);
      }
    },
    [refresh],
  );

  const onCopyText = useCallback(async (text: string, label: string) => {
    if (!text) {
      setSnack({ msg: `${label} is empty`, severity: 'info' });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setSnack({ msg: `${label} copied`, severity: 'success' });
    } catch (e) {
      setSnack({
        msg: `Clipboard failed: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }, []);

  const onCopyUrl = useCallback(
    (entry: RunningEntry) => onCopyText(entry.url ?? '', 'URL'),
    [onCopyText],
  );

  // Group by provenance: "Direct" bucket (user-initiated from the app)
  // sorted first, then one bucket per unique `launchedBy` label
  // (alphabetical for stability). Lets the user see at a glance which
  // models a connected MCP client like deer-flow has booted.
  const groups: { label: string; entries: RunningEntry[] }[] = [];
  const directEntries = running.filter((e) => !e.launchedBy);
  if (directEntries.length > 0) {
    groups.push({ label: 'Direct', entries: directEntries });
  }
  const remoteLabels = Array.from(
    new Set(running.map((e) => e.launchedBy).filter((x): x is string => !!x)),
  ).sort();
  for (const label of remoteLabels) {
    groups.push({
      label,
      entries: running.filter((e) => e.launchedBy === label),
    });
  }

  const liveCount = running.filter((e) => !e.exited).length;
  const exitedCount = running.length - liveCount;

  return (
    <Box sx={{ mt: 1 }}>
      {/* Header is always visible and clickable so the panel is
          discoverable even when no launches have happened yet. */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.25}
        sx={{
          cursor: 'pointer',
          userSelect: 'none',
          py: 0.25,
          '&:hover': { color: 'primary.main' },
        }}
        onClick={toggleExpanded}
        data-tid="modelhubLaunchLogsToggle"
      >
        {expanded ? (
          <ExpandMoreIcon sx={{ fontSize: 16 }} />
        ) : (
          <ChevronRightIcon sx={{ fontSize: 16 }} />
        )}
        <Typography variant="caption" sx={{ fontWeight: 500 }}>
          Launch logs ({running.length})
        </Typography>
        {liveCount > 0 && (
          <Typography
            variant="caption"
            color="success.main"
            sx={{ fontSize: '0.7em' }}
          >
            · {liveCount} running
          </Typography>
        )}
        {exitedCount > 0 && (
          <Typography
            variant="caption"
            color="error.main"
            sx={{ fontSize: '0.7em' }}
          >
            · {exitedCount} exited
          </Typography>
        )}
      </Stack>

      {expanded && running.length === 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', pl: 2.25, mt: 0.25, fontStyle: 'italic' }}
        >
          No launches yet. Click Run on a model file to spawn a llama-server.
        </Typography>
      )}

      {/* Cap the list height so a user running many models doesn't push
          the bottom toolbar off-screen — the list scrolls internally
          beyond ~3 entries. */}
      <Stack
        spacing={0.75}
        sx={{
          maxHeight: 260,
          overflowY: 'auto',
          pr: 0.5,
          mt: expanded && running.length > 0 ? 0.5 : 0,
          display: expanded && running.length > 0 ? 'flex' : 'none',
        }}
      >
        {groups.map((group) => (
          <Box key={group.label}>
            {/* Hide the section header when there's only one group AND
                it's the implicit Direct bucket — keeps the compact look
                for the common case (no MCP clients connected). */}
            {(groups.length > 1 || group.label !== 'Direct') && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  display: 'block',
                  fontSize: '0.65em',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  mb: 0.25,
                  pl: 0.25,
                }}
              >
                {group.label}
              </Typography>
            )}
            <Stack spacing={0.5}>
              {group.entries.map((entry) => {
                const busy = busyPid === entry.pid;
                const isDead = !!entry.exited;
                const titleLabel =
                  entry.modelName ?? entry.command[0] ?? `pid ${entry.pid}`;
                let subLabel = entry.runnerLabel ?? 'llama-server';
                if (isDead) {
                  const ex = entry.exited!;
                  subLabel = `exited${
                    ex.code !== null ? ` (code ${ex.code})` : ''
                  }${ex.signal ? ` [${ex.signal}]` : ''}`;
                }
                return (
                  <Box
                    key={entry.pid}
                    sx={{
                      p: 0.75,
                      borderRadius: 0.5,
                      border: 1,
                      borderColor: isDead ? 'error.main' : 'divider',
                      backgroundColor: isDead ? 'error.dark' : 'action.hover',
                      opacity: isDead ? 0.85 : 1,
                    }}
                  >
                    <Stack direction="row" alignItems="center" spacing={0.5}>
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
                            color: isDead ? 'error.contrastText' : undefined,
                          }}
                        >
                          {titleLabel}
                        </Typography>
                        <Typography
                          variant="caption"
                          color={
                            isDead ? 'error.contrastText' : 'text.secondary'
                          }
                          sx={{
                            display: 'block',
                            fontSize: '0.7em',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {subLabel}
                          {!isDead && entry.url ? ` · ${entry.url}` : ''}
                        </Typography>
                      </Box>
                      {!isDead && entry.url && (
                        <Tooltip title="Copy URL">
                          <IconButton
                            size="small"
                            onClick={() => onCopyUrl(entry)}
                            sx={{ p: 0.25 }}
                          >
                            <ContentCopyIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Tooltip title="View captured stdout/stderr">
                        <IconButton
                          size="small"
                          onClick={() => onOpenLog(entry)}
                          sx={{ p: 0.25 }}
                        >
                          <DescriptionIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                      {!isDead && (
                        <Tooltip title="Open in browser">
                          <IconButton
                            size="small"
                            onClick={() => onOpenInBrowser(entry)}
                            disabled={busy || !entry.url}
                            color="primary"
                            sx={{ p: 0.25 }}
                          >
                            {busy ? (
                              <CircularProgress size={12} />
                            ) : (
                              <OpenInNewIcon sx={{ fontSize: 14 }} />
                            )}
                          </IconButton>
                        </Tooltip>
                      )}
                      {!isDead && (
                        <Tooltip title="Stop this runner">
                          <IconButton
                            size="small"
                            onClick={() => onStop(entry)}
                            disabled={busy}
                            color="warning"
                            sx={{ p: 0.25 }}
                          >
                            <StopIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                      {isDead && (
                        <Tooltip title="Dismiss (remove from the list)">
                          <IconButton
                            size="small"
                            onClick={() => onDismiss(entry)}
                            disabled={busy}
                            sx={{ p: 0.25 }}
                          >
                            <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Stack>
                  </Box>
                );
              })}
            </Stack>
          </Box>
        ))}
      </Stack>

      <Dialog
        open={!!logDialog}
        onClose={() => setLogDialog(undefined)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {logDialog?.entry.modelName ??
            logDialog?.entry.command[0] ??
            `pid ${logDialog?.entry.pid}`}{' '}
          — output
        </DialogTitle>
        <DialogContent dividers>
          {logDialog?.entry.exited && (
            <Typography
              variant="caption"
              color="error.main"
              sx={{ display: 'block', mb: 1 }}
            >
              Exited {logDialog.entry.exited.exitedAt}
              {logDialog.entry.exited.code !== null
                ? ` · code ${logDialog.entry.exited.code}`
                : ''}
              {logDialog.entry.exited.signal
                ? ` · signal ${logDialog.entry.exited.signal}`
                : ''}
            </Typography>
          )}
          {logDialog?.loading && <CircularProgress size={20} />}
          {logDialog?.error && (
            <Typography variant="body2" color="error">
              {logDialog.error}
            </Typography>
          )}
          {!logDialog?.loading && !logDialog?.error && (
            <Box sx={{ position: 'relative' }}>
              <Tooltip title="Copy output">
                <IconButton
                  size="small"
                  onClick={() =>
                    onCopyText(
                      logDialog && logDialog.log.length > 0
                        ? logDialog.log.join('\n')
                        : '',
                      'Output',
                    )
                  }
                  sx={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    p: 0.5,
                    backgroundColor: 'background.paper',
                    '&:hover': { backgroundColor: 'action.hover' },
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Box
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.78em',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  m: 0,
                  maxHeight: '60vh',
                  overflowY: 'auto',
                  backgroundColor: 'background.default',
                  p: 1,
                  pr: 5, // leave room for the floating Copy button
                  borderRadius: 0.5,
                  userSelect: 'text',
                }}
              >
                {logDialog && logDialog.log.length > 0
                  ? logDialog.log.join('\n')
                  : '(no output captured)'}
              </Box>
            </Box>
          )}
          {/* Full command — useful when reporting bugs. */}
          {logDialog?.entry.command && (
            <Box sx={{ mt: 1, position: 'relative' }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.25 }}
              >
                Spawn command
              </Typography>
              <Tooltip title="Copy spawn command">
                <IconButton
                  size="small"
                  onClick={() =>
                    onCopyText(
                      logDialog.entry.command.join(' '),
                      'Spawn command',
                    )
                  }
                  sx={{
                    position: 'absolute',
                    top: 0,
                    right: 4,
                    p: 0.5,
                    backgroundColor: 'background.paper',
                    '&:hover': { backgroundColor: 'action.hover' },
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Box
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.72em',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  m: 0,
                  p: 0.75,
                  pr: 5, // room for the floating Copy button
                  backgroundColor: 'background.default',
                  borderRadius: 0.5,
                  opacity: 0.85,
                  userSelect: 'text',
                }}
              >
                {logDialog.entry.command.join(' ')}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {logDialog?.entry && (
            <Button
              onClick={() => {
                if (logDialog) onOpenLog(logDialog.entry);
              }}
              size="small"
            >
              Refresh
            </Button>
          )}
          <Button onClick={() => setLogDialog(undefined)} size="small">
            Close
          </Button>
        </DialogActions>
      </Dialog>

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
