/**
 * In-app chat surface for an active runner.
 *
 * Streams against the runner's HTTP API directly (Ollama: `/api/chat`,
 * OpenAI-compat: `/v1/chat/completions`). Tokens are appended to the
 * in-flight assistant bubble as they arrive; Stop button aborts via a
 * shared AbortController, leaving the partial text visible.
 *
 * No persistence — closing the dialog clears history. The point is to
 * give "running" a payoff: type a question, see the model answer,
 * without leaving the app.
 */

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { ChatMessage, protocolForRunnerKind, streamChat } from './chatClient';
import { renderMarkdown } from '../hfMarkdown';
import { RunningEntry } from '../runners/useRunners';

interface Props {
  entry: RunningEntry | undefined;
  open: boolean;
  onClose: () => void;
}

interface Bubble extends ChatMessage {
  /** Set on the assistant bubble while tokens are still streaming in. */
  streaming?: boolean;
  /** Captured to display alongside an error if the request failed. */
  error?: string;
}

const PLACEHOLDER = 'Ask something… (Enter to send, Shift+Enter for newline)';

export default function ChatDialog({
  entry,
  open,
  onClose,
}: Props): JSX.Element {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | undefined>();
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom whenever bubbles update — natural "follow" behavior
  // while tokens stream in.
  useEffect(() => {
    if (!scrollAnchorRef.current) return;
    scrollAnchorRef.current.scrollIntoView({ block: 'end' });
  }, [bubbles]);

  // Reset history when the dialog is opened against a different model so
  // we never blend conversations across runners.
  const entryKey = entry ? `${entry.pid}:${entry.modelName ?? ''}` : '';
  const lastEntryKeyRef = useRef('');
  useEffect(() => {
    if (!open) return;
    if (lastEntryKeyRef.current === entryKey) return;
    lastEntryKeyRef.current = entryKey;
    setBubbles([]);
    setError(undefined);
    abortRef.current?.abort();
    abortRef.current = undefined;
    setStreaming(false);
  }, [open, entryKey]);

  const send = useCallback(async () => {
    if (!entry || !entry.url || !entry.modelName) {
      setError('Runner has no URL or model name — cannot chat.');
      return;
    }
    const text = input.trim();
    if (!text || streaming) return;

    const userBubble: Bubble = { role: 'user', content: text };
    const assistantBubble: Bubble = {
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const history: ChatMessage[] = [
      ...bubbles
        .filter((b) => !b.error)
        .map<ChatMessage>(({ role, content }) => ({ role, content })),
      { role: 'user', content: text },
    ];
    setBubbles((prev) => [...prev, userBubble, assistantBubble]);
    setInput('');
    setError(undefined);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const protocol = protocolForRunnerKind(entry.runnerKind);

    try {
      for await (const chunk of streamChat(entry.url, protocol, {
        model: entry.modelName,
        messages: history,
        signal: ctrl.signal,
      })) {
        if (chunk.delta) {
          setBubbles((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            const next = [...prev];
            next[next.length - 1] = {
              ...last,
              content: last.content + chunk.delta,
            };
            return next;
          });
        }
        if (chunk.done) break;
      }
    } catch (e) {
      const err = (e as Error).message;
      if ((e as Error).name !== 'AbortError') {
        setError(err);
        setBubbles((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const next = [...prev];
          next[next.length - 1] = { ...last, error: err, streaming: false };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      setBubbles((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant' || !last.streaming) return prev;
        const next = [...prev];
        next[next.length - 1] = { ...last, streaming: false };
        return next;
      });
      abortRef.current = undefined;
    }
  }, [entry, input, streaming, bubbles]);

  const onStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onReset = useCallback(() => {
    abortRef.current?.abort();
    setBubbles([]);
    setError(undefined);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  const onCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard access denied — silent */
    }
  }, []);

  const headerLabel = entry
    ? `${entry.runnerLabel ?? entry.runnerKind ?? 'runner'} · ${entry.modelName ?? ''}`
    : 'Chat';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="subtitle1"
              sx={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {headerLabel}
            </Typography>
            {entry?.url && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                {entry.url}
              </Typography>
            )}
          </Box>
          {bubbles.length > 0 && (
            <Tooltip title="Reset conversation">
              <IconButton size="small" onClick={onReset} disabled={streaming}>
                <RestartAltIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <IconButton size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{ p: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 320,
            maxHeight: '60vh',
            overflowY: 'auto',
            p: 2,
            backgroundColor: 'background.default',
          }}
        >
          {bubbles.length === 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', mt: 4 }}
            >
              Type a message below to start. Conversation isn't persisted —
              closing this dialog clears history.
            </Typography>
          )}
          {bubbles.map((b, i) => (
            <BubbleView key={i} bubble={b} onCopy={() => onCopy(b.content)} />
          ))}
          <div ref={scrollAnchorRef} />
        </Box>

        {error && (
          <Alert
            severity="error"
            onClose={() => setError(undefined)}
            sx={{ mx: 2, mt: 1 }}
          >
            {error}
          </Alert>
        )}

        <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              multiline
              minRows={1}
              maxRows={6}
              fullWidth
              size="small"
              placeholder={PLACEHOLDER}
              disabled={!entry?.url}
              slotProps={{
                input: { sx: { fontSize: '0.9em' } },
              }}
            />
            {streaming ? (
              <Tooltip title="Stop generation">
                <IconButton color="warning" onClick={onStop}>
                  <StopIcon />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Send (Enter)">
                <span>
                  <IconButton
                    color="primary"
                    onClick={send}
                    disabled={!input.trim() || !entry?.url}
                  >
                    <SendIcon />
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Stack>
        </Box>
      </DialogContent>
    </Dialog>
  );
}

function BubbleView({
  bubble,
  onCopy,
}: {
  bubble: Bubble;
  onCopy: () => void;
}): JSX.Element {
  const isUser = bubble.role === 'user';
  return (
    <Box
      sx={{
        my: 1,
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <Box
        sx={(theme) => ({
          maxWidth: '85%',
          minWidth: '20%',
          p: 1.25,
          borderRadius: 1.5,
          backgroundColor: isUser
            ? 'primary.main'
            : theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.06)'
              : 'rgba(0,0,0,0.04)',
          color: isUser ? 'primary.contrastText' : 'text.primary',
          fontSize: '0.9em',
          position: 'relative',
          '& p': { my: 0.5 },
          '& p:first-of-type': { mt: 0 },
          '& p:last-of-type': { mb: 0 },
          '& pre': {
            overflowX: 'auto',
            backgroundColor:
              theme.palette.mode === 'dark'
                ? 'rgba(0,0,0,0.4)'
                : 'rgba(0,0,0,0.05)',
            color: 'text.primary',
            p: 1,
            borderRadius: 0.5,
            fontSize: '0.85em',
          },
          '& code': {
            fontSize: '0.9em',
            backgroundColor:
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.1)'
                : 'rgba(0,0,0,0.07)',
            px: 0.5,
            borderRadius: 0.25,
          },
          '& pre code': { backgroundColor: 'transparent', p: 0 },
          '& a': { color: isUser ? 'inherit' : 'primary.main' },
          '& ul, & ol': { pl: 2.5, my: 0.5 },
          '& table': { borderCollapse: 'collapse', my: 0.5 },
          '& th, & td': {
            border: 1,
            borderColor: 'divider',
            px: 0.5,
            py: 0.25,
          },
        })}
      >
        {isUser ? (
          <Box sx={{ whiteSpace: 'pre-wrap' }}>{bubble.content}</Box>
        ) : (
          <>
            <Box
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(
                  bubble.content || (bubble.streaming ? '…' : ''),
                ).html,
              }}
            />
            {bubble.streaming && (
              <Box
                sx={{ display: 'inline-flex', ml: 0.5, alignItems: 'center' }}
              >
                <CircularProgress size={10} />
              </Box>
            )}
            {bubble.error && (
              <Typography
                variant="caption"
                color="error"
                sx={{ display: 'block', mt: 0.5 }}
              >
                {bubble.error}
              </Typography>
            )}
            {!isUser && !bubble.streaming && bubble.content && (
              <Tooltip title="Copy">
                <IconButton
                  size="small"
                  onClick={onCopy}
                  sx={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    opacity: 0.5,
                    '&:hover': { opacity: 1 },
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: 12 }} />
                </IconButton>
              </Tooltip>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
