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
 * Per-row UX:
 *   - model name → clickable, navigates to the file's properties tab
 *   - URL → clickable, opens the runner's web UI in the default browser
 *     (replaces the earlier dedicated "Open in browser" icon button)
 *   - icons: copy URL, view captured stdout/stderr, Stop / Dismiss
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  Link,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import StopIcon from '@mui/icons-material/Stop';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DescriptionIcon from '@mui/icons-material/Description';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useSelectedEntriesContext } from '-/hooks/useSelectedEntriesContext';
import {
  RunningEntry,
  dismissRunner,
  getRunnerLog,
  listRunningModels,
  openChatForPid,
  stopRunner,
  subscribeExit,
  subscribeLogChunks,
} from './runners/useRunners';

/**
 * Lines matching this regex are surfaced in red/orange in the log
 * dialog. Conservative on purpose — too many false positives would
 * defeat the visual cue. Tuned against the real llama-server output:
 *   - "error: …", "ERROR" — explicit failures
 *   - "warning: …" — yellow band
 *   - "out of memory" — VRAM/RAM OOM
 *   - "unknown argument" — runner refused a flag
 *   - "cuda" / "rocm" / "hip" / "vulkan" lines that also contain
 *     "error" / "fail" — surface GPU-specific boot failures distinctly
 */
const ERROR_LINE_RE =
  /\b(error|fail(ed)?|out of memory|unknown (argument|option))\b/i;
