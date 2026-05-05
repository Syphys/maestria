/**
 * Per-location cache of "folders that contain at least one model file
 * (recursively)". Drives the directory-listing filter that hides folders
 * with no models inside.
 *
 * Loaded once per location root via the
 * `modelhub:listModelHostingFolders` IPC. Filtering is then synchronous
 * (Set membership lookup), keeping the listing path cheap.
 *
 * Cache invalidation: a single in-memory Map keyed by `rootDir`. Manually
 * cleared via `invalidateModelHostingFolders` when bulk enrichment runs
 * (Parse-all may have added files into folders that were previously
 * empty, e.g. on first run after copying weights into a new location).
 */

import { MODELHUB_IPC } from './types';

interface CacheEntry {
  rootDir: string;
  folders: Set<string>;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function subscribeModelHostingFolders(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True only when the cache for this root has been populated. */
export function isModelHostingFoldersReady(rootDir: string): boolean {
  return cache.has(rootDir);
}

/**
 * Sync lookup. Returns true when the folder is known to host a model.
 * Returns `undefined` when the cache for the parent root hasn't loaded
 * yet — callers should treat that as "show the folder for now" to avoid
 * flicker during the initial scan.
 */
export function isModelHostingFolder(
  rootDir: string,
  folderPath: string,
): boolean | undefined {
  const entry = cache.get(rootDir);
  if (!entry) return undefined;
  return entry.folders.has(folderPath);
}

interface ListResponse {
  ok: boolean;
  folders?: string[];
  error?: string;
}

/**
 * Trigger a scan + populate the cache. Returns the same promise on
 * concurrent calls so we never duplicate the walk for a single root.
 */
export function primeModelHostingFolders(rootDir: string): Promise<void> {
  if (!rootDir) return Promise.resolve();
  if (cache.has(rootDir)) return Promise.resolve();
  const existing = inflight.get(rootDir);
  if (existing) return existing;

  const p = (async () => {
    try {
      const r = window.electronIO?.ipcRenderer as
        | { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
        | undefined;
      if (!r) return;
      const result = (await r.invoke(
        MODELHUB_IPC.listModelHostingFolders,
        rootDir,
      )) as ListResponse;
      if (!result?.ok || !result.folders) return;
      cache.set(rootDir, {
        rootDir,
        folders: new Set(result.folders),
        loadedAt: Date.now(),
      });
      notify();
    } finally {
      inflight.delete(rootDir);
    }
  })();
  inflight.set(rootDir, p);
  return p;
}

/**
 * Clear the cached set for a root. Call after bulk enrichment finishes —
 * the file list on disk hasn't changed, but if Parse-all created sidecars
 * that the user wants reflected, this lets the next listing pick up
 * any newly-walked folders. (Today the walker is sidecar-agnostic, so
 * the set is stable, but future versions may use sidecars to skip
 * dotfiles or honor location ignore patterns.)
 */
export function invalidateModelHostingFolders(rootDir?: string): void {
  if (rootDir) cache.delete(rootDir);
  else cache.clear();
  notify();
}
