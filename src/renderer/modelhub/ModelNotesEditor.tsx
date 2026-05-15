/**
 * Per-model note-taking widget.
 *
 * Storage: `modelMeta.userNotes` in the sidecar. Persists across moves
 * because the sidecar travels with the file.
 *
 * UX:
 *  - Default tab: textarea (markdown source). Save-on-blur + 1.5s debounce
 *    so a long note isn't lost if the user clicks away mid-thought.
 *  - Preview tab: rendered markdown via `renderMarkdown` (same sanitizer
 *    as the HF description block, no repo binding).
 *  - "Saved" / "Saving…" indicator. Errors surface inline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { patchModelMeta } from './useModelMeta';

/**
 * Render user notes markdown to sanitized HTML. Same `marked` + `DOMPurify`
 * pipeline as `convertMarkDownToHtml` in services/utils-io.ts, minus the
 * full-document wrapper.
 */
function renderNotesMarkdown(md: string): string {
  marked.setOptions({ pedantic: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(marked.parse(md ?? '') as string);
}

interface Props {
  filePath: string;
  initialNotes?: string;
  /**
   * Called after a successful save with the new note text. Lets the parent
   * keep its own snapshot of `modelMeta` in sync so reopening the file
   * shows the latest content.
   */
  onSaved?: (notes: string) => void;
}

type Mode = 'edit' | 'preview';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_DEBOUNCE_MS = 1500;

export default function ModelNotesEditor({
  filePath,
  initialNotes,
  onSaved,
}: Props): JSX.Element {
  const [text, setText] = useState<string>(initialNotes ?? '');
  const [mode, setMode] = useState<Mode>('edit');
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | undefined>();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  /** Prevents stale debounced saves from clobbering after a file switch. */
  const filePathRef = useRef(filePath);
  /** The last value we successfully persisted — avoids redundant writes. */
  const lastSavedRef = useRef<string>(initialNotes ?? '');

  // When the user navigates to a different file, hydrate from the new
  // initialNotes and cancel any pending debounce for the previous file.
  useEffect(() => {
    filePathRef.current = filePath;
    setText(initialNotes ?? '');
    lastSavedRef.current = initialNotes ?? '';
    setSave('idle');
    setError(undefined);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
  }, [filePath, initialNotes]);

  const persist = useCallback(
    async (value: string) => {
      if (value === lastSavedRef.current) {
        setSave('idle');
        return;
      }
      const target = filePathRef.current;
      setSave('saving');
      setError(undefined);
      try {
        const r = await patchModelMeta(target, {
          userNotes: value,
          userNotesUpdatedAt: new Date().toISOString(),
        });
        // If the user navigated away mid-save, drop the response on the floor.
        if (filePathRef.current !== target) return;
        if (!r.ok) {
          setSave('error');
          setError(r.error ?? 'save failed');
          return;
        }
        lastSavedRef.current = value;
        setSave('saved');
        onSaved?.(value);
        // Drop the "saved" pill back to idle after a beat.
        setTimeout(() => {
          if (filePathRef.current === target) setSave('idle');
        }, 1500);
      } catch (e) {
        setSave('error');
        setError((e as Error).message);
      }
    },
    [onSaved],
  );

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = e.target.value;
      setText(next);
      // Reset the debounce window each keystroke.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        persist(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  const onBlur = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    persist(text);
  }, [persist, text]);

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 0.5 }}
      >
        <Typography variant="subtitle2">Notes</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {save === 'saving' && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <CircularProgress size={10} />
              <Typography variant="caption" color="text.secondary">
                Saving…
              </Typography>
            </Stack>
          )}
          {save === 'saved' && (
            <Typography variant="caption" color="success.main">
              Saved
            </Typography>
          )}
          {save === 'error' && (
            <Typography variant="caption" color="error">
              {error ?? 'save failed'}
            </Typography>
          )}
          <ButtonGroup size="small" variant="outlined">
            <Button
              onClick={() => setMode('edit')}
              variant={mode === 'edit' ? 'contained' : 'outlined'}
              sx={{ minWidth: 0, px: 1, py: 0, fontSize: '0.7em' }}
            >
              Edit
            </Button>
            <Button
              onClick={() => setMode('preview')}
              variant={mode === 'preview' ? 'contained' : 'outlined'}
              sx={{ minWidth: 0, px: 1, py: 0, fontSize: '0.7em' }}
              disabled={!text.trim()}
            >
              Preview
            </Button>
          </ButtonGroup>
        </Stack>
      </Stack>

      {mode === 'edit' ? (
        <TextField
          value={text}
          onChange={onChange}
          onBlur={onBlur}
          multiline
          minRows={4}
          maxRows={14}
          fullWidth
          size="small"
          placeholder="Notes about this model — observations, prompts that work well, settings to revisit, links… Markdown supported."
          slotProps={{
            input: {
              sx: { fontSize: '0.85em', fontFamily: 'monospace' },
            },
          }}
        />
      ) : (
        <Box
          sx={(theme) => ({
            maxHeight: 280,
            overflow: 'auto',
            fontSize: '0.85em',
            backgroundColor: 'action.hover',
            color: 'text.primary',
            borderRadius: 1,
            p: 1,
            '& img': { maxWidth: '100%', height: 'auto' },
            '& pre': {
              overflowX: 'auto',
              fontSize: '0.85em',
              backgroundColor:
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(0,0,0,0.04)',
              color: 'text.primary',
              p: 0.75,
              borderRadius: 0.5,
            },
            '& code': {
              fontSize: '0.9em',
              backgroundColor:
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.08)'
                  : 'rgba(0,0,0,0.05)',
              px: 0.5,
              borderRadius: 0.25,
            },
            '& pre code': { backgroundColor: 'transparent', p: 0 },
            '& a': { color: 'primary.main', textDecoration: 'underline' },
            '& h1, & h2, & h3, & h4': {
              mt: 1,
              mb: 0.5,
              fontSize: '1em',
              fontWeight: 600,
              color: 'text.primary',
            },
            '& p': { my: 0.5, color: 'text.primary' },
            '& ul, & ol': { pl: 2.5, my: 0.5 },
            '& blockquote': {
              borderLeft: 3,
              borderColor: 'divider',
              pl: 1,
              ml: 0,
              color: 'text.secondary',
            },
          })}
          dangerouslySetInnerHTML={{ __html: renderNotesMarkdown(text) }}
        />
      )}
    </Box>
  );
}
