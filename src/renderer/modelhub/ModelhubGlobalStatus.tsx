/**
 * Always-visible Models Hub control: shows the current location, lets the user
 * trigger bulk enrichment of all model files in that location, and renders
 * progress + summary feedback.
 *
 * Designed to fit in the left sidebar footer (replaces the upstream Pro teaser
 * banner). Compact when idle, expanded when a job is running.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RunningModelsPanel from './RunningModelsPanel';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useEditedTagLibraryContext } from '-/hooks/useEditedTagLibraryContext';
import { setTagLibrary } from '-/services/taglibrary-utils';
import {
  startBulkEnrichment,
  subscribeBulkEvents,
  BulkProgressEvent,
  BulkDoneEvent,
  BulkRun,
  BulkSummary,
  upsertModelhubTagGroup,
} from '-/modelhub';

interface BulkUiState {
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

const initial: BulkUiState = {
  active: false,
  processed: 0,
  total: 0,
  errors: 0,
};

export default function ModelhubGlobalStatus(): JSX.Element | null {
  const { currentLocation } = useCurrentLocationContext();
  const { createLocationIndex } = useLocationIndexContext();
  const { tagGroups, setTagGroups, reflectTagLibraryChanged } =
    useEditedTagLibraryContext();
  const [bulk, setBulk] = useState<BulkUiState>(initial);
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [reindexing, setReindexing] = useState(false);

  // Refs hold the latest closures so the (mount-once) subscription can
  // dispatch reindex against the *current* location, not the stale one.
  const locationRef = useRef(currentLocation);
  const reindexRef = useRef(createLocationIndex);
  const tagGroupsRef = useRef(tagGroups);
  const setTagGroupsRef = useRef(setTagGroups);
  const reflectRef = useRef(reflectTagLibraryChanged);
  /** Latest active flag, accessed from auto-trigger timer to avoid stale closures. */
  const bulkActiveRef = useRef(false);
  /** Accumulator for unique auto-tags collected across the current bulk run. */
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
        // Accumulate every auto-tag we see (from ok AND skipped — skipped
        // files surface their cached autoTags too in enrichFolder).
        if (e.lastAutoTags) {
          for (const t of e.lastAutoTags) collectedTagsRef.current.add(t);
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
            `Done — ${s.ok} enriched, ${s.skipped} skipped, ${s.errors} errors`,
          );
          // Sync collected auto-tags into a "Models Hub (auto)" tag group so
          // they show up in the search autocomplete + Tag Library panel.
          // Empty set → the group is removed entirely (clean-up).
          const collected = Array.from(collectedTagsRef.current).sort();
          const currentGroups = tagGroupsRef.current ?? [];
          const nextGroups = upsertModelhubTagGroup(currentGroups, collected);
          if (setTagGroupsRef.current) setTagGroupsRef.current(nextGroups);
          setTagLibrary(nextGroups);
          if (reflectRef.current) reflectRef.current();
          // After any bulk run, force-reindex so the indexer picks up the
          // sidecars (newly enriched OR already-cached). Reindex is cheap and
          // it's the only way `arch:llama` etc. become searchable. Skip only
          // when literally nothing was processed (empty folder).
          const loc = locationRef.current;
          const reindex = reindexRef.current;
          if (loc && s.processed > 0 && reindex) {
            setReindexing(true);
            reindex(loc, true)
              .then(() => {
                setReindexing(false);
                setInfo(
                  `Done — ${s.ok} enriched, ${s.skipped} skipped, ${s.errors} errors • search index refreshed`,
                );
              })
              .catch((e) => {
                setReindexing(false);
                setError(`Reindex failed: ${(e as Error).message}`);
              });
          }
        } else if (e.error) {
          setError(`Bulk failed: ${e.error}`);
        }
      },
    );
    return unsubscribe;
  }, []);

  const onStart = useCallback(
    async (mode: 'local' | 'hf') => {
      const path = currentLocation?.path;
      if (!path || bulk.active) return;
      setError(undefined);
      setInfo(undefined);
      // Reset accumulator so each run produces a fresh, location-scoped tag list.
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

  /**
   * Auto-run a local-mode Parse All when the user opens a location, once per
   * location per session. The 7-day freshness cache makes this near-free for
   * already-enriched files (just a stat + sidecar read), and any newly added
   * model file gets parsed without the user having to click anything.
   *
   * `local` only: HF enrichment hits the network and is opt-in.
   */
  const autoRunLocationsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const path = currentLocation?.path;
    if (!path) return;
    if (autoRunLocationsRef.current.has(path)) return;
    autoRunLocationsRef.current.add(path);

    // Small delay so the location finishes loading and the user isn't hit by
    // an immediate progress bar while still navigating.
    const timer = setTimeout(() => {
      if (locationRef.current?.path !== path) return; // user navigated away
      // Re-check active flag at fire time (state may have changed).
      if (bulkActiveRef.current) return;
      onStart('local');
    }, 600);

    return () => clearTimeout(timer);
    // We only want this triggered by location changes, not by onStart identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation?.path]);

  const onCancel = useCallback(async () => {
    if (bulk.cancelHandle) {
      await bulk.cancelHandle.cancel();
    }
  }, [bulk.cancelHandle]);

  const dismissInfo = useCallback(() => {
    setInfo(undefined);
    setError(undefined);
  }, []);

  if (!currentLocation) {
    return (
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          Models Hub — open a location to enrich models
        </Typography>
      </Box>
    );
  }

  const fileName = bulk.currentFile?.replace(/^.*[\\/]/, '');
  const percent =
    bulk.total > 0 ? Math.round((bulk.processed / bulk.total) * 100) : 0;

  return (
    <Box
      data-tid="modelhubGlobalStatus"
      sx={{
        px: 1.5,
        py: 1,
        borderTop: 1,
        borderColor: 'divider',
        backgroundColor: 'background.default',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: bulk.active || info || error ? 0.5 : 0 }}
      >
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <AutoAwesomeIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography variant="caption" sx={{ fontWeight: 500 }}>
            Models Hub
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.5}>
          {!bulk.active && (
            <>
              <Tooltip title="Parse all model headers in this location (offline)">
                <Button
                  size="small"
                  variant="outlined"
                  sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: '0.7em' }}
                  onClick={() => onStart('local')}
                >
                  Parse all
                </Button>
              </Tooltip>
              <Tooltip title="Enrich all models with Hugging Face data (network)">
                <Button
                  size="small"
                  variant="text"
                  sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: '0.7em' }}
                  onClick={() => onStart('hf')}
                >
                  HF
                </Button>
              </Tooltip>
            </>
          )}
          {bulk.active && (
            <Button
              size="small"
              variant="text"
              color="warning"
              sx={{ minWidth: 0, px: 1, py: 0.25, fontSize: '0.7em' }}
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
        </Stack>
      </Stack>

      {bulk.active && (
        <Box>
          <LinearProgress
            variant={bulk.total > 0 ? 'determinate' : 'indeterminate'}
            value={percent}
            sx={{ height: 4, borderRadius: 2, mb: 0.25 }}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontSize: '0.7em', display: 'block', lineHeight: 1.2 }}
          >
            {bulk.processed}/{bulk.total} •{' '}
            {bulk.mode === 'hf' ? 'HF' : 'local'}
            {bulk.errors > 0 && ` • ${bulk.errors} err`}
            {fileName && (
              <Box
                component="span"
                sx={{
                  display: 'block',
                  fontFamily: 'monospace',
                  fontSize: '0.95em',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  opacity: 0.8,
                }}
              >
                {fileName}
              </Box>
            )}
          </Typography>
        </Box>
      )}

      {!bulk.active && reindexing && (
        <Box>
          <LinearProgress sx={{ height: 4, borderRadius: 2, mb: 0.25 }} />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontSize: '0.7em' }}
          >
            Refreshing search index…
          </Typography>
        </Box>
      )}

      {!bulk.active && !reindexing && (info || error) && (
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
        >
          <Typography
            variant="caption"
            color={error ? 'error' : 'success.main'}
            sx={{ fontSize: '0.7em', flex: 1, mr: 0.5 }}
          >
            {error ?? info}
          </Typography>
          <IconButton size="small" sx={{ p: 0.25 }} onClick={dismissInfo}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Stack>
      )}

      {/* Persistent list of currently active runners. The panel hides
          itself when nothing is running so the sidebar stays compact. */}
      <RunningModelsPanel />
    </Box>
  );
}
