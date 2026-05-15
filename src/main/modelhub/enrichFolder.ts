/**
 * Bulk enrichment for a folder: walk the directory, parse + auto-tag every
 * model file, persist sidecars (with system tags).
 *
 * Concurrency: model header parsing is IO-bound (small read) and the enrichment
 * pipeline writes one sidecar per file. A pool of 4 workers gives a good
 * speedup on NVMe without saturating the disk.
 *
 * Progress: a `onProgress` callback fires after each file (success or failure).
 * The IPC wrapper (in `ipc.ts`) forwards these to the renderer via
 * `webContents.send('modelhub:enrichFolderProgress', ...)`.
 */

import { enrichLocal } from './enrichLocal';
import { listModelFiles } from './listModelFiles';
import { loadModelMeta, patchModelMeta } from './sidecar';
import { computeAutoTags } from '../../renderer/modelhub/autoTags';
import { computeFolderSegments } from './folderTags';

export interface EnrichFolderOptions {
  /** Skip writing sidecars (read-only locations). */
  skipWrite?: boolean;
  /** Number of files to process in parallel. Default 4. */
  concurrency?: number;
  /** Skip files whose lastEnrichedAt is fresher than this many ms. Default 1h. */
  freshnessMs?: number;
  /** Force re-enrichment even when fresh. */
  force?: boolean;
  /** Hard cap on files processed. */
  maxFiles?: number;
  /** Cancel signal — caller flips this to true to stop the queue. */
  cancelToken?: { cancelled: boolean };
}

export interface EnrichFolderProgress {
  processed: number;
  total: number;
  currentFile?: string;
  /** Result of the most recent completion. */
  lastStatus?: 'ok' | 'skipped' | 'error';
  lastError?: string;
  lastAutoTags?: string[];
}

export interface EnrichFolderSummary {
  total: number;
  processed: number;
  ok: number;
  skipped: number;
  errors: number;
  errorSamples: Array<{ filePath: string; error: string }>;
  cancelled: boolean;
}

const DEFAULT_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour (more reactive)

function isFreshEnough(
  lastIso: string | undefined,
  freshnessMs: number,
): boolean {
  if (!lastIso) return false;
  const age = Date.now() - new Date(lastIso).getTime();
  return age < freshnessMs;
}

export async function enrichFolder(
  rootDir: string,
  options: EnrichFolderOptions = {},
  onProgress?: (p: EnrichFolderProgress) => void,
): Promise<EnrichFolderSummary> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const cancel = options.cancelToken;

  const files = await listModelFiles(rootDir, { maxFiles: options.maxFiles });
  const summary: EnrichFolderSummary = {
    total: files.length,
    processed: 0,
    ok: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
    cancelled: false,
  };

  if (files.length === 0) {
    onProgress?.({ processed: 0, total: 0 });
    return summary;
  }

  // Initial progress event (before any work)
  onProgress?.({ processed: 0, total: files.length });

  const queue = files.slice();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (cancel?.cancelled) return;
      const idx = cursor++;
      if (idx >= queue.length) return;
      const filePath = queue[idx];

      let status: EnrichFolderProgress['lastStatus'] = 'ok';
      let lastError: string | undefined;
      let lastAutoTags: string[] | undefined;

      try {
        if (!options.force) {
          const existing = await loadModelMeta(filePath);

          if (
            existing?.lastEnrichedAt &&
            isFreshEnough(existing.lastEnrichedAt, freshnessMs)
          ) {
            status = 'skipped';
            summary.skipped += 1;
            // Re-derive autoTags from the cached header / folder
            // segments rather than reusing `existing.autoTags`. The
            // computeAutoTags function is the source of truth and may
            // have evolved (new namespaces, renames, refined buckets)
            // since the last parse. Re-running it with the same input
            // is free (~µs) and lets a code change propagate on the
            // next Parse-all without forcing a full header reparse.
            const folderSegments = computeFolderSegments(filePath, rootDir);
            const freshAutoTags = computeAutoTags({
              header: existing.header,
              folderSegments,
            });
            lastAutoTags = freshAutoTags;
            // Tag-normalization pass: even when we skip re-parsing the
            // header, run patchModelMeta with `syncSystemTags` so the
            // sidecar's `tags[]` is reconciled by
            // `mergeSystemTagsIntoExisting` and `modelMeta.autoTags`
            // is refreshed with the freshly-computed list. Without
            // this, Parse-all is a no-op for already-enriched files
            // and visible duplicates / stale namespaces persist.
            if (!options.skipWrite && freshAutoTags.length > 0) {
              try {
                await patchModelMeta(
                  filePath,
                  { autoTags: freshAutoTags },
                  { syncSystemTags: freshAutoTags },
                );
              } catch {
                /* normalization failure is non-fatal — continue the bulk */
              }
            }
          }
        }

        if (status !== 'skipped') {
          const res = await enrichLocal(filePath, {
            skipWrite: options.skipWrite,
            rootDir,
          });
          if (res.ok) {
            summary.ok += 1;
            lastAutoTags = res.autoTags;
          } else {
            status = 'error';
            lastError = res.error;
            summary.errors += 1;
            if (summary.errorSamples.length < 8) {
              summary.errorSamples.push({
                filePath,
                error: res.error ?? 'unknown',
              });
            }
          }
        }
      } catch (e) {
        status = 'error';
        lastError = (e as Error).message;
        summary.errors += 1;
        if (summary.errorSamples.length < 8) {
          summary.errorSamples.push({ filePath, error: lastError });
        }
      }

      summary.processed += 1;
      onProgress?.({
        processed: summary.processed,
        total: files.length,
        currentFile: filePath,
        lastStatus: status,
        lastError,
        lastAutoTags,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (cancel?.cancelled) summary.cancelled = true;
  return summary;
}
