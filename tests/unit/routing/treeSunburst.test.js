// Slice 6c / slice 8a — competence-tree readout model (pure, D7). Honest
// provenance (rung | prior | none) consistent with the R5 radar (θ_open
// gate). Two scoring schemes coexist: legacy `breaking-rung-v0` (integer
// 1..3 with /TREE_MAX_RUNG normalisation) and current `beta-laplace-v1`
// (smoothed (1+passes)/(2+asked) ∈ (0,1]).
import { describe, expect, test } from '@playwright/test';
import {
  treeDataFromSignature,
  hasTreeData,
  treeBreakdownText,
  barFill,
  branchProvenance,
  leafProvenance,
  measuredRadarData,
  buildLeafRadar,
  MIN_RADAR_AXES,
  TREE_MAX_RUNG,
  TREE_THETA_OPEN,
  PRIOR_BAR_CAP,
  BETA_LAPLACE_SATURATION,
} from '../../../src/renderer/modelhub/radar/treeSunburstGeometry';
import { COMPETENCE_TREE } from '../../../src/shared/RoutingTypes';

const TOTAL_LEAVES = Object.values(COMPETENCE_TREE).reduce(
  (s, l) => s + l.length,
  0,
);
const TOTAL_BRANCHES = Object.keys(COMPETENCE_TREE).length;

describe('treeDataFromSignature (slice 6c / 8a)', () => {
  test('always the full frozen shape; unmeasured ⇒ null, never 0', () => {
    const d = treeDataFromSignature({
      scores_per_leaf: { 'math.proba': 3, 'code.cpp': 1.5 },
      branch_scores: { math: 0.9 },
      n_per_leaf: { 'math.proba': 2 },
      scoring_scheme: 'breaking-rung-v0',
    });
    expect(d.length).toBe(TOTAL_BRANCHES);
    expect(d.reduce((s, b) => s + b.leaves.length, 0)).toBe(TOTAL_LEAVES);
    const math = d.find((b) => b.branch === 'math');
    expect(math.score === 0.9 && math.opened === true).toBe(true);
    const proba = math.leaves.find((l) => l.leaf === 'proba');
    expect(proba.score === 3 && proba.n === 2).toBe(true);
    expect(math.leaves.find((l) => l.leaf === 'algebre').score).toBe(null);
    const code = d.find((b) => b.branch === 'code');
    expect(code.score).toBe(null);
    expect(code.leaves.find((l) => l.leaf === 'cpp').score).toBe(1.5);
  });

  test('resilient to absent / partial signature', () => {
    expect(treeDataFromSignature(undefined).length).toBe(TOTAL_BRANCHES);
    expect(treeDataFromSignature(null)[0].leaves[0].score).toBe(null);
    expect(treeDataFromSignature({}).length).toBe(TOTAL_BRANCHES);
  });

  test('beta-laplace-v1: passes threaded; absent passes ⇒ undefined', () => {
    const d = treeDataFromSignature({
      scores_per_leaf: { 'math.proba': 0.8 },
      branch_scores: { math: 0.9 },
      n_per_leaf: { 'math.proba': 3 },
      passes_per_leaf: { 'math.proba': 3 },
      scoring_scheme: 'beta-laplace-v1',
    });
    const proba = d
      .find((b) => b.branch === 'math')
      .leaves.find((l) => l.leaf === 'proba');
    expect(proba.passes).toBe(3);
    expect(proba.n).toBe(3);
    const algebre = d
      .find((b) => b.branch === 'math')
      .leaves.find((l) => l.leaf === 'algebre');
    expect(algebre.passes).toBe(undefined);
  });
});

describe('hasTreeData (slice 6c)', () => {
  test('false unless a finite leaf/branch score exists', () => {
    expect(hasTreeData(undefined)).toBe(false);
    expect(hasTreeData({})).toBe(false);
    expect(hasTreeData({ scores_per_leaf: {}, branch_scores: {} })).toBe(false);
    expect(hasTreeData({ scores_per_leaf: { 'math.proba': 0 } })).toBe(true);
    expect(hasTreeData({ branch_scores: { code: 0.5 } })).toBe(true);
  });
});

