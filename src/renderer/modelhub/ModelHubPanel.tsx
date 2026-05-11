/**
 * Side-panel section displayed inside EntryProperties for model files.
 * Renders parsed header info, auto-tags, and HF enrichment status, with
 * action buttons to trigger local + HF enrichment.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import { isSupportedModelFile } from './parsers';
import {
  enrichModelMeta,
  enrichModelMetaHf,
  fetchModelMeta,
} from './useModelMeta';
import { ModelMeta } from './types';
import RunModelButton from './runners/RunModelButton';
import { canonicalShardName, detectShardInfo, isCanonicalShard } from './shard';
import RunParamsEditor from './RunParamsEditor';
import { isAutoTag } from './autoTags';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

interface Props {
  filePath?: string;
  /** When true, sidecar writes are skipped (read-only location). */
  readOnly?: boolean;
}

// HeaderBlock + HfBlock used to live here. The header info has been
// promoted to native Properties variables (EntryProperties.tsx), and the
// HF block has moved to the Description tab (EditDescription.tsx) — both
// surfaces are more discoverable for users than a side-panel sub-block.

export function ModelHubPanel({
  filePath,
  readOnly,
}: Props): JSX.Element | null {
  const [meta, setMeta] = useState<ModelMeta | undefined>();
  const [busy, setBusy] = useState<'idle' | 'local' | 'hf' | 'clear'>('idle');
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();

  const supported = !!filePath && isSupportedModelFile(filePath);

  useEffect(() => {
    let cancelled = false;
    setMeta(undefined);
    setError(undefined);
    setInfo(undefined);
    if (!supported || !filePath) return;
    fetchModelMeta(filePath)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message ?? 'load failed');
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, supported]);

  const { openedEntry, reloadOpenedFile } = useOpenedEntryContext();
  const { setDescriptionChange } = useIOActionsContext();
  const { removeTagsFromEntry } = useTaggingActionsContext();

  const onEnrichLocal = useCallback(async () => {
    if (!filePath) return;
    setBusy('local');
    setError(undefined);
    setInfo(undefined);
    try {
      const result = await enrichModelMeta(filePath, { skipWrite: !!readOnly });
      if (result.ok && result.modelMeta) {
        setMeta(result.modelMeta);
        setInfo(
          result.written
            ? 'Sidecar updated with header + auto-tags.'
            : 'Computed in memory (read-only or skipWrite).',
        );
        // Refresh `openedEntry` from disk so the standard TagSpaces tag
        // area picks up the new system tags written to the sidecar.
        // Without this, the panel state updates but the tags above the
        // panel stay stuck on the pre-write snapshot — that's how the
        // user kept seeing duplicates after Parse Header.
        if (result.written) {
          try {
            await reloadOpenedFile();
          } catch {
            /* non-fatal */
          }
        }
      } else {
        setError(result.error ?? 'enrich failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  const onEnrichHf = useCallback(async () => {
    if (!filePath) return;
    setBusy('hf');
    setError(undefined);
    setInfo(undefined);
    try {
      const result = await enrichModelMetaHf(filePath, {
        skipWrite: !!readOnly,
      });
      if (result.ok && result.modelMeta) {
        setMeta(result.modelMeta);
        const cached = result.fromCache ? ' (cached)' : '';
        setInfo(
          `Matched ${result.matchedRepo}${cached}.${
            result.written ? ' Sidecar updated.' : ''
          }`,
        );
        if (result.written) {
          try {
            await reloadOpenedFile();
          } catch {
            /* non-fatal */
          }
        }
      } else {
        setError(result.error ?? 'HF enrich failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  // Reset button: nukes the auto-populated content for this one file —
  // clears the description and removes every system / auto-namespaced
  // tag. User-typed tags survive. Lets the user roll back a bad enrichment
  // without manually deleting each tag and selecting-all in the editor.
  const onClearAll = useCallback(async () => {
    if (!openedEntry || readOnly) return;
    if (
      !window.confirm(
        'Vider la description et supprimer les tags système pour ce fichier ?',
      )
    ) {
      return;
    }
    setBusy('clear');
    setError(undefined);
    setInfo(undefined);
    try {
      if (openedEntry.meta?.description) {
        await setDescriptionChange(openedEntry, '');
      }
      const sysTags = (openedEntry.tags ?? []).filter(
        (t) => t.system === true || isAutoTag(t.title ?? ''),
      );
      if (sysTags.length > 0) {
        await removeTagsFromEntry(openedEntry, sysTags);
      }
      try {
        await reloadOpenedFile();
      } catch {
        /* non-fatal */
      }
      setInfo(
        `Cleared description${
          sysTags.length > 0 ? ` + ${sysTags.length} system tag(s)` : ''
        }.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [
    openedEntry,
    readOnly,
    setDescriptionChange,
    removeTagsFromEntry,
    reloadOpenedFile,
  ]);

  if (!supported) return null;

  // When the user opens a non-canonical shard (e.g. shard 7/12), surface a
  // pointer to the canonical entry so they understand why the metadata + Run
  // button are tied to a different file. We don't auto-navigate — the
  // location/file manager is the user's, not ours to pilot.
  const fileBase = filePath ? basename(filePath) : '';
  const nonCanonical =
    !!fileBase && !!detectShardInfo(fileBase) && !isCanonicalShard(fileBase);
  const canonicalSibling = nonCanonical ? canonicalShardName(fileBase) : '';

  const header = meta?.header;
  const hf = meta?.huggingface;

  return (
    <Box
      data-tid="modelhubPanel"
      sx={{
        mt: 2,
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1 }}
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="subtitle1">Models Hub</Typography>
        {nonCanonical && (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ width: '100%', display: 'block', mt: -0.5 }}
          >
            This is a non-canonical shard. Metadata + Run apply to the canonical
            sibling: <code>{canonicalSibling}</code>.
          </Typography>
        )}
        <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
          {filePath && <RunModelButton filePath={filePath} />}
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== 'idle'}
            onClick={onEnrichLocal}
            startIcon={
              busy === 'local' ? <CircularProgress size={14} /> : undefined
            }
          >
            Parse header
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== 'idle'}
            onClick={onEnrichHf}
            startIcon={
              busy === 'hf' ? <CircularProgress size={14} /> : undefined
            }
          >
            Fetch from HF
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="warning"
            disabled={busy !== 'idle' || readOnly}
            onClick={onClearAll}
            startIcon={
              busy === 'clear' ? <CircularProgress size={14} /> : undefined
            }
          >
            Clear
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Typography
          variant="caption"
          color="error"
          sx={{ display: 'block', mb: 1 }}
        >
          {error}
        </Typography>
      )}
      {info && (
        <Typography
          variant="caption"
          color="success.main"
          sx={{ display: 'block', mb: 1 }}
        >
          {info}
        </Typography>
      )}

      {!header && !hf && busy === 'idle' && (
        <Typography variant="body2" color="text.secondary">
          No metadata yet. Click <strong>Parse header</strong> for instant
          offline metadata, or <strong>Fetch from HF</strong> to enrich with
          Hugging Face description, license, and dates.
        </Typography>
      )}

      <Stack spacing={1.5}>
        {filePath && (
          <RunParamsEditor
            filePath={filePath}
            initialUserParams={meta?.userRunParams}
            onSaved={(next) =>
              setMeta((prev) =>
                prev ? { ...prev, userRunParams: next } : prev,
              )
            }
          />
        )}
      </Stack>
    </Box>
  );
}

export default ModelHubPanel;
