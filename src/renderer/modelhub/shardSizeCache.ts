/**
 * Tiny in-memory cache mapping canonical shard path → totalBytes.
 *
 * Used by `services/search.ts` to make the GB-range slider work correctly
 * for sharded models. The post-filter runs synchronously on every search
 * pass, but reading sidecar files is async + costs ~1ms per file on NVMe.
 * Doing 1500 reads per keystroke would freeze the UI.
 *
 * Strategy:
 *  - `getCachedTotalBytes(path)` returns the cached number or undefined.
 *  - `primeTotalBytes(paths)` triggers a background fetch for any uncached
 *    canonical shard paths and resolves once they're all loaded. The
 *    search wrapper calls this fire-and-forget right before filtering;
 *    the next render gets correct numbers.
 *
 * Source of truth: the main-process `modelhub:sumShardBytes` IPC, which
 * fs.stats sibling shards directly. We deliberately do NOT read the
 * sidecar because users may be filtering before re-running Parse all
 * (e.g. when upgrading from a build that didn't yet store totalBytes).
 *
 * The cache is a plain Map, no eviction — the working set is bounded by
 * the number of sharded models in the location (typically <100), so
 * megabytes-scale memory is fine and TTL would just cause flicker.
 */

import { detectShardInfo, isCanonicalShard } from './shard';
import { MODELHUB_IPC } from './types';

const cache = new Map<string, number>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

interface SumShardBytesResult {
  ok: boolean;
  totalBytes?: number;
  shardCount?: number;
  error?: string;
}

async function fetchSum(filePath: string): Promise<number | undefined> {
  const r = window.electronIO?.ipcRenderer as
    | { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
    | undefined;
  if (!r) return undefined;
  try {
    const result = (await r.invoke(
      MODELHUB_IPC.sumShardBytes,
      filePath,
    )) as SumShardBytesResult;
    if (
      result?.ok &&
      typeof result.totalBytes === 'number' &&
      result.totalBytes > 0
    ) {
      return result.totalBytes;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function getCachedTotalBytes(filePath: string): number | undefined {
  return cache.get(filePath);
}

export function subscribeShardSizeCache(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // ignore listener throws — never let one bad listener break others
    }
  }
}

/**
 * Prime the cache for all sharded canonical entries in `filePaths`.
 * Non-sharded files don't need an entry — `entry.size` already equals
 * their model's total. Returns once every miss has been resolved.
 *
 * Failed lookups are NOT cached — that way, if the IPC was momentarily
 * unavailable (e.g. main process restart in dev), the next call retries.
 */
export async function primeTotalBytes(filePaths: string[]): Promise<void> {
  const todo: string[] = [];
  for (const p of filePaths) {
    if (cache.has(p)) continue;
    if (inFlight.has(p)) continue;
    const name = p.replace(/^.*[\\/]/, '');
    if (!isCanonicalShard(name)) continue;
    if (!detectShardInfo(name)) continue; // not sharded → entry.size is fine
    todo.push(p);
  }
  if (todo.length === 0) return;

  for (const p of todo) inFlight.add(p);

  await Promise.allSettled(
    todo.map(async (p) => {
      try {
        const total = await fetchSum(p);
        if (typeof total === 'number' && total > 0) {
          cache.set(p, total);
        }
        // On miss: do NOT cache. Next call will retry.
      } finally {
        inFlight.delete(p);
      }
    }),
  );
  notify();
}

/** Test helper — flushes the cache. Not exported from the package index. */
export function _clearShardSizeCache(): void {
  cache.clear();
  inFlight.clear();
}
