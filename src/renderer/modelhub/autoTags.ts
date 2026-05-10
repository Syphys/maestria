/**
 * Auto-tag derivation from HeaderMeta + optional HfMeta.
 *
 * Pure: takes parsed metadata, returns a list of namespaced string tags.
 * The "auto" namespace prefix (arch:, quant:, size:, mod:, fmt:, lic:, type:)
 * lets the UI distinguish derived tags from user-set tags.
 */

import { HeaderMeta, HfMeta } from './types';

export const AUTO_TAG_NAMESPACES = [
  'arch',
  'quant',
  'tier', // Bucketed/Categorized size
  'params', // Raw parameter count (exact)
  'ctx', // Context length
  'layers', // Block count
  'disk', // File size on disk
  'mod',
  'fmt',
  'lic',
  'type',
  'dir',
  'meta', // Generic raw metadata
] as const;

/**
 * Generic folder names we don't want to clutter the tag list with: top-level
 * collection roots like `models/` are noise (every file is in there) so they
 * add no signal. Lowercase comparison.
 */
const DIR_TAG_BLOCKLIST = new Set<string>([
  'models',
  'model',
  'modeles',
  'modèles',
  'huggingface',
  'hf',
  'hub',
  'cache',
  '.cache',
]);

function sanitizeDirSegment(seg: string): string | undefined {
  if (!seg) return undefined;
  const trimmed = seg.trim();
  if (!trimmed) return undefined;
  // Strip drive prefix on Windows (e.g. "C:")
  if (/^[a-z]:$/i.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  if (DIR_TAG_BLOCKLIST.has(lower)) return undefined;
  // Replace whitespace + path separators with single dashes; collapse runs.
  return trimmed
    .replace(/[\s/\\]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export type AutoTagNamespace = (typeof AUTO_TAG_NAMESPACES)[number];

const PARAM_BUCKETS: Array<[number, string]> = [
  [1e9, '<1B'],
  [3e9, '1-3B'],
  [7e9, '3-7B'],
  [13e9, '7-13B'],
  [30e9, '13-30B'],
  [70e9, '30-70B'],
  [Infinity, '70B+'],
];

function sizeBucket(paramCount: number): string {
  for (const [upper, label] of PARAM_BUCKETS) {
    if (paramCount < upper) return label;
  }
  return 'unknown';
}

/**
 * Approx bytes-per-parameter for common quantization labels. Lets us
 * back-derive a parameter count from `totalBytes` when no explicit
 * `sizeLabel` or `paramCount` is available — typically for sharded
 * safetensors sets, or GGUFs missing `general.size_label`.
 *
 * The buckets are coarse (`<1B`, `1-3B`, `7-13B`, …) so a ~30% error in
 * the multiplier still lands in the right slot for any reasonable model.
 */
const QUANT_BYTES_PER_PARAM: Array<[RegExp, number]> = [
  [/^q2/i, 0.3],
  [/^q3/i, 0.4],
  [/^q4/i, 0.5],
  [/^q5/i, 0.625],
  [/^q6/i, 0.75],
  [/^q8/i, 1.0],
  [/^iq2/i, 0.3],
  [/^iq3/i, 0.4],
  [/^iq4/i, 0.5],
  [/^bf?16$/i, 2.0],
  [/^f?p?16$/i, 2.0],
  [/^f?p?32$/i, 4.0],
];

function bytesPerParam(quant: string | undefined): number {
  if (!quant) return 0.5; // assume Q4 average — most published quants today
  for (const [re, val] of QUANT_BYTES_PER_PARAM) {
    if (re.test(quant)) return val;
  }
  return 0.5;
}

/**
 * Parse `general.size_label` style strings.
 *
 * Dense models: "8B", "30B", "1.5B", "270M" → returns total only.
 * MoE models:   "8x7B" (Mixtral), "256x22B" (GLM-5.1) → returns
 *               { total = N*Y, perExpert = Y, expertCount = N }.
 *
 * Returns undefined if unparseable. The `total` field is what drives the
 * `tier:` bucket (so MoE land in the correct big bucket instead of being
 * read as a tiny dense model). `perExpert` / `expertCount` let callers
 * surface MoE-specific signals (panel rows, secondary buckets).
 */
export interface ParsedSizeLabel {
  total: number;
  perExpert?: number;
  expertCount?: number;
}

export function parseSizeLabel(
  label: string | undefined,
): ParsedSizeLabel | undefined {
  if (!label) return undefined;
  // MoE: NxYB (e.g. "8x7B", "256x22B", "1.8x14B"). The 'x' or '×' separator
  // can be surrounded by spaces. Unit (B/M/K) applies to Y; N is a count.
  const moe = label.match(
    /^([0-9]+(?:\.[0-9]+)?)\s*[xX×]\s*([0-9]+(?:\.[0-9]+)?)\s*([BMK]?)/i,
  );
  if (moe) {
    const n = parseFloat(moe[1]);
    const y = parseFloat(moe[2]);
    if (!Number.isFinite(n) || !Number.isFinite(y) || n <= 0 || y <= 0) {
      return undefined;
    }
    const unit = (moe[3] || '').toUpperCase();
    const mul =
      unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
    const perExpert = y * mul;
    return { total: n * perExpert, perExpert, expertCount: n };
  }
  const m = label.match(/^([0-9]+(?:\.[0-9]+)?)\s*([BMK]?)/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] || '').toUpperCase();
  const mul = unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return { total: n * mul };
}

/** Normalize a license string from HF (e.g. "apache-2.0" → "apache-2"). */
function normalizeLicense(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().trim();
  if (!lower) return undefined;
  // Strip trailing version dotted noise; keep major numbers
  const collapsed = lower
    .replace(/\.\d+$/, '') // apache-2.0 -> apache-2
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return collapsed || undefined;
}

export interface AutoTagInput {
  header?: HeaderMeta;
  huggingface?: HfMeta;
  /**
   * Path segments between the location root and the file (excluding the
   * filename itself), in order from root → leaf. Each becomes a `dir:<seg>`
   * tag. Empty / blocklisted segments are dropped.
   */
  folderSegments?: string[];
}

export function computeAutoTags(input: AutoTagInput): string[] {
  const tags = new Set<string>();
  const h = input.header;
  const hf = input.huggingface;

  if (h?.architecture && h.architecture !== 'unknown') {
    tags.add(`arch:${String(h.architecture).toLowerCase()}`);
  }

  if (h?.quantization) {
    tags.add(`quant:${h.quantization.toLowerCase()}`);
  }

  // Size: try three signals in order of trust.
  //   1. `sizeLabel` (e.g. GGUF `general.size_label = "70B"`) — author-set,
  //      always reflects the full model. Best signal.
  //   2. `paramCount` from header tensors — but ONLY when not sharded,
  //      since per-shard tensor counts are partial and would mis-bucket.
  //   3. `totalBytes` (sum across shards) ÷ bytes-per-param from quant —
  //      coarse but recovers a useful bucket for safetensors shard sets
  //      and GGUFs missing `size_label`.
  //
  // shardInfo is intentionally NOT emitted as a tag anymore — Models Hub
  // treats sharded sets as one logical model (see MODELS_HUB_SHARDS.md).
  // The shard count is shown in the per-file panel, not as a filterable tag.
  const sizeFromLabel = parseSizeLabel(h?.sizeLabel);
  const isSharded = !!h?.shardInfo && h.shardInfo.total > 1;

  // 1. Bucketed size (tier). For MoE labels like "256x22B", `parseSizeLabel`
  // returns the total (N*Y), so the tier bucket reflects the full model
  // weight rather than the literal first number.
  if (sizeFromLabel !== undefined) {
    tags.add(`tier:${sizeBucket(sizeFromLabel.total)}`);
  } else if (
    typeof h?.paramCount === 'number' &&
    h.paramCount > 0 &&
    !isSharded
  ) {
    tags.add(`tier:${sizeBucket(h.paramCount)}`);
  } else if (typeof h?.totalBytes === 'number' && h.totalBytes > 0) {
    const estParams = h.totalBytes / bytesPerParam(h.quantization);
    if (estParams > 0) tags.add(`tier:${sizeBucket(estParams)}`);
  }

  // 2. Raw / Precise data
  if (h?.sizeLabel) {
    tags.add(`params:${h.sizeLabel.toUpperCase().replace(/\s+/g, '')}`);
  } else if (h?.paramCount && h.paramCount > 0 && !isSharded) {
    // Format large numbers to human readable (e.g. 7.5B)
    const p = h.paramCount;
    const label =
      p >= 1e9
        ? (p / 1e9).toFixed(1) + 'B'
        : p >= 1e6
          ? (p / 1e6).toFixed(1) + 'M'
          : p.toString();
    tags.add(`params:${label}`);
  }

  if (h?.contextMax) {
    const c = h.contextMax;
    const label = c >= 1024 ? Math.round(c / 1024) + 'K' : c.toString();
    tags.add(`ctx:${label}`);
  }

  if (h?.blockCount) {
    tags.add(`layers:${h.blockCount}`);
  }

  if (h?.fileSize) {
    const gb = (h.fileSize / (1024 * 1024 * 1024)).toFixed(1);
    tags.add(`disk:${gb}GB`);
  }

  // Exhaustive meta-tagging: convert EVERYTHING from rawMetadata into tags
  if (h?.rawMetadata) {
    for (const [key, val] of Object.entries(h.rawMetadata)) {
      // Skip very large values (like tokenizer tokens/scores) which are arrays
      if (Array.isArray(val)) continue;

      let displayVal = String(val);
      if (displayVal.length > 0 && displayVal.length < 50) {
        // Clean key: strip 'general.' prefix and normalize separators
        const cleanKey = key.replace(/^general\./, '').replace(/[\s.]+/g, '-');
        // Clean value: normalize separators
        const cleanVal = displayVal.replace(/[\s:]+/g, '-');
        tags.add(`meta:${cleanKey}:${cleanVal}`);
      }
    }
  }

  if (h?.modality) {
    tags.add(`mod:${h.modality}`);
  }

  if (h?.format && h.format !== 'unknown') {
    tags.add(`fmt:${h.format}`);
  }

  if (h?.isLora) {
    tags.add('type:lora');
  }
  // Note: file size is intentionally NOT a tag — it's filtered numerically
  // via `searchQuery.sizeMin/sizeMax` (see services/search.ts) which reads
  // `entry.size` directly. Tags would force range queries to enumerate every
  // bucket value, which is silly when the data is already a number.

  // License only comes from HF metadata for now
  const lic = normalizeLicense(hf?.license);
  if (lic) tags.add(`lic:${lic}`);

  // HF pipeline tag is a strong modality signal — backfill if header didn't give it
  if (!h?.modality && hf?.pipelineTag) {
    const pt = hf.pipelineTag.toLowerCase();
    if (pt.includes('text')) tags.add('mod:text');
    else if (pt.includes('image')) tags.add('mod:image');
    else if (pt.includes('audio') || pt.includes('speech'))
      tags.add('mod:audio');
    else if (pt.includes('video')) tags.add('mod:video');
  }

  // Folder hierarchy: each parent dir between the location root and the file
  // becomes a `dir:<segment>` tag. Lets the user filter "all models in
  // LLM/Codage/" without scrolling, and feeds the tag-library autocomplete.
  if (input.folderSegments && input.folderSegments.length > 0) {
    for (const raw of input.folderSegments) {
      const clean = sanitizeDirSegment(raw);
      if (clean) tags.add(`dir:${clean.toLowerCase()}`);
    }
  }

  return Array.from(tags).sort();
}

/** True iff the tag belongs to a recognized auto-tag namespace. */
export function isAutoTag(tag: string): boolean {
  const colonIdx = tag.indexOf(':');
  if (colonIdx <= 0) return false;
  const ns = tag.slice(0, colonIdx);
  return (AUTO_TAG_NAMESPACES as readonly string[]).includes(ns);
}
