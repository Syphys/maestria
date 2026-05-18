// Slice 3c — routing-embedding projector + reliability gate (SPEC §4).
//
// The ONLY embedder use on the routing path. We never compare
// embed(query) to embed(model) (incompatible spaces): we project the
// query onto the shared text anchors (probe-anchors-v0) and compare
// cosines. embedding_reliability is measured deterministically from the
// mini-MTEB triplet bank and GATES this projector — below threshold
// (notably fr/zh) the caller falls back to the R5 deterministic
// classifier (`classifyQuery`). Pure math + injected embedder: no I/O
// here, network lives in EmbedClient (embed.ts); the embed function is a
// DI seam so this is unit-testable fully offline.

import type {
  EmbeddingReliability,
  EmbeddingTripletBank,
  ProbeAnchorBank,
} from '../../../shared/RoutingTypes';

/** Injected embedder: N texts → N vectors, order preserved. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

/** Query projected onto the anchor basis: cosine per branch and leaf. */
export type QueryProjection = {
  branches: Record<string, number>;
  leaves: Record<string, number>;
};

/** SPEC §4 default; the embedder is selected/gated by this, per language. */
export const DEFAULT_EMBEDDING_RELIABILITY_THRESHOLD = 0.7;

export type ProjectorGate = {
  /** true ⇒ use the embedding projection; false ⇒ fall back to R5. */
  useEmbedding: boolean;
  reason: string;
  perLang: EmbeddingReliability;
};

// --- vector math -------------------------------------------------------------

/** L2-normalise; a zero vector is returned unchanged (norm 0 ⇒ no scale). */
export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0 || !Number.isFinite(n)) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Cosine similarity, robust to non-normalised / zero / mismatched length. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 || !Number.isFinite(d) ? 0 : dot / d;
}

// --- query projection --------------------------------------------------------

/**
 * Project a query onto the anchor basis. One embed call: `[query,
 * ...branchAnchors, ...leafAnchors]` (order preserved by EmbedFn
 * contract). Returns `cos(query, anchor)` per branch and per leaf id.
 */
export async function projectQuery(
  query: string,
  bank: ProbeAnchorBank,
  embed: EmbedFn,
): Promise<QueryProjection> {
  const branchIds = Object.keys(bank.branches);
  const leafIds = Object.keys(bank.leaves);
  const texts = [
    query,
    ...branchIds.map((b) => bank.branches[b]),
    ...leafIds.map((l) => bank.leaves[l]),
  ];
  const vecs = await embed(texts);
  if (vecs.length !== texts.length)
    throw new Error(
      `projectQuery: embedder returned ${vecs.length}/${texts.length} vectors`,
    );
  const q = vecs[0];
  const branches: Record<string, number> = {};
  const leaves: Record<string, number> = {};
  branchIds.forEach((b, i) => {
    branches[b] = cosine(q, vecs[1 + i]);
  });
  leafIds.forEach((l, i) => {
    leaves[l] = cosine(q, vecs[1 + branchIds.length + i]);
  });
  return { branches, leaves };
}

/** Stable anchor order + the flat text list (for cache-once embedding). */
export function anchorOrder(bank: ProbeAnchorBank): {
  branchIds: string[];
  leafIds: string[];
  texts: string[];
} {
  const branchIds = Object.keys(bank.branches);
  const leafIds = Object.keys(bank.leaves);
  return {
    branchIds,
    leafIds,
    texts: [
      ...branchIds.map((b) => bank.branches[b]),
      ...leafIds.map((l) => bank.leaves[l]),
    ],
  };
}

/**
 * Project a pre-embedded query against PRE-EMBEDDED anchors (slice 5b
 * hot path: anchors are embedded once per embedder and cached, only the
 * 1-vector query is embedded per route). `anchorVecs` must be in
 * `anchorOrder` order: branches then leaves.
 */
export function projectFromVectors(
  queryVec: Float32Array,
  anchorVecs: Float32Array[],
  branchIds: string[],
  leafIds: string[],
): QueryProjection {
  if (anchorVecs.length !== branchIds.length + leafIds.length)
    throw new Error(
      `projectFromVectors: ${anchorVecs.length} anchors, expected ${
        branchIds.length + leafIds.length
      }`,
    );
  const branches: Record<string, number> = {};
  const leaves: Record<string, number> = {};
  branchIds.forEach((b, i) => {
    branches[b] = cosine(queryVec, anchorVecs[i]);
  });
  leafIds.forEach((l, i) => {
    leaves[l] = cosine(queryVec, anchorVecs[branchIds.length + i]);
  });
  return { branches, leaves };
}

// --- embedding reliability (mini-MTEB) --------------------------------------

/**
 * Per-language fraction of triplets the embedder orders correctly:
 * `cos(anchor, positive) > cos(anchor, negative)`. Deterministic given a
 * deterministic embedder. Empty / absent languages are omitted (not 0).
 */
export async function measureEmbeddingReliability(
  bank: EmbeddingTripletBank,
  embed: EmbedFn,
): Promise<EmbeddingReliability> {
  const out: EmbeddingReliability = {};
  for (const lang of ['fr', 'zh', 'en'] as const) {
    const arr = bank.triplets?.[lang];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const texts: string[] = [];
    for (const t of arr) texts.push(t.anchor, t.positive, t.negative);
    const v = await embed(texts);
    if (v.length !== texts.length)
      throw new Error(
        `measureEmbeddingReliability: ${v.length}/${texts.length} vectors (${lang})`,
      );
    let correct = 0;
    for (let i = 0; i < arr.length; i++) {
      const a = v[i * 3];
      const p = v[i * 3 + 1];
      const n = v[i * 3 + 2];
      if (cosine(a, p) > cosine(a, n)) correct++;
    }
    out[lang] = correct / arr.length;
  }
  return out;
}

// --- projector gate ----------------------------------------------------------

/**
 * SPEC §4 gate. Use the embedding projection only if every MEASURED
 * language meets the threshold AND fr & zh are both measured and pass
 * (the spec calls them out explicitly — a routing query is often fr/zh
 * here). Otherwise fall back to the deterministic R5 projector. Never
 * throws, never blocks: it only chooses a path.
 */
export function projectorGate(
  rel: EmbeddingReliability,
  threshold: number = DEFAULT_EMBEDDING_RELIABILITY_THRESHOLD,
): ProjectorGate {
  const langs = Object.keys(rel) as ('fr' | 'zh' | 'en')[];
  if (langs.length === 0)
    return {
      useEmbedding: false,
      reason: 'embedding_reliability not measured → R5 fallback',
      perLang: rel,
    };
  for (const must of ['fr', 'zh'] as const) {
    const v = rel[must];
    if (v === undefined)
      return {
        useEmbedding: false,
        reason: `${must} reliability not measured → R5 fallback`,
        perLang: rel,
      };
    if (v < threshold)
      return {
        useEmbedding: false,
        reason: `${must} reliability ${v.toFixed(2)} < ${threshold} → R5 fallback`,
        perLang: rel,
      };
  }
  const weak = langs.find((l) => (rel[l] ?? 0) < threshold);
  if (weak)
    return {
      useEmbedding: false,
      reason: `${weak} reliability ${(rel[weak] ?? 0).toFixed(2)} < ${threshold} → R5 fallback`,
      perLang: rel,
    };
  return {
    useEmbedding: true,
    reason: `embedding reliable (≥ ${threshold} on ${langs.join('/')})`,
    perLang: rel,
  };
}
