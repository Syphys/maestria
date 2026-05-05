/**
 * Detects sharded-model filename patterns like
 *   `model-00001-of-00003.gguf`
 *   `Llama-3-70B-Q5_K_M-00001-of-00012.gguf`
 *   `model.safetensors.00001-of-00003`
 * Returns `{current, total}` (1-indexed) or undefined.
 *
 * Models Hub treats sharded files as one logical model — see
 * MODELS_HUB_SHARDS.md. Helpers below let any code answer "is this the
 * canonical shard?" and "what would the canonical sibling look like?"
 * without doing string surgery itself.
 */

/**
 * Shard naming we recognize:
 *
 *   - `model-00001-of-00012.gguf`           ← HF / llama-gguf-split default
 *   - `model.00001-of-00012.gguf`           ← some tools use a dot separator
 *   - `model_00001_of_00012.gguf`           ← underscore variant in the wild
 *   - `model-00001_Of_00012.gguf`           ← capitalized `Of`, mixed seps
 *   - `model-001-of-010.safetensors`        ← 3-digit padding
 *
 * One regex covers them all: leading separator is one of `-_.`, the
 * `of` literal is case-insensitive, and the separators around it can be
 * `-` or `_`. Index/total always 2-5 digits.
 */
const SHARD_PATTERNS: RegExp[] = [
  /[-_.]([0-9]{2,5})[-_]of[-_]([0-9]{2,5})(?=\.[A-Za-z0-9]+$|$)/i,
];

export function detectShardInfo(
  fileName: string,
): { current: number; total: number } | undefined {
  for (const re of SHARD_PATTERNS) {
    const m = fileName.match(re);
    if (m) {
      const current = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (
        Number.isFinite(current) &&
        Number.isFinite(total) &&
        total >= 1 &&
        current >= 1 &&
        current <= total
      ) {
        return { current, total };
      }
    }
  }
  return undefined;
}

/**
 * Width-preserving zero-padded integer formatter so the rewritten name
 * matches the on-disk pattern exactly (`00001` not `1`). Without this,
 * `siblingShardNames("foo-00001-of-00012.gguf", 12)[6]` would be
 * `foo-7-of-00012.gguf` and miss the actual file.
 */
function padToMatch(n: number, sample: string): string {
  return n.toString().padStart(sample.length, '0');
}

/**
 * True when this filename represents a model that the rest of the app
 * should care about: either it's not sharded at all, or it's the first
 * shard of a sharded set.
 */
export function isCanonicalShard(fileName: string): boolean {
  const info = detectShardInfo(fileName);
  return !info || info.current === 1;
}

/**
 * Rewrite a filename to point at its canonical sibling (shard 1).
 * Idempotent: passing the canonical name back returns the same name.
 * For non-sharded names, returns the input unchanged.
 *
 * Pure string operation — does NOT touch the filesystem; the main-process
 * `shardFs.ts` wraps this with existence checks.
 */
export function canonicalShardName(fileName: string): string {
  for (const re of SHARD_PATTERNS) {
    const m = fileName.match(re);
    if (!m) continue;
    const currentStr = m[1];
    const totalStr = m[2];
    if (parseInt(currentStr, 10) === 1) return fileName;
    const ones = padToMatch(1, currentStr);
    return (
      fileName.slice(0, m.index!) +
      m[0].replace(currentStr, ones).replace(totalStr, totalStr) +
      fileName.slice(m.index! + m[0].length)
    );
  }
  return fileName;
}

/**
 * Drop the `-NNNNN-of-NNNNN` (or `_of_`, `.of.`, …) suffix from a
 * filename so the listing can show the *logical* model name.
 *
 *   `Qwen3-Coder-Next-Q6_K_Xl-00001-of-00003.gguf`
 * → `Qwen3-Coder-Next-Q6_K_Xl.gguf`
 *
 * The matched separator (`-`, `_`, `.`) is also dropped so the result
 * doesn't end with a stray dash. Works on both the bare basename and
 * the title (basename minus extension); we don't try to be clever about
 * which it is — the same regex matches both shapes.
 */
export function stripShardSuffix(fileName: string): string {
  return fileName.replace(
    /[-_.]([0-9]{2,5})[-_]of[-_]([0-9]{2,5})(?=\.[A-Za-z0-9]+$|$)/i,
    '',
  );
}

/**
 * Generate the expected names of all siblings (including the input itself).
 * Returns the input as a single-element array when not sharded.
 *
 * Useful for `findExistingSiblingShards` (main process) which then filters
 * by what actually exists on disk.
 */
export function siblingShardNames(fileName: string): string[] {
  for (const re of SHARD_PATTERNS) {
    const m = fileName.match(re);
    if (!m) continue;
    const currentStr = m[1];
    const totalStr = m[2];
    const total = parseInt(totalStr, 10);
    if (!Number.isFinite(total) || total < 1) return [fileName];
    const out: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const padded = padToMatch(i, currentStr);
      out.push(
        fileName.slice(0, m.index!) +
          m[0].replace(currentStr, padded) +
          fileName.slice(m.index! + m[0].length),
      );
    }
    return out;
  }
  return [fileName];
}
