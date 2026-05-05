/**
 * Walks a location tree once and returns the set of folder paths that
 * contain (recursively) at least one model file.
 *
 * Used by the renderer to filter the directory listing: in a Models Hub
 * fork, a folder with no model anywhere inside is just noise (think HF
 * blob caches, README dumps, screenshot folders). Filtering at display
 * time without this index would cost N fs walks per render.
 *
 * Strategy is the same as `listModelFiles` but yields every ancestor
 * directory of every found model. One walk = full set.
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

export interface ListModelHostingFoldersOptions {
  /** Hard cap on total model files counted before bailing. Default 50000. */
  maxFiles?: number;
  /** Maximum traversal depth. Default 16. */
  maxDepth?: number;
}

/**
 * Returns absolute folder paths (the root + every ancestor of any model
 * file found inside it). The root itself is included only when at least
 * one model file exists somewhere under it.
 */
export async function listModelHostingFolders(
  root: string,
  options: ListModelHostingFoldersOptions = {},
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 50_000;
  const maxDepth = options.maxDepth ?? 16;
  const hosting = new Set<string>();
  let modelCount = 0;

  /**
   * `dir` is the absolute current directory. Returns true iff at least one
   * model file was found at or below `dir` — lets the parent know it
   * should mark itself as hosting.
   */
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > maxDepth) return false;
    if (modelCount >= maxFiles) return false;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    let foundHere = false;
    for (const entry of entries) {
      if (modelCount >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // eslint-disable-next-line no-await-in-loop
        const childHas = await walk(path.join(dir, entry.name), depth + 1);
        if (childHas) foundHere = true;
      } else if (entry.isFile()) {
        if (isModelFileName(entry.name) && isCanonicalShard(entry.name)) {
          modelCount += 1;
          foundHere = true;
        }
      }
    }

    if (foundHere) hosting.add(dir);
    return foundHere;
  }

  await walk(root, 0);
  return Array.from(hosting);
}