const WARNING_LINE_RE = /\b(warning|warn|deprecated)\b/i;

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
  const { t } = useTranslation();
  const { openEntry } = useOpenedEntryContext();
  const { openDirectory, getAllPropertiesPromise } =
    useDirectoryContentContext();
  const { setSelectedEntries } = useSelectedEntriesContext();
  const [running, setRunning] = useState<RunningEntry[]>([]);
  const [snack, setSnack] = useState<SnackState | undefined>();
  const [busyPid, setBusyPid] = useState<number | undefined>();
  const [logDialog, setLogDialog] = useState<LogDialogState | undefined>();
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

  /**
   * Live-tail: when the dialog is open for pid X and main process pushes
   * new lines for that same pid, append them in place. Other pids' lines
   * are dropped (the panel poll picks them up via `recentLog` if needed).
   * Subscription stays mounted for the panel's lifetime — the closure
   * always sees the latest `logDialog` via `setLogDialog`'s functional
   * form, so we don't need to re-subscribe on every dialog change.
   */
  useEffect(() => {
    const off = subscribeLogChunks(({ pid, lines }) => {
      setLogDialog((prev) => {
        if (!prev || prev.entry.pid !== pid) return prev;
        return { ...prev, log: [...prev.log, ...lines] };
      });
    });
    return off;
  }, []);

  /**
   * Auto-open the dialog when a process exits within the boot-crash
   * window — the user is staring at the panel waiting for the launch
   * to succeed; surfacing the diagnostic immediately saves a click.
   * Also kick a refresh so the row flips to the exited (red) style
   * without waiting for the next 3 s poll tick.
   */
  useEffect(() => {
    const off = subscribeExit(({ pid, crashedEarly }) => {
      refresh();
      if (!crashedEarly) return;
      // Snapshot the entry from the latest poll. If we don't have it
      // yet (very fast crash, before our first refresh), best-effort
      // re-fetch then open.
      (async () => {
        let entry = running.find((e) => e.pid === pid);
        if (!entry) {
          const fresh = await listRunningModels().catch(() => []);
          entry = fresh.find((e) => e.pid === pid);
        }
        if (!entry) return;
        await onOpenLog(entry);
      })();
    });
    return off;
    // running + onOpenLog are stable enough — re-subscribing on every
    // poll tick (3 s) would create churn for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStop = useCallback(
    async (entry: RunningEntry) => {
      setBusyPid(entry.pid);
      try {
        await stopRunner(entry.pid);
        const runner = entry.runnerLabel ?? 'llama-server';
        setSnack({
          msg: entry.modelName
            ? t('core:mhRunLogStoppedWithModel', {
                runner,
                model: entry.modelName,
              })
            : t('core:mhRunLogStopped', { runner }),
          severity: 'info',
        });
        await refresh();
      } catch (e) {
        setSnack({
          msg: t('core:mhRunLogStopFailed', { err: (e as Error).message }),
          severity: 'error',
        });
      } finally {
        setBusyPid(undefined);
      }
    },
    [refresh, t],
  );

  const onOpenUrl = useCallback(
    async (entry: RunningEntry) => {
      if (!entry.url) return;
      setBusyPid(entry.pid);
      try {
        const r = await openChatForPid(entry.pid);
        if (!r.ok) {
          setSnack({
            msg: r.error ?? t('core:mhRunLogOpenFailed'),
            severity: 'error',
          });
          return;
        }
        setSnack({
          msg: t('core:mhRunLogOpenedInBrowser'),
          severity: 'success',
        });
      } finally {
        setBusyPid(undefined);
      }
    },
    [t],
  );

  /**
   * Three-step navigation so the model actually stands out in the file
   * list, not just the right-hand properties panel:
   *   1. `openDirectory(parentDir)` switches the perspective view to
   *      the model's containing folder.
   *   2. `getAllPropertiesPromise` resolves the FsEntry from the path.
   *   3. `setSelectedEntries([entry])` highlights the row, then
   *      `openEntry` opens the properties tab.
   * Falls back to a plain `openEntry` if anything goes wrong — the
   * user still gets the properties panel even when the directory
   * load fails (e.g. the file's location is currently disconnected).
   */
  const onNavigateToFile = useCallback(
    async (entry: RunningEntry) => {
      if (!entry.filePath) return;
      const filePath = entry.filePath;
      try {
        const parentDir = filePath.replace(/[\\/][^\\/]+$/, '');
        if (parentDir && parentDir !== filePath) {
          await openDirectory(parentDir);
        }
        try {
          const fsEntry = await getAllPropertiesPromise(filePath);
          if (fsEntry) {
            setSelectedEntries([fsEntry]);
          }
        } catch {
          /* selection is best-effort — properties panel still opens */
        }
        await openEntry(filePath);
      } catch (e) {
        setSnack({
          msg: t('core:mhRunLogNavigateFailed', {
            err: (e as Error).message,
          }),
          severity: 'error',
        });
      }
    },
    [openDirectory, getAllPropertiesPromise, setSelectedEntries, openEntry, t],
  );

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
          msg: t('core:mhRunLogDismissFailed', {
            err: (e as Error).message,
          }),
          severity: 'error',
        });
      } finally {
        setBusyPid(undefined);
      }
    },
    [refresh, t],
  );

  const onCopyText = useCallback(
    async (text: string, label: string) => {
      if (!text) {
        setSnack({
          msg: t('core:mhRunLogCopyEmpty', { label }),
          severity: 'info',
        });
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setSnack({
          msg: t('core:mhRunLogCopied', { label }),
          severity: 'success',
        });
      } catch (e) {
        setSnack({
          msg: t('core:mhRunLogCopyFailed', { err: (e as Error).message }),
          severity: 'error',
        });
      }
    },
    [t],
  );

  const onCopyUrl = useCallback(
    (entry: RunningEntry) => onCopyText(entry.url ?? '', t('core:mhRunLogUrl')),
    [onCopyText, t],
  );

  const groups: { label: string; entries: RunningEntry[] }[] = [];
  const directEntries = running.filter((e) => !e.launchedBy);
  if (directEntries.length > 0) {
    groups.push({
      label: t('core:mhRunLogGroupDirect'),
      entries: directEntries,
    });
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
          {t('core:mhRunLogTitle', { count: running.length })}
        </Typography>
        {liveCount > 0 && (
          <Typography
            variant="caption"
            color="success.main"
            sx={{ fontSize: '0.7em' }}
          >
            · {t('core:mhRunLogRunning', { count: liveCount })}
          </Typography>
        )}
        {exitedCount > 0 && (
          <Typography
            variant="caption"
            color="error.main"
            sx={{ fontSize: '0.7em' }}
          >
            · {t('core:mhRunLogExited', { count: exitedCount })}
          </Typography>
        )}
      </Stack>

      {expanded && running.length === 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', pl: 2.25, mt: 0.25, fontStyle: 'italic' }}
        >
          {t('core:mhRunLogEmpty')}
        </Typography>
      )}

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
            {(groups.length > 1 ||
              group.label !== t('core:mhRunLogGroupDirect')) && (
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
                  subLabel = t('core:mhRunLogRowExited');
                  if (ex.code !== null)
                    subLabel += ` (${t('core:mhRunLogCode', { code: ex.code })})`;
                  if (ex.signal) subLabel += ` [${ex.signal}]`;
                }
                const canNavigate = !!entry.filePath;
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
                        {canNavigate ? (
                          <Tooltip
                            title={t('core:mhRunLogNavigateTooltip', {
                              path: entry.filePath,
                            })}
                            placement="top"
                          >
                            <Link
                              component="button"
                              type="button"
                              underline="hover"
                              onClick={() => onNavigateToFile(entry)}
                              sx={{
                                display: 'block',
                                width: '100%',
                                textAlign: 'left',
                                fontSize: '0.78em',
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                color: isDead
                                  ? 'error.contrastText'
                                  : 'primary.main',
                              }}
                            >
                              {titleLabel}
                            </Link>
                          </Tooltip>
                        ) : (
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
                        )}
                        <Stack
                          direction="row"
                          spacing={0.5}
                          alignItems="center"
                          sx={{ minWidth: 0 }}
                        >
                          <Typography
                            variant="caption"
                            color={
                              isDead ? 'error.contrastText' : 'text.secondary'
                            }
                            sx={{
                              fontSize: '0.7em',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flexShrink: 1,
                            }}
                          >
                            {subLabel}
                          </Typography>
                          {!isDead && entry.url && (
                            <>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontSize: '0.7em' }}
                              >
                                ·
                              </Typography>
                              <Tooltip
                                title={t('core:mhRunLogOpenUrlTooltip', {
                                  url: entry.url,
                                })}
                                placement="top"
                              >
                                <Link
                                  component="button"
                                  type="button"
                                  underline="hover"
                                  onClick={() => onOpenUrl(entry)}
                                  disabled={busy}
                                  sx={{
                                    fontSize: '0.7em',
                                    fontFamily: 'monospace',
                                    color: 'primary.main',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    p: 0,
                                    minWidth: 0,
                                  }}
                                >
                                  {entry.url}
                                </Link>
                              </Tooltip>
                            </>
                          )}
                        </Stack>
                      </Box>
                      {!isDead && entry.url && (
                        <Tooltip title={t('core:mhRunLogCopyUrl')}>
                          <IconButton
                            size="small"
                            onClick={() => onCopyUrl(entry)}
                            sx={{ p: 0.25 }}
                          >
                            <ContentCopyIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Tooltip title={t('core:mhRunLogViewLog')}>
                        <IconButton
                          size="small"
                          onClick={() => onOpenLog(entry)}
                          sx={{ p: 0.25 }}
                        >
                          <DescriptionIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                      {!isDead && (
                        <Tooltip title={t('core:mhRunLogStop')}>
                          <IconButton
                            size="small"
                            onClick={() => onStop(entry)}
                            disabled={busy}
                            color="warning"
                            sx={{ p: 0.25 }}
                          >
                            {busy ? (
                              <CircularProgress size={12} />
                            ) : (
                              <StopIcon sx={{ fontSize: 16 }} />
                            )}
                          </IconButton>
                        </Tooltip>
                      )}
                      {isDead && (
                        <Tooltip title={t('core:mhRunLogDismiss')}>
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
          — {t('core:mhRunLogDialogTitleSuffix')}
        </DialogTitle>
        <DialogContent dividers>
          {logDialog?.entry.exited && (
            <Typography
              variant="caption"
              color="error.main"
              sx={{ display: 'block', mb: 1 }}
            >
              {t('core:mhRunLogDialogExited', {
                when: logDialog.entry.exited.exitedAt,
              })}
              {logDialog.entry.exited.code !== null
                ? ` · ${t('core:mhRunLogCode', { code: logDialog.entry.exited.code })}`
                : ''}
              {logDialog.entry.exited.signal
                ? ` · ${t('core:mhRunLogSignal', { signal: logDialog.entry.exited.signal })}`
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
              <Tooltip title={t('core:mhRunLogCopyOutput')}>
                <IconButton
                  size="small"
                  onClick={() =>
                    onCopyText(
                      logDialog && logDialog.log.length > 0
                        ? logDialog.log.join('\n')
                        : '',
                      t('core:mhRunLogOutputLabel'),
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
                  pr: 5,
                  borderRadius: 0.5,
                  userSelect: 'text',
                }}
              >
                {logDialog && logDialog.log.length > 0
                  ? logDialog.log.map((line, i) => {
                      // Per-line render so error/warning lines get a
                      // color cue without painting the whole pane.
                      let color: string | undefined;
                      if (ERROR_LINE_RE.test(line)) color = 'error.main';
                      else if (WARNING_LINE_RE.test(line))
                        color = 'warning.main';
                      return (
                        <Box
                          component="span"
                          key={i}
                          sx={{
                            display: 'block',
                            color,
                            // Bold the error lines so they stand out
                            // even for users with reduced color sensitivity.
                            fontWeight: color === 'error.main' ? 600 : 400,
                          }}
                        >
                          {line}
                        </Box>
                      );
                    })
                  : t('core:mhRunLogNoOutput')}
              </Box>
            </Box>
          )}
          {logDialog?.entry.command && (
            <Box sx={{ mt: 1, position: 'relative' }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.25 }}
              >
                {t('core:mhRunLogSpawnCommand')}
              </Typography>
              <Tooltip title={t('core:mhRunLogCopySpawnCommand')}>
                <IconButton
                  size="small"
                  onClick={() =>
                    onCopyText(
                      logDialog.entry.command.join(' '),
                      t('core:mhRunLogSpawnCommand'),
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
                  pr: 5,
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
              {t('core:mhRunLogDialogRefresh')}
            </Button>
          )}
          <Button onClick={() => setLogDialog(undefined)} size="small">
            {t('core:closeButton')}
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
