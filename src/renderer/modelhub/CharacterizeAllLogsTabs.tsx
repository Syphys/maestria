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
 *                        processed model, read from the signature's
 *                        `behavioral.diagnostic_run`. Updates as soon
 *                        as the signature is re-saved (next poll).
 *
 * No interactions are persisted by this panel — they already live in
 * the signature JSON; we just visualise them. The error + server logs
 * persist on disk because they're meant to outlive the in-memory
 * `progress` object (you can open the « Tests Maestria » questions
 * folder anywhere later and the `.error` / `.log` files are still
 * there for inspection).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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

/** Poll the current model's signature so the interactions update live. */
function usePolledSignature(
  filePath: string | undefined,
  enabled: boolean,
  intervalMs = 1500,
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
    const fetchOnce = async () => {
      try {
        const r = (await i.invoke(MODELHUB_IPC.loadSignature, filePath)) as {
          ok: boolean;
          signature?: Signature | null;
        };
        if (!cancelled && r.ok) setSig(r.signature ?? undefined);
      } catch {
        /* swallow */
      }
    };
    void fetchOnce();
    if (!enabled) return undefined;
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [filePath, enabled, intervalMs]);
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

  // Poll only the tabs the user is looking at (saves IPC churn), and
  // only while no text selection is in progress.
  const serverPollEnabled = running && tab === 'server' && !selecting;
  const interactionsPollEnabled =
    running && tab === 'interactions' && !selecting;
  const serverLog = usePolledText(
    MODELHUB_IPC.getServerLog,
    progress.currentFile,
    serverPollEnabled,
  );
  const signature = usePolledSignature(
    progress.currentFile,
    interactionsPollEnabled,
  );

  // Interactions are extracted from `behavioral.diagnostic_run` —
  // ordered by `startedAt` so the user sees the chronological flow.
  const interactions: [string, DiagnosticRunEntry][] = useMemo(() => {
    const run = signature?.behavioral?.diagnostic_run;
    if (!run) return [];
    return Object.entries(run).sort(([, a], [, b]) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
    );
  }, [signature]);

  const errorsRef = useAutoScrollBottom([progress.errorSamples.length]);
  const serverRef = useAutoScrollBottom([serverLog]);
  const interactionsRef = useAutoScrollBottom([interactions.length]);

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
