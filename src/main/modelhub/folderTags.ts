/**
 * Helper shared by `enrichLocal` and `enrichHf` to derive `dir:<segment>`
 * auto-tag inputs from a file path + (optional) location root.
 *
 * Without a root, falls back to the immediate parent's basename — that's
 * still useful (e.g. "LLM" or "Audio" depending on where the user dropped
 * the file) but won't capture the full hierarchy.
 */

import path from 'path';

export function computeFolderSegments(
  filePath: string,
  rootDir?: string,
): string[] {
  const dir = path.dirname(filePath);
  if (!rootDir) {
    const base = path.basename(dir);
    return base ? [base] : [];
  }
  const rel = path.relative(rootDir, dir);
  // file lives outside rootDir → relative path starts with `..` (or is empty
  // when rootDir equals the file's dir, which means no segments to add).
  if (!rel || rel.startsWith('..')) {
    const base = path.basename(dir);
    return base ? [base] : [];
  }
  return rel.split(/[\\/]+/).filter(Boolean);
}
