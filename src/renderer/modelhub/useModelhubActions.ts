/**
 * Shared hook for per-file Models Hub actions. Lets the action buttons
 * live next to the surface they affect — "Generate tags" near the tags
 * chips, "Fetch from HF" near the HF encart — without duplicating the
 * IPC plumbing at every call site.
 *
 * Each consumer gets its own busy/error/info state (local feedback near
 * the button that was clicked). The underlying sidecar is shared across
 * components, so a parseHeader from Properties is immediately visible
 * to the HF encart in Description after `reloadOpenedFile`.
 */

import { useCallback, useState } from 'react';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import {
  enrichModelMeta,
  enrichModelMetaHf,
  patchModelMeta,
} from './useModelMeta';
import { isAutoTag } from './autoTags';

export type ModelhubBusy =
  | 'idle'
  | 'parse'
  | 'hf'
  | 'resetTags'
  | 'resetHf'
  | 'regenerate';

export interface UseModelhubActionsState {
  busy: ModelhubBusy;
  error?: string;
  info?: string;
  parseHeader: () => Promise<void>;
  fetchHf: () => Promise<void>;
  resetTags: () => Promise<void>;
  resetHf: () => Promise<void>;
  /**
   * One-shot "clear + regenerate" for the system/auto tags surface.
   * Calls resetTags then parseHeader so the file ends up with a fresh
   * set of header-derived tags (and HF-cached ones if available).
   */
  regenerateTags: () => Promise<void>;
  dismissFeedback: () => void;
}

export interface UseModelhubActionsOptions {
  filePath?: string;
  readOnly?: boolean;
}

export function useModelhubActions({
  filePath,
  readOnly,
}: UseModelhubActionsOptions): UseModelhubActionsState {
  const { openedEntry, reloadOpenedFile } = useOpenedEntryContext();
  const { removeTagsFromEntry } = useTaggingActionsContext();
  const [busy, setBusy] = useState<ModelhubBusy>('idle');
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();

  const dismissFeedback = useCallback(() => {
    setError(undefined);
    setInfo(undefined);
  }, []);

  const parseHeader = useCallback(async () => {
    if (!filePath) return;
    setBusy('parse');
    setError(undefined);
    setInfo(undefined);
    try {
      const result = await enrichModelMeta(filePath, {
        skipWrite: !!readOnly,
      });
      if (result.ok) {
        setInfo(
          result.written
            ? `${(result.autoTags ?? []).length} system tag(s) generated.`
            : 'Computed in memory (read-only / skipWrite).',
        );
        if (result.written) {
          try {
            await reloadOpenedFile();
          } catch {
            /* non-fatal */
          }
        }
      } else {
        setError(result.error ?? 'parse failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  const fetchHf = useCallback(async () => {
    if (!filePath) return;
    setBusy('hf');
    setError(undefined);
    setInfo(undefined);
    try {
      const result = await enrichModelMetaHf(filePath, {
        skipWrite: !!readOnly,
      });
      if (result.ok && result.modelMeta) {
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
        setError(result.error ?? 'HF fetch failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  const resetTags = useCallback(async () => {
    if (!openedEntry || readOnly) return;
    setBusy('resetTags');
    setError(undefined);
    setInfo(undefined);
    try {
      const sysTags = (openedEntry.tags ?? []).filter(
        (t) => t.system === true || isAutoTag(t.title ?? ''),
      );
      if (sysTags.length === 0) {
        setInfo('No system tags to reset.');
        return;
      }
      await removeTagsFromEntry(openedEntry, sysTags);
      try {
        await reloadOpenedFile();
      } catch {
        /* non-fatal */
      }
      setInfo(`Removed ${sysTags.length} system tag(s).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [openedEntry, readOnly, removeTagsFromEntry, reloadOpenedFile]);

  const resetHf = useCallback(async () => {
    if (!filePath || readOnly) return;
    setBusy('resetHf');
    setError(undefined);
    setInfo(undefined);
    try {
      // Drop the huggingface block from modelMeta. JSON.stringify omits
      // `undefined`-valued keys, so writing the patch back removes the
      // field from disk. The encart in Description disappears on the
      // next render once `reloadOpenedFile` refreshes the sidecar cache.
      const result = await patchModelMeta(filePath, {
        huggingface: undefined,
      });
      if (result.ok) {
        try {
          await reloadOpenedFile();
        } catch {
          /* non-fatal */
        }
        setInfo('Hugging Face data removed.');
      } else {
        setError(result.error ?? 'reset failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  const regenerateTags = useCallback(async () => {
    if (!filePath || !openedEntry) return;
    setBusy('regenerate');
    setError(undefined);
    setInfo(undefined);
    try {
      // Step 1: drop existing system tags (if any). Skipped silently when
      // there are none — keeps the UX symmetric whether or not the file
      // had been tagged previously.
      const sysTags = (openedEntry.tags ?? []).filter(
        (t) => t.system === true || isAutoTag(t.title ?? ''),
      );
      if (sysTags.length > 0 && !readOnly) {
        await removeTagsFromEntry(openedEntry, sysTags);
      }
      // Step 2: full HF refresh — re-reads the header off disk, fetches
      // Hugging Face metadata (network), and rebuilds the entire tag
      // set via `computeAutoTags({ header, huggingface, folderSegments })`.
      // Mirrors the bulk "Tout taguer" button's semantics so the per-file
      // and per-folder actions stay in sync.
      const result = await enrichModelMetaHf(filePath, {
        skipWrite: !!readOnly,
      });
      if (!result.ok) {
        setError(result.error ?? 'regenerate failed');
        return;
      }
      try {
        await reloadOpenedFile();
      } catch {
        /* non-fatal */
      }
      const generated = (result.autoTags ?? []).length;
      const cleared = sysTags.length;
      setInfo(
        result.written
          ? `${cleared} cleared, ${generated} regenerated.`
          : `Computed in memory (read-only / skipWrite).`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, openedEntry, readOnly, removeTagsFromEntry, reloadOpenedFile]);

  return {
    busy,
    error,
    info,
    parseHeader,
    fetchHf,
    resetTags,
    resetHf,
    regenerateTags,
    dismissFeedback,
  };
}
