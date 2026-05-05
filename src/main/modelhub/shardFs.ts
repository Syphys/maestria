/**
 * Filesystem-aware wrappers around the pure shard helpers in
 * `renderer/modelhub/shard.ts`. These resolve sibling shards on disk and
 * sum their sizes — they belong in the main process so they can use
 * `fs.promises` directly.
 *
 * The pure helpers are still useful in the renderer (search filter wants
 * to know "is this canonical?" without an IO round-trip), but anything
 * that needs to hit disk lives here.
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  canonicalShardName,
  detectShardInfo,
  siblingShardNames,
} from '../../renderer/modelhub/shard';

/**
 * Resolve any shard path to its canonical (shard 1) path, falling back
 * gracefully when the canonical doesn't exist on disk. The fallback case
 * matters for users with partial downloads — we'd rather surface what's
 * there than redirect into nothing.
 */
export async function resolveCanonicalShardPath(
  filePath: string,
): Promise<string> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const canonName = canonicalShardName(name);
  if (canonName === name) return filePath; // already canonical or unsharded
  const canonPath = path.join(dir, canonName);
  try {
    await fs.access(canonPath);
    return canonPath;
  } catch {
    // Shard 1 missing — return the input so the caller at least sees an
    // error from the actual file the user clicked on, not a phantom path.
    return filePath;
  }
}

/**
 * List shard files that actually exist on disk for the model represented
 * by `filePath`. Includes `filePath` itself (or its canonical) when present.
 * Returns a single-element array for non-sharded files.
 */
export async function findExistingSiblingShards(
  filePath: string,
): Promise<string[]> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const candidates = siblingShardNames(name);
  const out: string[] = [];
  for (const c of candidates) {
    const full = path.join(dir, c);
    try {
      // eslint-disable-next-line no-await-in-loop
      const st = await fs.stat(full);
      if (st.isFile()) out.push(full);
    } catch {
      // Missing shard — skip silently. The summing helper warns higher up
      // when the count doesn't match the expected total.
    }
  }
  return out;
}

export interface ShardSizeAggregate {
  /** Sum of bytes across all sibling shards that exist on disk. */
  totalBytes: number;
  /** Number of sibling shards found on disk. */
  shardCount: number;
  /** Expected total from the filename pattern (current/total). undefined when not sharded. */
  expectedTotal?: number;
  /** True when shardCount < expectedTotal — caller may want to surface a warning. */
  incomplete: boolean;
}

/**
 * Sum the byte sizes of all sibling shards that exist on disk.
 * For non-sharded files, returns the file's own size with shardCount=1.
 */
export async function sumShardBytes(
  filePath: string,
): Promise<ShardSizeAggregate> {
  const info = detectShardInfo(path.basename(filePath));
  const expectedTotal = info?.total;

  if (!info) {
    try {
      const st = await fs.stat(filePath);
      return {
        totalBytes: st.size,
        shardCount: 1,
        expectedTotal: undefined,
        incomplete: false,
      };
    } catch {
      return {
        totalBytes: 0,
        shardCount: 0,
        expectedTotal: undefined,
        incomplete: true,
      };
    }
  }

  const siblings = await findExistingSiblingShards(filePath);
  let totalBytes = 0;
  for (const s of siblings) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const st = await fs.stat(s);
      totalBytes += st.size;
    } catch {
      // ignore
    }
  }
  return {
    totalBytes,
    shardCount: siblings.length,
    expectedTotal,
    incomplete: !!expectedTotal && siblings.length < expectedTotal,
  };
}
