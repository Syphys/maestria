/**
 * Renderer hook: load + enrich the modelhub sidecar for a file.
 *
 * Two modes:
 *   - useModelMeta(path): read-only — fetches the cached `modelMeta` from sidecar.
 *   - enrichModelMeta(path, opts): triggers the full enrichment pipeline
 *     (parse header + auto-tags + write sidecar).
 *
 * Cache is keyed by absolute file path. Invalidate by calling enrichModelMeta
 * (which re-reads + re-computes).
 */

import { useEffect, useRef, useState } from 'react';
import { ModelMeta, MODELHUB_IPC } from './types';
import { isSupportedModelFile } from './parsers';

export interface UseModelMetaState {
  loading: boolean;
  modelMeta?: ModelMeta;
  error?: string;
}

interface LoadResponse {
  ok: boolean;
  modelMeta?: ModelMeta;
  error?: string;
}

interface EnrichResponse {
  ok: boolean;
  modelMeta?: ModelMeta;
  autoTags?: string[];
  sidecarPath?: string;
  written?: boolean;
  error?: string;
}

interface EnrichHfResponse extends EnrichResponse {
  matchedRepo?: string;
  matchedFromCandidate?: { repo: string; source: string; confidence: string };
  triedCandidates?: Array<{ repo: string; source: string; confidence: string }>;
  fromCache?: boolean;
}

export interface EnrichHfClientOptions {
  apiToken?: string;
  skipWrite?: boolean;
  force?: boolean;
}

const cache = new Map<string, ModelMeta | { _error: string }>();
const inflight = new Map<string, Promise<LoadResponse>>();

// `window.electronIO` is declared globally in `src/renderer/preload.d.ts`.
// Locally we treat it as a loose ipcRenderer to keep channel names typed
// as plain strings for the modelhub IPC.
type IpcLite = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on?: (channel: string, listener: (...args: unknown[]) => void) => () => void;
};
function getIpc(): IpcLite | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.electronIO?.ipcRenderer as unknown as IpcLite | undefined;
}

function ipcAvailable(): boolean {
  return !!getIpc()?.invoke;
}

async function callLoad(filePath: string): Promise<LoadResponse> {
  const ipc = getIpc();
  if (!ipc?.invoke) {
    return { ok: false, error: 'IPC not available (web build?)' };
  }
  return (await ipc.invoke(
    MODELHUB_IPC.loadModelMeta,
    filePath,
  )) as LoadResponse;
}

export interface EnrichModelMetaOptions {
  skipWrite?: boolean;
}

export async function enrichModelMeta(
  filePath: string,
  options: EnrichModelMetaOptions = {},
): Promise<EnrichResponse> {
  if (!ipcAvailable()) {
    return { ok: false, error: 'IPC not available (web build?)' };
  }
  if (!isSupportedModelFile(filePath)) {
    return { ok: false, error: 'unsupported format' };
  }
  const result = (await window.electronIO!.ipcRenderer.invoke(
    MODELHUB_IPC.enrichLocal,
    filePath,
    options,
  )) as EnrichResponse;
  if (result.ok && result.modelMeta) {
    cache.set(filePath, result.modelMeta);
  }
  return result;
}

export async function enrichModelMetaHf(
  filePath: string,
  options: EnrichHfClientOptions = {},
): Promise<EnrichHfResponse> {
  if (!ipcAvailable()) {
    return { ok: false, error: 'IPC not available (web build?)' };
  }
  if (!isSupportedModelFile(filePath)) {
    return { ok: false, error: 'unsupported format' };
  }
  const result = (await window.electronIO!.ipcRenderer.invoke(
    MODELHUB_IPC.enrichHf,
    filePath,
    options,
  )) as EnrichHfResponse;
  if (result.ok && result.modelMeta) {
    cache.set(filePath, result.modelMeta);
  }
  return result;
}

/**
 * Imperative API: get the current sidecar modelMeta. Cached. Returns undefined
 * when no sidecar exists yet — caller should run enrichModelMeta to populate.
 */
export async function fetchModelMeta(
  filePath: string,
): Promise<ModelMeta | undefined> {
  const cached = cache.get(filePath);
  if (cached) return '_error' in cached ? undefined : cached;

  let promise = inflight.get(filePath);
  if (!promise) {
    promise = callLoad(filePath);
    inflight.set(filePath, promise);
  }
  try {
    const result = await promise;
    if (result.ok && result.modelMeta) {
      cache.set(filePath, result.modelMeta);
      return result.modelMeta;
    }
    if (!result.ok && result.error) {
      cache.set(filePath, { _error: result.error });
    }
    return undefined;
  } finally {
    inflight.delete(filePath);
  }
}

interface PatchResponse {
  ok: boolean;
  modelMeta?: ModelMeta;
  sidecarPath?: string;
  written?: boolean;
  error?: string;
}

/**
 * Patch arbitrary fields onto a model's sidecar (notes, runParams, …).
 * Goes through the canonical-shard resolver in main, so callers can
 * pass any sibling and the data lands on shard 1.
 *
 * Updates the in-memory cache on success so the next `fetchModelMeta`
 * sees the new state without needing another IPC round-trip.
 */