describe('provenance follows θ_open — consistent with the R5 radar', () => {
  test('branchProvenance: ≥θ_open rung, <θ_open prior, null none', () => {
    expect(branchProvenance(1)).toBe('rung');
    expect(branchProvenance(TREE_THETA_OPEN)).toBe('rung');
    expect(branchProvenance(TREE_THETA_OPEN - 0.01)).toBe('prior');
    expect(branchProvenance(null)).toBe('none');
  });

  test('leafProvenance breaking-rung-v0: integer=rung, else prior/none', () => {
    // branch deepened (1 ≥ θ_open)
    expect(leafProvenance(1, 3, 'breaking-rung-v0', false)).toBe('rung');
    expect(leafProvenance(1, 1.5, 'breaking-rung-v0', false)).toBe('prior');
    // branch closed (< θ_open) ⇒ anything is a prior
    expect(leafProvenance(0.2, 3, 'breaking-rung-v0', false)).toBe('prior');
    expect(leafProvenance(null, 0.5, 'breaking-rung-v0', false)).toBe('prior');
    expect(leafProvenance(1, null, 'breaking-rung-v0', false)).toBe('none');
  });

  test('leafProvenance beta-laplace-v1: passes presence drives rung', () => {
    // branch deepened + passes ⇒ real climb
    expect(leafProvenance(1, 0.8, 'beta-laplace-v1', true)).toBe('rung');
    // branch deepened + NO passes (QCM prior discounted in same map) ⇒ prior
    expect(leafProvenance(1, 0.5, 'beta-laplace-v1', false)).toBe('prior');
    // un-deepened branch ⇒ anything is a prior, even with passes
    expect(leafProvenance(0.2, 0.8, 'beta-laplace-v1', true)).toBe('prior');
    expect(leafProvenance(1, null, 'beta-laplace-v1', true)).toBe('none');
  });
});

describe('barFill — honest weights (slice 6c / 8a)', () => {
  test('breaking-rung-v0: rung ∝ score/3, prior capped, none 0', () => {
    expect(barFill('math', TREE_MAX_RUNG, 'rung', 'breaking-rung-v0')).toBe(1);
    expect(barFill('math', 1.5, 'rung', 'breaking-rung-v0')).toBeCloseTo(
      0.5,
      5,
    );
    expect(barFill('safety', 1, 'rung', 'breaking-rung-v0')).toBe(1);
    expect(barFill('math', 3, 'prior', 'breaking-rung-v0')).toBe(PRIOR_BAR_CAP);
    expect(barFill('math', 0.5, 'prior', 'breaking-rung-v0')).toBeLessThanOrEqual(
      PRIOR_BAR_CAP,
    );
    expect(barFill('math', 3, 'none', 'breaking-rung-v0')).toBe(0);
    expect(barFill('math', null, 'none', 'breaking-rung-v0')).toBe(0);
  });

  test('beta-laplace-v1: rung ∝ score (no /3), prior capped', () => {
    expect(barFill('math', 1, 'rung', 'beta-laplace-v1')).toBe(1);
    expect(barFill('math', 0.8, 'rung', 'beta-laplace-v1')).toBeCloseTo(0.8, 5);
    expect(BETA_LAPLACE_SATURATION).toBeCloseTo(0.8, 5);
    expect(barFill('safety', 1, 'rung', 'beta-laplace-v1')).toBe(1);
    expect(barFill('math', 0.5, 'prior', 'beta-laplace-v1')).toBeLessThanOrEqual(
      PRIOR_BAR_CAP,
    );
  });

  test('treeDataFromSignature wires provenance + fill end-to-end', () => {
    const d = treeDataFromSignature({
      branch_scores: { math: 1, format: TREE_THETA_OPEN - 0.1 },
      scores_per_leaf: {
        'math.proba': TREE_MAX_RUNG, // deepened + integer ⇒ rung
        'math.algebre': 1.5, // deepened + fractional ⇒ prior
        'format.json-strict': 0.5, // closed branch ⇒ prior
      },
      scoring_scheme: 'breaking-rung-v0',
    });
    const leaf = (br, lf) =>
      d.find((b) => b.branch === br).leaves.find((l) => l.leaf === lf);
    expect(leaf('math', 'proba')).toMatchObject({
      provenance: 'rung',
      fill: 1,
    });
    expect(leaf('math', 'algebre').provenance).toBe('prior');
    expect(leaf('math', 'algebre').fill).toBeLessThanOrEqual(PRIOR_BAR_CAP);
    expect(leaf('format', 'json-strict').provenance).toBe('prior');
    expect(leaf('math', 'geometrie')).toMatchObject({
      provenance: 'none',
      fill: 0,
      score: null,
    });
    expect(d.find((b) => b.branch === 'code').provenance).toBe('none');
  });

  test('beta-laplace-v1 end-to-end: passes drives rung vs prior', () => {
    const d = treeDataFromSignature({
      branch_scores: { math: 1 },
      scores_per_leaf: {
        // staircase-measured (passes threaded): real climb
        'math.proba': 0.8,
        // staircase-measured, partial climb
        'math.algebre': 0.5,
        // qcm-prior (no passes entry, fractional value): prior
        'math.geometrie': 0.36,
      },
      passes_per_leaf: {
        'math.proba': 3,
        'math.algebre': 1,
      },
      n_per_leaf: {
        'math.proba': 3,
        'math.algebre': 2,
        'math.geometrie': 1,
      },
      scoring_scheme: 'beta-laplace-v1',
    });
    const math = d.find((b) => b.branch === 'math');
    const proba = math.leaves.find((l) => l.leaf === 'proba');
    const algebre = math.leaves.find((l) => l.leaf === 'algebre');
    const geo = math.leaves.find((l) => l.leaf === 'geometrie');
    expect(proba.provenance).toBe('rung');
    expect(proba.fill).toBeCloseTo(0.8, 5); // no /3 compression
    expect(algebre.provenance).toBe('rung'); // partial climb is still a climb
    expect(geo.provenance).toBe('prior'); // qcm-prior path (no passes entry)
    expect(geo.fill).toBeLessThanOrEqual(PRIOR_BAR_CAP);
  });
});

