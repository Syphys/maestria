// Slice-5a routeByVectors core — ported from smoke-routeByVectors.ts. Dette B.
import { describe, expect, test } from '@playwright/test';
import { routeByVectors } from '../../../src/main/modelhub/routing/routeByVectors';
import { COMPETENCE_TREE } from '../../../src/shared/RoutingTypes';

const near = (a, b) => Math.abs(a - b) < 1e-9;
function projection(leaves = {}, branches = {}) {
  const L = {};
  const B = {};
  for (const br of Object.keys(COMPETENCE_TREE)) {
    B[br] = branches[br] ?? 0;
    for (const lf of COMPETENCE_TREE[br]) L[`${br}.${lf}`] = leaves[`${br}.${lf}`] ?? 0;
  }
  return { leaves: L, branches: B };
}
const sig = (behavioral, state = 'complete', footprint = 1000) => ({
  modelHash: 'h',
  structural: { est_footprint_bytes: footprint },
  behavioral:
    behavioral === null
      ? null
      : {
          diagnostic_run: {},
          scores_per_axis: {},
          behavior_centroid: [],
          ...behavioral,
        },
  characterization_state: state,
  characterization_error: null,
  suite_version: 'tree-v0',
});

describe('routeByVectors (slice 5a §5)', () => {
  test('leaf-level argmax', () => {
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      { id: 'A', signature: sig({ scores_per_leaf: { 'code.python': 3 } }) },
      { id: 'B', signature: sig({ scores_per_leaf: { 'math.algebre': 3 } }) },
    ]);
    expect(r.level['code']).toBe('leaf');
    expect(r.best?.id).toBe('A');
    expect(near(r.ranked[0].competence, 1)).toBe(true);
    expect(
      near(r.ranked.find((x) => x.id === 'B').competence, 0),
    ).toBe(true);
  });

  test('branch-level fallback uses branch-mean prior', () => {
    const r = routeByVectors(projection({}, { math: 0.8 }), [
      { id: 'C', signature: sig({ branch_scores: { math: 0.9 } }) },
      {
        id: 'D',
        signature: sig({
          scores_per_leaf: { 'math.algebre': 3, 'math.proba': 3 },
        }),
      },
    ]);
    expect(r.level['math']).toBe('branch');
    expect(r.best?.id).toBe('D');
    expect(
      r.ranked[0].hits.some((h) => h.dim === 'math' && h.usedPrior),
    ).toBe(true);
  });

  test('D9: uncharacterized ranked last with reason', () => {
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      { id: 'E', signature: null },
      { id: 'A', signature: sig({ scores_per_leaf: { 'code.python': 3 } }) },
    ]);
    expect(r.best?.id).toBe('A');
    expect(r.ranked[r.ranked.length - 1].id).toBe('E');
    expect(r.ranked.find((x) => x.id === 'E').ineligibleReason).toBe(
      'not characterized',
    );
  });

  test('D12 leaf prior = branch_score × priorDiscount', () => {
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      { id: 'F', signature: sig({ branch_scores: { code: 0.8 } }) },
    ]);
    const fh = r.ranked[0].hits.find((h) => h.dim === 'code.python');
    expect(fh.usedPrior).toBe(true);
    expect(near(fh.v, 0.4)).toBe(true);
    expect(near(r.ranked[0].competence, 0.4)).toBe(true);
  });

  test('hot bonus breaks a competence tie', () => {
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      { id: 'G', signature: sig({ scores_per_leaf: { 'code.python': 3 } }) },
      {
        id: 'H',
        signature: sig({ scores_per_leaf: { 'code.python': 3 } }),
        running: true,
      },
    ]);
    expect(r.best?.id === 'H' && r.ranked[0].hot).toBe(true);
  });

  test('eligibility states: pending + failed ineligible', () => {
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      {
        id: 'P',
        signature: sig({ scores_per_leaf: { 'code.python': 3 } }, 'pending'),
      },
      { id: 'X', signature: sig({}, 'failed') },
    ]);
    expect(r.ranked.every((x) => !x.eligible) && r.best === undefined).toBe(
      true,
    );
    expect(r.ranked.find((x) => x.id === 'X').ineligibleReason).toBe(
      'quarantined (failed)',
    );
  });
});

describe('routeByVectors (slice 7d) — topic_coverage blending', () => {
  test('no topic_coverage ⇒ result identical to scores-only (back-compat)', () => {
    const candidates = [
      { id: 'A', signature: sig({ scores_per_leaf: { 'code.python': 1 } }) },
    ];
    const base = routeByVectors(projection({ 'code.python': 0.9 }), candidates);
    const blended = routeByVectors(
      projection({ 'code.python': 0.9 }),
      candidates,
      {},
      {},
      { topicCoverageWeight: 0.3 },
    );
    expect(near(base.ranked[0].competence, blended.ranked[0].competence)).toBe(
      true,
    );
  });

  test('blend α=0.7 / β=0.3: scores=1 + topic=0 ⇒ 0.7, scores=0 + topic=1 ⇒ 0.3', () => {
    const strong = sig({
      scores_per_leaf: { 'code.python': 1 },
      topic_coverage_per_leaf: { 'code.python': 0 },
    });
    const talker = sig({
      scores_per_leaf: { 'code.python': 0 },
      topic_coverage_per_leaf: { 'code.python': 1 },
    });
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      { id: 'strong', signature: strong },
      { id: 'talker', signature: talker },
    ]);
    expect(near(r.ranked[0].competence, 0.7)).toBe(true);
    expect(near(r.ranked[1].competence, 0.3)).toBe(true);
    expect(r.best?.id).toBe('strong'); // deterministic wins over talker
  });

  test('β=0 ⇒ topic_coverage IGNORED at routing time', () => {
    const talker = sig({
      scores_per_leaf: { 'code.python': 0 },
      topic_coverage_per_leaf: { 'code.python': 1 },
    });
    const r = routeByVectors(
      projection({ 'code.python': 0.9 }),
      [{ id: 'talker', signature: talker }],
      {},
      {},
      { topicCoverageWeight: 0 },
    );
    expect(near(r.ranked[0].competence, 0)).toBe(true); // pure scores-only
  });

  test('negative cosine clamps to 0 (no anti-routing)', () => {
    const m = sig({
      scores_per_leaf: { 'code.python': 0.5 },
      topic_coverage_per_leaf: { 'code.python': -0.4 },
    });
    const r = routeByVectors(projection({ 'code.python': 0.9 }), [
      { id: 'm', signature: m },
    ]);
    // α·0.5 + β·max(0,-0.4) = 0.7·0.5 + 0.3·0 = 0.35
    expect(near(r.ranked[0].competence, 0.35)).toBe(true);
  });
});