export async function patchModelMeta(
  filePath: string,
  patch: Partial<ModelMeta>,
): Promise<PatchResponse> {
  if (!ipcAvailable()) {
    return { ok: false, error: 'IPC not available (web build?)' };
  }
  const result = (await window.electronIO!.ipcRenderer.invoke(
    MODELHUB_IPC.patchModelMeta,
    filePath,
    patch,
  )) as PatchResponse;
  if (result.ok && result.modelMeta) {
    cache.set(filePath, result.modelMeta);
  }
  return result;
}

/**
 * React hook: returns the current sidecar modelMeta (read-only). Reactive on
 * `filePath` changes. Does NOT auto-enrich — call `enrichModelMeta` separately
 * (typically from a button or when the user opens the model card).
 */
export function useModelMeta(filePath?: string): UseModelMetaState {
  const [state, setState] = useState<UseModelMetaState>(() => {
    if (!filePath) return { loading: false };
    const cached = cache.get(filePath);
    if (cached) {
      return '_error' in cached
        ? { loading: false, error: cached._error }
        : { loading: false, modelMeta: cached };
    }
    return { loading: true };
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!filePath) {
      setState({ loading: false });
      return () => {
        aliveRef.current = false;
      };
    }

    const cached = cache.get(filePath);
    if (cached) {
      setState(
        '_error' in cached
          ? { loading: false, error: cached._error }
          : { loading: false, modelMeta: cached },
      );
      return () => {
        aliveRef.current = false;
      };
    }

    setState({ loading: true });
    callLoad(filePath)
      .then((result) => {
        if (!aliveRef.current) return;
        if (result.ok && result.modelMeta) {
          cache.set(filePath, result.modelMeta);
          setState({ loading: false, modelMeta: result.modelMeta });
        } else if (!result.ok && result.error) {
          cache.set(filePath, { _error: result.error });
          setState({ loading: false, error: result.error });
        } else {
          // No sidecar yet — not an error, just not populated.
          setState({ loading: false });
        }
      })
      .catch((e: unknown) => {
        if (!aliveRef.current) return;
        const err = (e as Error).message || 'IPC failed';
        cache.set(filePath, { _error: err });
        setState({ loading: false, error: err });
      });

    return () => {
      aliveRef.current = false;
    };
  }, [filePath]);

  return state;
}

/** Test-only: clear in-memory cache. */
export function _clearModelMetaCache(): void {
  cache.clear();
  inflight.clear();
}

// --- Bulk enrichment -----------------------------------------------------

export interface BulkProgressEvent {
  runId: string;
  processed: number;
  total: number;
  currentFile?: string;
  lastStatus?: 'ok' | 'skipped' | 'error';
  lastError?: string;
  lastAutoTags?: string[];
  lastMatchedRepo?: string;
}

export interface BulkSummary {
  total: number;
  processed: number;
  ok: number;
  skipped: number;
  errors: number;
  errorSamples: Array<{ filePath: string; error: string }>;
  cancelled: boolean;
}

export interface BulkDoneEvent {
  runId: string;
  summary?: BulkSummary;
  error?: string;
}

export interface BulkOptions {
  mode?: 'local' | 'hf';
  skipWrite?: boolean;
  concurrency?: number;
  freshnessMs?: number;
  force?: boolean;
  apiToken?: string;
  maxFiles?: number;
}

export interface BulkRun {
  runId: string;
  cancel: () => Promise<void>;
}

/**
 * Start a bulk-enrichment run on a folder. Returns the run id immediately.
 * Listen via `subscribeBulkEvents` to get progress + done events.
 */
export async function startBulkEnrichment(
  rootDir: string,
  options: BulkOptions = {},
): Promise<BulkRun | { error: string }> {
  const ipc = getIpc();
  if (!ipc?.invoke) {
    return { error: 'IPC not available (web build?)' };
  }
  const result = (await ipc.invoke(
    MODELHUB_IPC.enrichFolderStart,
    rootDir,
    options,
  )) as { runId: string };
  return {
    runId: result.runId,
    cancel: async () => {
      await window.electronIO!.ipcRenderer.invoke(
        MODELHUB_IPC.enrichFolderCancel,
        result.runId,
      );
    },
  };
}

/**
 * Subscribe to progress + done events for any active runs. Returns an unsubscribe.
 * The listener is filtered by runId at the call site (this helper passes raw events).
 */
export function subscribeBulkEvents(
  onProgress: (event: BulkProgressEvent) => void,
  onDone: (event: BulkDoneEvent) => void,
): () => void {
  if (!ipcAvailable()) return () => {};
  const offProgress = window.electronIO!.ipcRenderer.on(
    MODELHUB_IPC.enrichFolderProgress,
    (...args: unknown[]) => onProgress(args[0] as BulkProgressEvent),
  );
  const offDone = window.electronIO!.ipcRenderer.on(
    MODELHUB_IPC.enrichFolderDone,
    (...args: unknown[]) => onDone(args[0] as BulkDoneEvent),
  );
  return () => {
    offProgress();
    offDone();
  };
}
