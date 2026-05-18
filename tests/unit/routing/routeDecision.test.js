// Slice-5b-core projector switch — ported from smoke-routeDecision.ts. Dette B.
import { describe, expect, test } from '@playwright/test';
import { decideRoute } from '../../../src/main/modelhub/routing/routeDecision';
import anchors from '../../../src/main/modelhub/routing/questions/probe-anchors.json';
import triplets from '../../../src/main/modelhub/routing/questions/embedding-triplets.json';

const DIM = 256;
const oneHot = (i) => {
  const v = new Float32Array(DIM);
  v[i % DIM] = 1;
  return v;
};
function buildDict(goodTriplets) {
  const d = new Map();
  let k = 0;
  for (const b of Object.keys(anchors.branches))
    d.set(anchors.branches[b], oneHot(k++));
  for (const l of Object.keys(anchors.leaves))
    d.set(anchors.leaves[l], oneHot(k++));
  d.set('Q', d.get(anchors.leaves['code.python']));
  for (const lang of ['fr', 'zh', 'en'])
    for (const t of triplets.triplets[lang]) {
      const a = oneHot(k++);
      d.set(t.anchor, a);
      d.set(t.positive, goodTriplets ? a : oneHot(k++));
      d.set(t.negative, goodTriplets ? oneHot(k++) : a);
    }
  return d;
}
const sig = (behavioral, state = 'complete') => ({
  modelHash: 'h',
  structural: { est_footprint_bytes: 1000 },
  behavioral: {
    diagnostic_run: {},
    scores_per_axis: {},
    behavior_centroid: [],
    ...behavioral,
  },
  characterization_state: state,
  characterization_error: null,
  suite_version: 'tree-v0',
});
const candidates = [
  { id: 'A', signature: sig({ scores_per_leaf: { 'code.python': 3 } }) },
  { id: 'B', signature: sig({ scores_per_leaf: { 'math.algebre': 3 } }) },
];
const factoryFrom =
  (dict, counter) =>
  () =>
  async (texts) => {
    if (counter) {
      counter.n++;
      counter.texts += texts.length;
    }
    return texts.map((t) => dict.get(t) ?? new Float32Array(DIM));
  };
const freshCache = () => {
  const m = new Map();
  return {
    get: (id) => m.get(id),
    setAnchors: (id, a) => m.set(id, { ...m.get(id), anchors: a }),
    setReliability: (id, r) => m.set(id, { ...m.get(id), reliability: r }),
  };
};

describe('decideRoute (slice 5b-core)', () => {
  test('no embedder → R5', async () => {
    const r = await decideRoute({ query: 'x', candidates });
    expect(r.routedBy).toBe('r5');
    expect(/no routing embedder/.test(r.gateReason)).toBe(true);
    expect(!!r.axisWeights).toBe(true);
  });

  test('good embedder → vector, gate passes, code-strong wins', async () => {
    const r = await decideRoute({
      query: 'Q',
      candidates,
      embedder: { baseUrl: 'http://e' },
      anchors,
      triplets,
      embedFactory: factoryFrom(buildDict(true)),
      cache: freshCache(),
    });
    expect(r.routedBy).toBe('vector');
    expect(r.reliability.fr === 1 && r.reliability.zh === 1).toBe(true);
    expect(r.best?.id).toBe('A');
    expect(r.level['code']).toBe('leaf');
  });

  test('bad reliability → gate fails → R5', async () => {
    const r = await decideRoute({
      query: 'Q',
      candidates,
      embedder: { baseUrl: 'http://e' },
      anchors,
      triplets,
      embedFactory: factoryFrom(buildDict(false)),
      cache: freshCache(),
    });
    expect(r.routedBy).toBe('r5');
    expect(r.reliability.fr).toBe(0);
    expect(/reliability|fallback/i.test(r.gateReason)).toBe(true);
  });

  test('embed throws → R5 fallback with cause', async () => {
    const r = await decideRoute({
      query: 'Q',
      candidates,
      embedder: { baseUrl: 'http://e' },
      anchors,
      triplets,
      embedFactory: () => async () => {
        throw new Error('connection refused');
      },
      cache: freshCache(),
    });
    expect(r.routedBy).toBe('r5');
    expect(/embedding failed.*connection refused/.test(r.gateReason)).toBe(
      true,
    );
  });

  test('cache (dette C): hot route embeds only the query', async () => {
    const counter = { n: 0, texts: 0 };
    const cache = freshCache();
    const opts = {
      query: 'Q',
      candidates,
      embedder: { baseUrl: 'http://e' },
      anchors,
      triplets,
      embedFactory: factoryFrom(buildDict(true), counter),
      cache,
    };
    await decideRoute(opts);
    const afterWarm = counter.texts;
    await decideRoute(opts);
    expect(afterWarm >= 55).toBe(true);
    expect(counter.texts - afterWarm).toBe(1);
  });

  test('threshold override ⇒ vector despite weak fr', async () => {
    const midDict = buildDict(true);
    for (const t of triplets.triplets.fr)
      midDict.set(t.positive, new Float32Array(DIM));
    const r = await decideRoute({
      query: 'Q',
      candidates,
      embedder: { baseUrl: 'http://e' },
      anchors,
      triplets,
      embedFactory: factoryFrom(midDict),
      cache: freshCache(),
      params: { embeddingReliabilityThreshold: 0.0 },
    });
    expect(r.routedBy).toBe('vector');
  });
});
