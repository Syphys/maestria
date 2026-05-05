/**
 * Heuristic to map a local file (path + parsed header) to a candidate HF repo.
 *
 * Strategy (in order of confidence):
 *   1. Walk the path looking for `<author>/<repo>` segments — works perfectly
 *      when users mirror HF structure locally (very common with `huggingface-cli`).
 *   2. Combine header.basename (canonical model name from inside the file) with
 *      a path segment that looks like an author/org.
 *   3. Strip quantization suffixes from the filename and try with each plausible
 *      author segment.
 *
 * The caller still needs to verify each candidate against the HF API (a `getModelInfo`
 * 200/404 call decides the match).
 */

import path from 'path';
import { HeaderMeta } from '../../renderer/modelhub/types';

export interface RepoCandidate {
  repo: string; // "author/model"
  source: 'path' | 'header+author' | 'filename+author';
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Path segments that look like generic categorization rather than HF authors.
 * Conservative: false positives here (rejecting a real author) just cost a
 * candidate, the search fallback will still find the real repo. False
 * negatives (accepting a non-author) cause 401/403 that we now handle.
 */
const NON_AUTHOR_SEGMENTS = new Set([
  // Drive / root markers
  'models',
  'model',
  '.ts',
  // Modality categories
  'audio',
  'video',
  'image',
  'images',
  'text',
  'parole',
  'speech',
  'tts',
  'asr',
  'music',
  'musique',
  'genesis',
  // Architecture-as-folder
  'llm',
  'llms',
  'sd',
  'sdxl',
  'flux',
  'lora',
  'loras',
  'embedding',
  'embeddings',
  'motiongpt3',
  // Format-as-folder
  'gguf',
  'safetensors',
  'ckpt',
  // Common task / domain folders
  'benchmark',
  'benchmarks',
  'codage',
  'coding',
  'code',
  'ecriture',
  'writing',
  'general',
  'juridique',
  'legal',
  'medical',
  'raisonnement',
  'reasoning',
  'reranker',
  'reranking',
  'vl',
  'vision',
  'multimodal',
  'chat',
  'instruct',
]);

const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function isPlausibleSegment(s: string): boolean {
  if (!s) return false;
  if (s.length > 100) return false;
  if (NON_AUTHOR_SEGMENTS.has(s.toLowerCase())) return false;
  return SEGMENT_RE.test(s);
}

/**
 * Strip common model-naming suffixes to reveal the canonical base name.
 * Order matters: extension first, then quantization noise, repeatedly until stable.
 */
const STRIP_PATTERNS: RegExp[] = [
  /\.(gguf|safetensors|bin|ckpt|pt|pth)$/i,
  /[-_.](Q[0-9]+(_[A-Z]+)*|q[0-9]+(_[a-z]+)*|FP16|FP8|BF16|F32|F16|INT4|INT8|INT16|NF4|GPTQ|AWQ|EXL2|fp16|fp8|bf16|f32|f16|int4|int8|int16|nf4|gptq|awq|exl2)$/,
  /[-_.](i1|i2|imatrix|imat)$/i,
  /-(K_S|K_M|K_L|XS|XXS)$/i,
];

export function stripQuantizationSuffixes(name: string): string {
  let s = name;
  let prev = '';
  while (s !== prev) {
    prev = s;
    for (const re of STRIP_PATTERNS) {
      s = s.replace(re, '');
    }
  }
  return s;
}

/**
 * Splits a path into segments using both forward and backslash separators —
 * so it works on Windows and POSIX without the caller having to normalize.
 */
function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

export interface GuessOptions {
  /** Maximum candidates to return. Default 5. */
  limit?: number;
}

export function guessRepoCandidates(
  filePath: string,
  header?: HeaderMeta,
  options: GuessOptions = {},
): RepoCandidate[] {
  const limit = options.limit ?? 5;
  const candidates: RepoCandidate[] = [];
  const seen = new Set<string>();

  const segments = splitPath(filePath);
  const filename = path.basename(filePath);
  const stripped = stripQuantizationSuffixes(filename);

  function add(
    repo: string,
    source: RepoCandidate['source'],
    confidence: RepoCandidate['confidence'],
  ): void {
    if (seen.has(repo.toLowerCase())) return;
    seen.add(repo.toLowerCase());
    candidates.push({ repo, source, confidence });
  }

  // Strategy 1: <author>/<repo>/<file> — walk pairs from deepest to shallowest
  // Skip the last segment (the filename); for each i, pair (i-1, i) as author/repo.
  for (let i = segments.length - 2; i >= 1; i--) {
    const author = segments[i - 1];
    const repo = segments[i];
    if (isPlausibleSegment(author) && isPlausibleSegment(repo)) {
      add(`${author}/${repo}`, 'path', 'high');
    }
  }

  // Strategy 2: header.basename + each plausible parent segment as author
  if (header?.basename && isPlausibleSegment(header.basename)) {
    for (let i = segments.length - 2; i >= 0; i--) {
      const author = segments[i];
      if (isPlausibleSegment(author)) {
        add(`${author}/${header.basename}`, 'header+author', 'medium');
      }
    }
  }

  // Strategy 3: stripped filename + each plausible parent segment as author
  if (isPlausibleSegment(stripped) && stripped !== header?.basename) {
    for (let i = segments.length - 2; i >= 0; i--) {
      const author = segments[i];
      if (isPlausibleSegment(author)) {
        add(`${author}/${stripped}`, 'filename+author', 'low');
      }
    }
  }

  return candidates.slice(0, limit);
}
