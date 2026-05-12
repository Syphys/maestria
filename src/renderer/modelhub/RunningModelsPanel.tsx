/**
 * Persistent list of currently active model runtimes (real child
 * processes we spawned via `runnersLaunch`).
 *
 * Lives in `ModelhubGlobalStatus` so it stays visible across navigation —
 * the previous flow used a transient snackbar that vanished before the
 * user could read it. Polls `runnersRunning` every 3s; immediately
 * refreshes after Stop / launch actions so the UI feels responsive.
 *
 * Click "Open in browser" → `shell.openExternal(entry.url)` opens the
 * runner's native web UI (llama-server has one). No in-app chat surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import StopIcon from '@mui/icons-material/Stop';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  RunningEntry,
  listRunningModels,
  openChatForPid,
  stopRunner,
} from './runners/useRunners';

const POLL_INTERVAL_MS = 3000;

interface SnackState {
  msg: string;
  severity: 'success' | 'error' | 'info';
}

export default function RunningModelsPanel(): JSX.Element | null {
  const [running, setRunning] = useState<RunningEntry[]>([]);
  const [snack, setSnack] = useState<SnackState | undefined>();
  const [busyPid, setBusyPid] = useState<number | undefined>();
  /** True only on the very first load; avoids flashing "no models" on boot. */
  const [hydrated, setHydrated] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await listRunningModels();
      if (!aliveRef.current) return;
      setRunning(r);
      setHydrated(true);
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

  const onCopyUrl = useCallback(async (entry: RunningEntry) => {
    if (!entry.url) return;
    try {
      await navigator.clipboard.writeText(entry.url);
      setSnack({ msg: 'URL copied', severity: 'success' });
    } catch (e) {
      setSnack({
        msg: `Clipboard failed: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }, []);

  // Hide the panel entirely until we have data + at least one entry. No
  // point in showing an empty "Running models (0)" header.
  if (!hydrated || running.length === 0) return null;

  return (
    <Box sx={{ mt: 1 }}>
      <Typography
        variant="caption"
        sx={{ fontWeight: 500, display: 'block', mb: 0.5 }}
      >
        Running models ({running.length})
      </Typography>
      {/* Cap the list height so a user running many models doesn't push
          the bottom toolbar off-screen — the list scrolls internally
          beyond ~3 entries. */}
      <Stack spacing={0.5} sx={{ maxHeight: 220, overflowY: 'auto', pr: 0.5 }}>
        {running.map((entry) => {
          const busy = busyPid === entry.pid;
          const titleLabel =
            entry.modelName ?? entry.command[0] ?? `pid ${entry.pid}`;
          const subLabel =
            (entry.runnerLabel ? entry.runnerLabel : entry.runnerKind) ??
            (entry.managed ? 'managed' : 'external');
          return (
            <Box
              key={entry.pid}
              sx={{
                p: 0.75,
                borderRadius: 0.5,
                border: 1,
                borderColor: 'divider',
                backgroundColor: 'action.hover',
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
                    }}
                  >
                    {titleLabel}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      fontSize: '0.7em',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {subLabel}
                    {entry.url ? ` · ${entry.url}` : ''}
                  </Typography>
                </Box>
                {entry.url && (
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
                {/* Primary: open the runner's native web UI in the
                    user's default browser. shell.openExternal handles
                    the platform specifics. */}
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
                <Tooltip
                  title={
                    entry.managed
                      ? 'Stop this runner'
                      : 'Remove from list (does not stop the external daemon)'
                  }
                >
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
              </Stack>
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