describe('treeBreakdownText (slice 6c / 8a)', () => {
  test('legacy: copyable R5 state, ~qcm-prior tag, — for none', () => {
    const txt = treeBreakdownText(
      treeDataFromSignature({
        scores_per_leaf: { 'math.proba': 3, 'math.algebre': 0.5 },
        branch_scores: { math: 0.9, format: 0.1 },
        n_per_leaf: { 'math.proba': 2 },
        scoring_scheme: 'breaking-rung-v0',
      }),
    );
    expect(txt.includes('math  [R5 0.90 · deepened]')).toBe(true);
    expect(txt.includes('proba = 3.00 (n2)')).toBe(true);
    expect(txt.includes('algebre = 0.50') && txt.includes('~qcm-prior')).toBe(
      true,
    );
    expect(txt.includes('format  [R5 0.10 · closed (prior only)]')).toBe(true);
    expect(txt.includes('code  [R5 — · no R5 data]')).toBe(true);
    expect(txt.includes('geometrie = —')).toBe(true);
  });

  test('beta-laplace-v1: shows passes/n counts when both present', () => {
    const txt = treeBreakdownText(
      treeDataFromSignature({
        scores_per_leaf: { 'math.proba': 0.8 },
        branch_scores: { math: 0.9 },
        passes_per_leaf: { 'math.proba': 3 },
        n_per_leaf: { 'math.proba': 3 },
        scoring_scheme: 'beta-laplace-v1',
      }),
    );
    expect(txt.includes('proba = 0.80 (3/3)')).toBe(true);
  });
});

