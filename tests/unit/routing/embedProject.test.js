// Slice-3c/5b embedding projector — ported from smoke-embedProject.ts
// + anchorOrder/projectFromVectors (added in slice 5b-core). Retro dette B.
import { describe, expect, test } from '@playwright/test';
import {
  l2normalize,
  cosine,
  projectQuery,
  projectFromVectors,
  anchorOrder,
  measureEmbeddingReliability,
  projectorGate,
} from '../../../src/main/modelhub/routing/embedProject';
import anchors from '../../../src/main/modelhub/routing/questions/probe-anchors.json';
import triplets from '../../../src/main/modelhub/routing/questions/embedding-triplets.json';

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
const DIM = 64;
const oneHot = (i) => {
  const v = new Float32Array(DIM);
  v[i % DIM] = 1;
  return v;
};

describe('embedProject vector math', () => {
  test('l2normalize: unit + zero-safe', () => {
    const u = l2normalize(new Float32Array([3, 4]));
    expect(near(u[0], 0.6) && near(u[1], 0.8)).toBe(true);
    expect(l2normalize(new Float32Array([0, 0]))[0]).toBe(0);
  });
  test('cosine: self/orthogonal/opposite/length-mismatch', () => {
    const u = l2normalize(new Float32Array([3, 4]));
    expect(near(cosine(u, u), 1)).toBe(true);
    expect(
      near(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0),
    ).toBe(true);
    expect(
      near(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])), -1),
    ).toBe(true);
    expect(
      near(cosine(new Float32Array([1, 0, 9]), new Float32Array([1, 0])), 1),
    ).toBe(true);
  });
});

describe('projectQuery / projectFromVectors', () => {
  const dict = new Map();
  let k = 0;
  for (const b of Object.keys(anchors.branches))
    dict.set(anchors.branches[b], oneHot(k++));
  for (const l of Object.keys(anchors.leaves))
    dict.set(anchors.leaves[l], oneHot(k++));
  dict.set('___q___', dict.get(anchors.leaves['code.python']));
  const fake = async (texts) =>
    texts.map((t) => dict.get(t) ?? new Float32Array(DIM));

  test('projectQuery: query==code.python anchor ⇒ that leaf ≈ 1', async () => {
    const p = await projectQuery('___q___', anchors, fake);
    expect(near(p.leaves['code.python'], 1)).toBe(true);
    expect(near(p.leaves['math.proba'], 0)).toBe(true);
    expect(
      Object.keys(p.branches).length === 7 &&
        Object.keys(p.leaves).length === 23,
    ).toBe(true);
  });

  test('projectFromVectors: cached anchors give the same projection', async () => {
    const { branchIds, leafIds, texts } = anchorOrder(anchors);
    const anchorVecs = await fake(texts);
    const [qv] = await fake(['___q___']);
    const p = projectFromVectors(qv, anchorVecs, branchIds, leafIds);
    expect(near(p.leaves['code.python'], 1)).toBe(true);
    expect(branchIds.length === 7 && leafIds.length === 23).toBe(true);
  });
});

describe('measureEmbeddingReliability + projectorGate', () => {
  test('good embedder ⇒ 1.0 all langs; bad ⇒ 0.0', async () => {
    const good = new Map();
    let g = 0;
    for (const lang of ['fr', 'zh', 'en'])
      for (const t of triplets.triplets[lang]) {
        const s = oneHot(g++);
        good.set(t.anchor, s);
        good.set(t.positive, s);
        good.set(t.negative, oneHot(g++));
      }
    const rg = await measureEmbeddingReliability(triplets, async (xs) =>
      xs.map((x) => good.get(x) ?? new Float32Array(DIM)),
    );
    expect(rg.fr === 1 && rg.zh === 1 && rg.en === 1).toBe(true);
    const cst = oneHot(0);
    const rb = await measureEmbeddingReliability(triplets, async (xs) =>
      xs.map(() => cst),
    );
    expect(rb.fr === 0 && rb.zh === 0 && rb.en === 0).toBe(true);
  });

  test('gate: good→use; fr below/zh missing/empty→fallback; threshold', () => {
    expect(projectorGate({ fr: 0.9, zh: 0.85, en: 0.95 }).useEmbedding).toBe(
      true,
    );
    expect(projectorGate({ fr: 0.5, zh: 0.9, en: 0.9 }).useEmbedding).toBe(
      false,
    );
    expect(projectorGate({ fr: 0.9, en: 0.9 }).useEmbedding).toBe(false);
    expect(projectorGate({}).useEmbedding).toBe(false);
    expect(
      projectorGate({ fr: 0.6, zh: 0.6, en: 0.6 }, 0.5).useEmbedding,
    ).toBe(true);
  });
});
