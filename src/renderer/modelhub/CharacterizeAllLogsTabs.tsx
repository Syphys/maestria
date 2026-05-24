/**
 * Tabbed log surface for the bulk « Caractériser tous les modèles »
 * panel. Three tabs, each with an infinite-scroll list:
 *
 *   - « Erreurs »      → the full progress.errorSamples list (no cap),
 *                        plus the on-disk `.ts/<model>.error` for the
 *                        currently-processed model.
 *   - « Logs serveur » → tail of `.ts/<model>.log` (llama-server
 *                        stdout/stderr) for the currently-processed
 *                        model, polled every 1 s while the bulk run
 *                        is active.
 *   - « Interactions » → prompts + responses for the currently-
 *                        processed model. LIVE: each `prompt_done`
 *                        event coming through `progress.modelStatus`
 *                        carries the full DiagnosticRunEntry, which we
 *                        accumulate into a per-model buffer. Once the
 *                        model finishes, we fall back to the persisted
 *                        signature so previously-completed models still
 *                        show their full diagnostic_run.
 *
 * No interactions are persisted by this panel — they already live in
 * the signature JSON; we just visualise them. The error + server logs
 * persist on disk because they're meant to outlive the in-memory
 * `progress` object (you can open the « Tests Maestria » questions
 * folder anywhere later and the `.error` / `.log` files are still
 * there for inspection).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  IconButton,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { MODELHUB_IPC } from './types';
import { promptTextById } from './promptText';
import type { CharacterizeAllProgress } from './useCharacterizeAll';
import type { DiagnosticRunEntry, Signature } from '../../shared/RoutingTypes';

interface Props {
  progress: CharacterizeAllProgress;
  /** True while the bulk run is active — drives the live polling. */
  running: boolean;
}

type IpcLite = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

function ipc(): IpcLite | undefined {
  return window.electronIO?.ipcRenderer as unknown as IpcLite | undefined;
}

/** Last path segment — keeps the error / log lines readable. */
function baseName(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

/** Auto-scroll a scrollable Box to the bottom when its content grows. */
function useAutoScrollBottom(
  deps: ReadonlyArray<unknown>,
): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only auto-scroll when the user is already near the bottom — never
    // yank them away from a line they're reading mid-scroll.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Poll an IPC text endpoint for the given filePath while `enabled`. */
function usePolledText(
  channel: string,
  filePath: string | undefined,
  enabled: boolean,
  intervalMs = 1000,
): string {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!filePath) {
      setText('');
      return undefined;
    }
    let cancelled = false;
    const i = ipc();
    if (!i?.invoke) return undefined;
    const fetchOnce = async () => {
      try {
        const r = (await i.invoke(channel, filePath)) as {
          ok: boolean;
          content?: string;
        };
        if (!cancelled && r.ok) setText(r.content ?? '');
      } catch {
        /* swallow — keep showing the last good content */
      }
    };
    void fetchOnce();
    if (!enabled) return undefined;
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [channel, filePath, enabled, intervalMs]);
  return text;
}

/**
 * Read the current model's signature once. Used as a fallback for the
 * « Interactions » tab when no live entries are in flight (model just
 * finished, or user is browsing a previously-characterized model).
 * Refreshes when `filePath` changes — no polling, the live source is
 * `progress.modelStatus` which we observe in the parent component.
 */
