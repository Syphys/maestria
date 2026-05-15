/**
 * Local enrichment orchestrator: parse header → derive auto-tags → patch sidecar.
 * Fully offline, no network. Returns the resulting ModelMeta plus disk-write status.
 */

import { computeAutoTags } from '../../renderer/modelhub/autoTags';
import { ModelMeta } from '../../renderer/modelhub/types';
import { readModelHeader } from './parseHeader';
import { patchModelMeta } from './sidecar';
import { computeFolderSegments } from './folderTags';
import { resolveCanonicalShardPath } from './shardFs';

export interface EnrichLocalOptions {
  /** Skip writing the sidecar (read-only locations). */
  skipWrite?: boolean;
  /**
   * Location root used to derive `dir:<segment>` auto-tags. When provided,
   * each path segment between root and file becomes a tag. Without it, only
   * the immediate parent folder is used (best-effort fallback).
   */
  rootDir?: string;
}

export interface EnrichLocalResult {
  ok: boolean;
  /** Final ModelMeta (merged with any pre-existing sidecar values). */
  modelMeta?: ModelMeta;
  /** Auto-tags derived this run. */
  autoTags?: string[];
  sidecarPath?: string;
  /** True if we wrote the sidecar to disk. */
  written?: boolean;
  error?: string;
}

export async function enrichLocal(
  filePath: string,
  options: EnrichLocalOptions = {},
): Promise<EnrichLocalResult> {
  // Models Hub treats sharded sets as one logical model — see
  // MODELS_HUB_SHARDS.md. If the user clicks on shard 7/12, transparently
  // redirect to shard 1 so the sidecar lives on the canonical entry and
  // duplicates don't accumulate across siblings.
  const canonicalPath = await resolveCanonicalShardPath(filePath);
  const headerResult = await readModelHeader(canonicalPath);
  if (!headerResult.ok || !headerResult.meta) {
    return { ok: false, error: headerResult.error ?? 'header parse failed' };
  }
  const header = headerResult.meta;
  const folderSegments = computeFolderSegments(canonicalPath, options.rootDir);

  const autoTags = computeAutoTags({
    header,
    folderSegments,
  });

  const patch: Partial<ModelMeta> = {
    header,
    autoTags,
    lastEnrichedAt: new Date().toISOString(),
  };

  try {
    const writeResult = await patchModelMeta(canonicalPath, patch, {
      skipWrite: options.skipWrite,
      syncSystemTags: autoTags,
    });
    return {
      ok: true,
      modelMeta: writeResult.modelMeta,
      autoTags,
      sidecarPath: writeResult.sidecarPath,
      written: writeResult.written,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