describe('measured-only radar — fully-mastered (user 2026-05-19)', () => {
  // BREAKING-RUNG-V0 path: code & safety deepened. Only fully-mastered
  // leaves (normalised value === 1 ⇒ top rung) enter the chart.
  const legacyData = treeDataFromSignature({
    branch_scores: { code: 1, safety: 1, math: 0.2 },
    scores_per_leaf: {
      'code.cpp': TREE_MAX_RUNG, // 100% ⇒ kept
      'code.sql': TREE_MAX_RUNG, // 100% ⇒ kept
      'code.web': TREE_MAX_RUNG, // 100% ⇒ kept
      'code.algo-dur': 2, // rung 2 (66%) ⇒ NOT maximal ⇒ excluded
      'code.python': 0.5, // fractional ⇒ prior ⇒ excluded
      'safety.non-censure': 1, // safety pass (100%) ⇒ kept (but safety excluded)
      'math.proba': 3, // closed branch ⇒ prior ⇒ excluded
    },
    n_per_leaf: { 'code.cpp': 3 },
    scoring_scheme: 'breaking-rung-v0',
  });

  test('breaking-rung-v0: keeps ONLY value=1 leaves; safety excluded', () => {
    const items = measuredRadarData(legacyData, 'breaking-rung-v0');
    expect(items.map((i) => i.label).sort()).toEqual([
      'code·cpp',
      'code·sql',
      'code·web',
    ]);
    expect(items.every((i) => i.value === 1)).toBe(true);
    expect(items.find((i) => i.label === 'code·cpp').n).toBe(3);
    expect(items.some((i) => i.label.includes('algo-dur'))).toBe(false);
    expect(items.some((i) => i.label.includes('python'))).toBe(false);
    expect(items.some((i) => i.label.includes('proba'))).toBe(false);
    expect(items.some((i) => i.label.startsWith('safety'))).toBe(false);
  });

  test('buildLeafRadar: null when < MIN_RADAR_AXES, else deterministic', () => {
    const items = measuredRadarData(legacyData, 'breaking-rung-v0');
    expect(buildLeafRadar(items.slice(0, 2))).toBe(null);
    expect(MIN_RADAR_AXES).toBe(3);
    const g = buildLeafRadar(items);
    expect(g).not.toBe(null);
    expect(g.axes.length).toBe(3);
    expect(g.valuePolygon.length).toBe(3);
    expect(g.rings.length).toBe(4);
    expect(buildLeafRadar(items)).toEqual(g); // pure
  });

  test('breaking-rung-v0: empty when no leaf is fully mastered', () => {
    const weak = treeDataFromSignature({
      branch_scores: { code: 1 },
      scores_per_leaf: { 'code.cpp': 2, 'code.sql': 1 }, // none == 100%
      scoring_scheme: 'breaking-rung-v0',
    });
    expect(measuredRadarData(weak, 'breaking-rung-v0')).toEqual([]);
    expect(buildLeafRadar(measuredRadarData(weak, 'breaking-rung-v0'))).toBe(
      null,
    );
  });

  // BETA-LAPLACE-V1 path: a leaf is "fully mastered" iff `passes === n`
  // and `n > 0` — the Beta-Laplace value saturates at 0.8 for a 3-item
  // climb (no Phase B), so `value === 1` would never trigger.
  const modernData = treeDataFromSignature({
    branch_scores: { code: 1, math: 0.2 },
    scores_per_leaf: {
      'code.cpp': 0.8, // full climb 3/3
      'code.sql': 0.8, // full climb 3/3
      'code.web': 0.8, // full climb 3/3
      'code.algo-dur': 0.5, // partial climb 1/2 ⇒ measured but not mastered
      'code.python': 0.3, // no passes entry ⇒ qcm-prior ⇒ excluded
      'math.proba': 0.6, // closed branch ⇒ prior
    },
    passes_per_leaf: {
      'code.cpp': 3,
      'code.sql': 3,
      'code.web': 3,
      'code.algo-dur': 1,
    },
    n_per_leaf: {
      'code.cpp': 3,
      'code.sql': 3,
      'code.web': 3,
      'code.algo-dur': 2,
    },
    scoring_scheme: 'beta-laplace-v1',
  });

  test('beta-laplace-v1: keeps ONLY passes===n leaves; partial excluded', () => {
    const items = measuredRadarData(modernData, 'beta-laplace-v1');
    expect(items.map((i) => i.label).sort()).toEqual([
      'code·cpp',
      'code·sql',
      'code·web',
    ]);
    expect(items.every((i) => i.value === BETA_LAPLACE_SATURATION)).toBe(true);
    expect(items.some((i) => i.label.includes('algo-dur'))).toBe(false);
    expect(items.some((i) => i.label.includes('python'))).toBe(false);
    expect(items.some((i) => i.label.includes('proba'))).toBe(false);
  });

  test('beta-laplace-v1: empty when no leaf has passes===n', () => {
    const weak = treeDataFromSignature({
      branch_scores: { code: 1 },
      scores_per_leaf: { 'code.cpp': 0.5, 'code.sql': 0.67 },
      passes_per_leaf: { 'code.cpp': 1, 'code.sql': 2 },
      n_per_leaf: { 'code.cpp': 2, 'code.sql': 3 },
      scoring_scheme: 'beta-laplace-v1',
    });
    expect(measuredRadarData(weak, 'beta-laplace-v1')).toEqual([]);
  });
});
