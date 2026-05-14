/**
 * Owner of the bulk-enrichment state machine for the current location.
 *
 * Was previously embedded in `ModelhubGlobalStatus` (a sidebar widget).
 * Lifted into a context so the visible UI can live in `Settings ▸ IA`
 * while the auto-parse-on-location-open trigger keeps firing regardless
 * of whether the settings dialog is open. Mounted in `Root.tsx`'s
 * SHARED_PROVIDERS so the lifecycle matches the app's.
 *
 * Responsibilities:
 *  - hold transient state for an in-flight bulk run (progress / errors)
 *  - subscribe to `subscribeBulkEvents` to update that state
 *  - auto-fire a `local`-mode Parse All when the user navigates to a
 *    new location (once per location per session)
 *  - expose `start(mode)`, `cancel()`, `clearAll()` actions
 *  - own the post-run side effects (cache invalidation, tag-group sync,
 *    reindex) — kept here so any consumer triggering an action gets the
 *    same downstream behaviour
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useEditedTagLibraryContext } from '-/hooks/useEditedTagLibraryContext';
import { setTagLibrary } from '-/services/taglibrary-utils';
import {
  BulkDoneEvent,
  BulkProgressEvent,
  BulkRun,
  BulkSummary,
  _clearModelMetaCache,
  clearFolderBulk,
  startBulkEnrichment,
  subscribeBulkEvents,
  upsertModelhubTagGroup,
} from '-/modelhub';

export interface BulkUiState {
  active: boolean;
  runId?: string;
  mode?: 'local' | 'hf';
  processed: number;
  total: number;
  currentFile?: string;
  errors: number;
  summary?: BulkSummary;
  cancelHandle?: BulkRun;
  rootDir?: string;
}

export interface BulkEnrichmentContextValue {
  bulk: BulkUiState;
  reindexing: boolean;
  info?: string;
  error?: string;
  /** True when there's no usable currentLocation to act on. */
  noLocation: boolean;
  start: (mode: 'local' | 'hf') => Promise<void>;
  cancel: () => Promise<void>;
  clearAll: () => Promise<void>;
  dismissMessage: () => void;
}

const initial: BulkUiState = {
  active: false,
  processed: 0,
  total: 0,
  errors: 0,
};

const BulkEnrichmentContext = createContext<
  BulkEnrichmentContextValue | undefined
>(undefined);

