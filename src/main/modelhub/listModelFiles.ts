/**
 * Recursive walker that yields paths to model files under a root directory.
 * Skips `.ts/`, `node_modules/`, `.git/`, and hidden directories.
 */

import fs from 'fs';
import path from 'path';
import { isCanonicalShard } from '../../renderer/modelhub/shard';

const MODEL_EXTENSIONS = new Set([
  '.gguf',
  '.safetensors',
  '.bin',
  '.ckpt',
  '.pt',
  '.pth',
]);

const SKIP_DIRS = new Set(['.ts', 'node_modules', '.git', '.svn', '.hg']);

function isModelFileName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of MODEL_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export interface ListModelFilesOptions {
  /** Hard cap on total files returned. Default 50000 (sanity guard). */
  maxFiles?: number;
  /** Maximum traversal depth. Default 16. */
  maxDepth?: number;
}

/**
 * Returns the list of model files under `root` (recursive).
 * Path order is depth-first but not otherwise guaranteed.
 */
export async function listModelFiles(
  root: string,
  options: ListModelFilesOptions = {},
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 50_000;
  const maxDepth = options.maxDepth ?? 16;
  const results: string[] = [];
  await walk(root, 0);
  return results;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (results.length >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        // Skip non-canonical shards: a 12-shard model would otherwise be
        // enriched 12 times. Sharded sets are represented by shard 1 — see
        // MODELS_HUB_SHARDS.md.
        if (isModelFileName(entry.name) && isCanonicalShard(entry.name)) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  }
}
