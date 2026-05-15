/**
 * Shared hook for per-file Models Hub actions. Lets the action buttons
 * live next to the surface they affect (e.g. "Generate tags" near the
 * tags chips) without duplicating the IPC plumbing at every call site.
 *
 * Each consumer gets its own busy/error/info state (local feedback near
 * the button that was clicked). The underlying sidecar is shared across
 * components, so a parseHeader from Properties is visible elsewhere
 * after `reloadOpenedFile`.
 */

import { useCallback, useState } from 'react';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { enrichModelMeta } from './useModelMeta';
import { isAutoTag } from './autoTags';

export type ModelhubBusy = 'idle' | 'parse' | 'resetTags' | 'regenerate';

export interface UseModelhubActionsState {
  busy: ModelhubBusy;
  error?: string;
  info?: string;
  parseHeader: () => Promise<void>;
  resetTags: () => Promise<void>;
  /**
   * One-shot "clear + regenerate" for the system/auto tags surface.
   * Calls resetTags then parseHeader so the file ends up with a fresh
   * set of header-derived tags.
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

  const regenerateTags = useCallback(async () => {
    if (!filePath || !openedEntry) return;
    setBusy('regenerate');
    setError(undefined);
    setInfo(undefined);
    try {
      // Step 1: drop existing system tags (if any).
      const sysTags = (openedEntry.tags ?? []).filter(
        (t) => t.system === true || isAutoTag(t.title ?? ''),
      );
      if (sysTags.length > 0 && !readOnly) {
        await removeTagsFromEntry(openedEntry, sysTags);
      }
      // Step 2: re-parse the header and rebuild tags from
      // `computeAutoTags({ header, folderSegments })`.
      const result = await enrichModelMeta(filePath, {
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
    resetTags,
    regenerateTags,
    dismissFeedback,
  };
}