export const BulkEnrichmentContextProvider: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const { t } = useTranslation();
  const { currentLocation } = useCurrentLocationContext();
  const { createLocationIndex } = useLocationIndexContext();
  const { tagGroups, setTagGroups, reflectTagLibraryChanged } =
    useEditedTagLibraryContext();
  const [bulk, setBulk] = useState<BulkUiState>(initial);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [reindexing, setReindexing] = useState(false);

  const locationRef = useRef(currentLocation);
  const reindexRef = useRef(createLocationIndex);
  const tagGroupsRef = useRef(tagGroups);
  const setTagGroupsRef = useRef(setTagGroups);
  const reflectRef = useRef(reflectTagLibraryChanged);
  const bulkActiveRef = useRef(false);
  const collectedTagsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    locationRef.current = currentLocation;
    reindexRef.current = createLocationIndex;
    tagGroupsRef.current = tagGroups;
    setTagGroupsRef.current = setTagGroups;
    reflectRef.current = reflectTagLibraryChanged;
  }, [
    currentLocation,
    createLocationIndex,
    tagGroups,
    setTagGroups,
    reflectTagLibraryChanged,
  ]);
  useEffect(() => {
    bulkActiveRef.current = bulk.active;
  }, [bulk.active]);

  // Subscribe once to bulk events
  useEffect(() => {
    const unsubscribe = subscribeBulkEvents(
      (e: BulkProgressEvent) => {
        if (e.lastAutoTags) {
          for (const tag of e.lastAutoTags) collectedTagsRef.current.add(tag);
        }
        setBulk((prev) =>
          prev.runId === e.runId
            ? {
                ...prev,
                processed: e.processed,
                total: e.total,
                currentFile: e.currentFile,
                errors:
                  e.lastStatus === 'error' ? prev.errors + 1 : prev.errors,
              }
            : prev,
        );
      },
      (e: BulkDoneEvent) => {
        setBulk((prev) =>
          prev.runId === e.runId
            ? {
                ...prev,
                active: false,
                summary: e.summary,
                cancelHandle: undefined,
              }
            : prev,
        );
        if (e.summary) {
          const s = e.summary;
          setInfo(
            t('core:mhBulkDone', {
              ok: s.ok,
              skipped: s.skipped,
              errors: s.errors,
            }),
          );
          _clearModelMetaCache();

          const collected = Array.from(collectedTagsRef.current).sort();
          const currentGroups = tagGroupsRef.current ?? [];
          const nextGroups = upsertModelhubTagGroup(currentGroups, collected);
          if (setTagGroupsRef.current) setTagGroupsRef.current(nextGroups);
          setTagLibrary(nextGroups);
          if (reflectRef.current) reflectRef.current();

          const loc = locationRef.current;
          const reindex = reindexRef.current;
          if (loc && s.processed > 0 && reindex) {
            setReindexing(true);
            reindex(loc, true)
              .then(() => {
                setReindexing(false);
                setInfo(
                  t('core:mhBulkDoneWithReindex', {
                    ok: s.ok,
                    skipped: s.skipped,
                    errors: s.errors,
                  }),
                );
              })
              .catch((err) => {
                setReindexing(false);
                setError(
                  t('core:mhBulkReindexFailed', {
                    err: (err as Error).message,
                  }),
                );
              });
          }
        } else if (e.error) {
          setError(t('core:mhBulkFailed', { err: e.error }));
        }
      },
    );
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(
    async (mode: 'local' | 'hf') => {
      const path = currentLocation?.path;
      if (!path || bulk.active) return;
      setError(undefined);
      setInfo(undefined);
      collectedTagsRef.current = new Set();
      const result = await startBulkEnrichment(path, {
        mode,
        skipWrite: !!currentLocation?.isReadOnly,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setBulk({
        active: true,
        runId: result.runId,
        mode,
        processed: 0,
        total: 0,
        errors: 0,
        cancelHandle: result,
        rootDir: path,
      });
    },
    [currentLocation, bulk.active],
  );

  // Auto-parse on location open (once per location per session).
  const autoRunLocationsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const path = currentLocation?.path;
    if (!path) return;
    if (autoRunLocationsRef.current.has(path)) return;
    autoRunLocationsRef.current.add(path);
    const timer = setTimeout(() => {
      if (locationRef.current?.path !== path) return;
      if (bulkActiveRef.current) return;
      start('local');
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation?.path]);

  const cancel = useCallback(async () => {
    if (bulk.cancelHandle) {
      await bulk.cancelHandle.cancel();
    }
  }, [bulk.cancelHandle]);

  const clearAll = useCallback(async () => {
    const path = currentLocation?.path;
    if (!path || bulk.active || reindexing) return;
    if (!window.confirm(t('core:mhBulkClearConfirm'))) {
      return;
    }
    setError(undefined);
    setInfo(undefined);
    const result = await clearFolderBulk(path);
    if (!result.ok) {
      setError(result.error ?? 'clear failed');
      return;
    }
    _clearModelMetaCache();
    setInfo(
      t('core:mhBulkClearDone', {
        cleared: result.cleared ?? 0,
        skipped: result.skipped ?? 0,
        errors: result.errors ?? 0,
      }),
    );
  }, [currentLocation, bulk.active, reindexing, t]);

  const dismissMessage = useCallback(() => {
    setInfo(undefined);
    setError(undefined);
  }, []);

  const value = useMemo<BulkEnrichmentContextValue>(
    () => ({
      bulk,
      reindexing,
      info,
      error,
      noLocation: !currentLocation,
      start,
      cancel,
      clearAll,
      dismissMessage,
    }),
    [
      bulk,
      reindexing,
      info,
      error,
      currentLocation,
      start,
      cancel,
      clearAll,
      dismissMessage,
    ],
  );

  return (
    <BulkEnrichmentContext.Provider value={value}>
      {children}
    </BulkEnrichmentContext.Provider>
  );
};

export const useBulkEnrichment = (): BulkEnrichmentContextValue => {
  const ctx = useContext(BulkEnrichmentContext);
  if (!ctx) {
    throw new Error(
      'useBulkEnrichment must be used within BulkEnrichmentContextProvider',
    );
  }
  return ctx;
};