function useLoadedSignature(
  filePath: string | undefined,
): Signature | undefined {
  const [sig, setSig] = useState<Signature | undefined>();
  useEffect(() => {
    if (!filePath) {
      setSig(undefined);
      return undefined;
    }
    let cancelled = false;
    const i = ipc();
    if (!i?.invoke) return undefined;
    void (async () => {
      try {
        const r = (await i.invoke(MODELHUB_IPC.loadSignature, filePath)) as {
          ok: boolean;
          signature?: Signature | null;
        };
        if (!cancelled && r.ok) setSig(r.signature ?? undefined);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  return sig;
}

/**
 * True while the user is actively highlighting text anywhere on the
 * page. Used to pause the 1 s polling on the server/interactions tabs
 * — otherwise every poll re-renders the content and wipes the selection
 * the user is mid-drag on. Cheap subscription (single `selectionchange`
 * listener for the whole component tree).
 */
function useHasActiveSelection(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const onChange = () => {
      const s = window.getSelection();
      setHas(!!s && !s.isCollapsed && s.toString().length > 0);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);
  return has;
}

function CharacterizeAllLogsTabs({ progress, running }: Props): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'errors' | 'server' | 'interactions'>(
    'errors',
  );
  const [copied, setCopied] = useState(false);
  // Live polling wipes any in-progress selection on the re-rendered tab.
  // Pause polling while the user is highlighting text so they can drag
  // across multiple lines without losing their range on the next tick.
  const selecting = useHasActiveSelection();

  // Server log: still polled (we don't stream it through the progress
  // event — too noisy). Only fetch when the tab is active and the user
  // isn't mid-selection.
  const serverPollEnabled = running && tab === 'server' && !selecting;
  const serverLog = usePolledText(
    MODELHUB_IPC.getServerLog,
    progress.currentFile,
    serverPollEnabled,
  );
  // Fallback for finished or pre-existing models — no polling, just one
  // load per `currentFile` switch.
  const loadedSignature = useLoadedSignature(progress.currentFile);

  // LIVE entries — accumulated from `prompt_done` events that the main
  // process ships through `progress.modelStatus.progress`. Resets every
  // time the bulk run moves to a new model (`currentFile` change).
  const [liveEntries, setLiveEntries] = useState<
    Record<string, DiagnosticRunEntry>
  >({});
  const liveModelFileRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (liveModelFileRef.current !== progress.currentFile) {
      liveModelFileRef.current = progress.currentFile;
      setLiveEntries({});
    }
    const ms = progress.modelStatus;
    if (!ms || ms.stage !== 'running') return;
    const innerProgress = ms.progress;
    if (!innerProgress || innerProgress.kind !== 'prompt_done') return;
    const entry = innerProgress.entry;
    if (!entry) return;
    const id = innerProgress.promptId;
    setLiveEntries((prev) => {
      if (prev[id]?.finishedAt === entry.finishedAt) return prev; // dup
      return { ...prev, [id]: entry };
    });
  }, [progress.currentFile, progress.modelStatus]);

  // Source preference: live buffer (current model, in progress) overrides
  // the loaded signature. When the current model isn't being run (idle,
  // or browsing a previous one), fall back to the signature on disk so
  // the tab is never empty if there's data to show.
  const interactions: [string, DiagnosticRunEntry][] = useMemo(() => {
    const liveCount = Object.keys(liveEntries).length;
    const run =
      liveCount > 0 ? liveEntries : loadedSignature?.behavioral?.diagnostic_run;
    if (!run) return [];
    return Object.entries(run).sort(([, a], [, b]) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
    );
  }, [liveEntries, loadedSignature]);

  const errorsRef = useAutoScrollBottom([progress.errorSamples.length]);
  const serverRef = useAutoScrollBottom([serverLog]);
  const interactionsRef = useAutoScrollBottom([interactions.length]);

  // When the user switches tabs, force-scroll the newly-active tab to
  // the bottom — they want to see the LATEST entry / line, never the
  // first one. The continuous `useAutoScrollBottom` above only fires
  // on data changes (and respects the user's mid-scroll position),
  // so without this extra effect a tab switch would land at the top
  // of the freshly-mounted Box. Layout-effect so the scroll happens
  // BEFORE the browser paints — no visible jump from top to bottom.
  useLayoutEffect(() => {
    const ref =
      tab === 'errors'
        ? errorsRef
        : tab === 'server'
          ? serverRef
          : interactionsRef;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Refs are stable; we deliberately key only on `tab` so this
    // fires on the switch, not on every content update (those are
    // already covered by useAutoScrollBottom above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Plain-text rendering of the active tab — what the Copy button
  // writes to the clipboard. Memoised so a copy-click after several
  // polls doesn't re-serialise the whole list.
  const currentTabText = useMemo(() => {
    if (tab === 'errors') {
      return progress.errorSamples
        .map((s) => `${s.file}: ${s.error}`)
        .join('\n');
    }
    if (tab === 'server') return serverLog;
    return interactions
      .map(
        ([id, e]) =>
          `# ${id} ${e.pass === true ? '✓' : e.pass === false ? '✗' : '·'}` +
          (typeof e.score === 'number' ? ` (${e.score.toFixed(2)})` : '') +
          `\nQ: ${promptTextById(id) ?? '(prompt source unavailable)'}` +
          `\nR: ${e.response ?? '(empty)'}\n`,
      )
      .join('\n');
  }, [tab, progress.errorSamples, serverLog, interactions]);

  const copyCurrent = async () => {
    if (!currentTabText) return;
    try {
      await navigator.clipboard.writeText(currentTabText);
      setCopied(true);
    } catch {
      // Clipboard API can fail in iframes / non-secure contexts —
      // silently ignore, the user can still select + Ctrl+C.
    }
  };

  const scrollBoxSx = {
    maxHeight: 220,
    overflowY: 'auto' as const,
    userSelect: 'text' as const,
    fontFamily: 'monospace',
    fontSize: '0.7rem',
    lineHeight: 1.4,
    p: 0.75,
    border: (theme: any) => `1px solid ${theme.palette.divider}`,
    borderRadius: 1,
    bgcolor: 'background.default',
  };

  return (
    <Box sx={{ mt: 0.75 }}>
      {/* Tabs row + Copy action on the right. Copy lives outside the
          scrollable content so it stays reachable when the user has
          scrolled far down a long log. */}
      <Stack direction="row" alignItems="center" sx={{ minHeight: 28 }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v as typeof tab)}
          sx={{
            minHeight: 28,
            flex: 1,
            '& .MuiTab-root': { minHeight: 28, py: 0, minWidth: 0 },
          }}
        >
          <Tab
            value="errors"
            label={
              <Typography variant="caption">
                {t('core:mhCharAllTabErrors', {
                  n: progress.errorSamples.length,
                })}
              </Typography>
            }
          />
          <Tab
            value="server"
            label={
              <Typography variant="caption">
                {t('core:mhCharAllTabServer')}
              </Typography>
            }
          />
          <Tab
            value="interactions"
            label={
              <Typography variant="caption">
                {t('core:mhCharAllTabInteractions')}
              </Typography>
            }
          />
        </Tabs>
        <Tooltip title={t('core:mhCharAllTabCopy')}>
          <span>
            <IconButton
              size="small"
              onClick={copyCurrent}
              disabled={!currentTabText}
              aria-label={t('core:mhCharAllTabCopy')}
              data-tid="charAllTabCopyTID"
            >
              <ContentCopyIcon fontSize="inherit" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {tab === 'errors' && (
        <Box ref={errorsRef} sx={scrollBoxSx}>
          {progress.errorSamples.length === 0 ? (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ fontStyle: 'italic' }}
            >
              {t('core:mhCharAllTabErrorsEmpty')}
            </Typography>
          ) : (
            progress.errorSamples.map((s, i) => (
              <Typography
                key={`${s.file}-${i}`}
                variant="caption"
                color="error"
                sx={{
                  display: 'block',
                  fontFamily: 'monospace',
                  fontSize: '0.7rem',
                  wordBreak: 'break-word',
                  userSelect: 'text',
                }}
              >
                <strong>{baseName(s.file)}</strong>: {s.error}
              </Typography>
            ))
          )}
        </Box>
      )}

      {tab === 'server' && (
        <Box ref={serverRef} sx={scrollBoxSx}>
          {!progress.currentFile ? (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ fontStyle: 'italic' }}
            >
              {t('core:mhCharAllTabServerEmpty')}
            </Typography>
          ) : serverLog ? (
            <Tooltip title={progress.currentFile}>
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.5 }}
                >
                  {baseName(progress.currentFile)}
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    userSelect: 'text',
                  }}
                >
                  {serverLog}
                </Box>
              </Box>
            </Tooltip>
          ) : (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ fontStyle: 'italic' }}
            >
              {t('core:mhCharAllTabServerNoData')}
            </Typography>
          )}
        </Box>
      )}

      {tab === 'interactions' && (
        <Box ref={interactionsRef} sx={scrollBoxSx}>
          {interactions.length === 0 ? (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ fontStyle: 'italic' }}
            >
              {t('core:mhCharAllTabInteractionsEmpty')}
            </Typography>
          ) : (
            <Stack spacing={0.75}>
              {interactions.map(([id, e]) => (
                <Box
                  key={id}
                  sx={{
                    borderLeft: '2px solid',
                    borderLeftColor: 'divider',
                    pl: 0.75,
                    userSelect: 'text',
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      fontWeight: 600,
                      userSelect: 'text',
                    }}
                  >
                    {id} {e.pass === true ? '✓' : e.pass === false ? '✗' : '·'}
                    {typeof e.score === 'number'
                      ? ` (${e.score.toFixed(2)})`
                      : ''}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.primary"
                    sx={{
                      display: 'block',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      userSelect: 'text',
                    }}
                  >
                    Q: {promptTextById(id) ?? '(prompt source unavailable)'}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      userSelect: 'text',
                    }}
                  >
                    R: {e.response ?? '(empty)'}
                  </Typography>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      )}

      <Snackbar
        open={copied}
        onClose={() => setCopied(false)}
        autoHideDuration={1500}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={t('core:mhCharAllTabCopied')}
      />
    </Box>
  );
}

export default CharacterizeAllLogsTabs;
