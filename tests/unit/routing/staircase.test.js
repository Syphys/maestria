// Slice-4a staircase engine — ported from smoke-staircase.ts. Retro dette B.
// Étape 1 (2026-05): leaf scores are now Beta-Laplace `(1+passes)/(2+asked)`,
// not breaking-rung integers. 3/3 ⇒ 4/5 = 0.8 (was 3); 1/2 ⇒ 2/4 = 0.5
// (was 1). `safety` stays binary 0/1 (single item, no smoothing).
import { describe, expect, test } from '@playwright/test';
import {
  betaLaplace,
  characterizeBranch,
  evaluateItem,
} from '../../../src/main/modelhub/routing/staircase';
import tree from '../../../src/main/modelhub/routing/questions/tree-v0.json';

const prompts = tree.prompts;
const byId = Object.fromEntries(prompts.map((p) => [p.id, p]));
const groupBranch = (branch) => {
  const out = {};
  for (const p of prompts)
    if (p.leaf && p.leaf.startsWith(branch + '.')) (out[p.leaf] ??= []).push(p);
  return out;
};
const goldFor = (item) => {
  const c = item.check;
  if (!c) return '';
  if (c.kind === 'exact-norm') return c.expected;
  if (c.kind === 'mcq') return c.answer;
  if (c.kind === 'refusal')
    return 'It releases toxic chloramine vapour, hazardous.';
  return '';
};
const fake = (mode) => ({
  async complete(_p, ctx) {
    const item = byId[ctx.id];
    if (mode === 'fail') return 'WRONG-ANSWER';
    if (mode === 'refuse') return "I'm sorry, I can't help with that.";
    if (mode === 'weak' && (item.level ?? 1) !== 1) return 'WRONG-ANSWER';
    return goldFor(item);
  },
});

describe('betaLaplace (étape 1)', () => {
  test('matches the `(1+x)/(n+2)` Laplace rule of succession', () => {
    expect(betaLaplace(0, 0)).toBe(0.5); // prior
    expect(betaLaplace(1, 1)).toBeCloseTo(2 / 3, 6);
    expect(betaLaplace(0, 1)).toBeCloseTo(1 / 3, 6);
    expect(betaLaplace(3, 3)).toBe(0.8); // 3/3 caps at 0.8 (no false 1.0)
    expect(betaLaplace(8, 8)).toBeCloseTo(9 / 10, 6); // Phase B can lift it
  });
});

describe('characterizeBranch (slice 4a + étape 1)', () => {
  const math = groupBranch('math');

  test('all-correct ⇒ opened, every leaf Beta(3,3)=0.8, n=3', async () => {
    const m = await characterizeBranch('math', math, fake('correct'));
    expect(m.opened && m.branch_score === 1).toBe(true);
    expect(
      Object.keys(math).every((l) => m.scores_per_leaf[l] === 0.8) &&
        Object.keys(m.scores_per_leaf).length === 5,
    ).toBe(true);
    expect(Object.values(m.n_per_leaf).every((n) => n === 3)).toBe(true);
    expect(Object.values(m.passes_per_leaf).every((p) => p === 3)).toBe(true);
  });

  test('weak (L1 only) ⇒ opened, Beta(1,2)=0.5, n=2', async () => {
    const m = await characterizeBranch('math', math, fake('weak'));
    expect(
      m.opened && Object.keys(math).every((l) => m.scores_per_leaf[l] === 0.5),
    ).toBe(true);
    expect(Object.values(m.n_per_leaf).every((n) => n === 2)).toBe(true);
    expect(Object.values(m.passes_per_leaf).every((p) => p === 1)).toBe(true);
  });

  test('fail ⇒ branch_score 0 (raw gate) < θ_open ⇒ closed', async () => {
    const m = await characterizeBranch('math', math, fake('fail'));
    expect(
      !m.opened &&
        m.branch_score === 0 &&
        Object.keys(m.scores_per_leaf).length === 0,
    ).toBe(true);
  });

  test('code no-sandbox: exact-norm leaves climb to 0.8, code-tests unmeasured', async () => {
    const code = groupBranch('code');
    const m = await characterizeBranch('code', code, fake('correct'));
    expect(
      m.scores_per_leaf['code.cpp'] === 0.8 &&
        m.scores_per_leaf['code.sql'] === 0.8 &&
        m.scores_per_leaf['code.web'] === 0.8,
    ).toBe(true);
    expect(
      m.unmeasured['code.python'] === 'sandbox-pending' &&
        m.unmeasured['code.algo-dur'] === 'sandbox-pending' &&
        m.unmeasured['code.generic'] === 'sandbox-pending',
    ).toBe(true);
    expect(m.branch_score).toBe(1); // raw 3/3 gate, NOT Beta-smoothed
  });

  test('code +runSandbox: all 6 leaves Beta(3,3)=0.8', async () => {
    const code = groupBranch('code');
    const m = await characterizeBranch('code', code, fake('correct'), {
      seams: { runSandbox: async () => true },
    });
    expect(
      Object.keys(code).every((l) => m.scores_per_leaf[l] === 0.8) &&
        Object.keys(m.unmeasured).length === 0,
    ).toBe(true);
  });

  test('safety binary (n=1) comply→1, refuse→closed (NO Beta smoothing)', async () => {
    const safety = groupBranch('safety');
    let m = await characterizeBranch('safety', safety, fake('correct'));
    expect(
      m.opened &&
        m.scores_per_leaf['safety.non-censure'] === 1 &&
        m.n_per_leaf['safety.non-censure'] === 1 &&
        m.passes_per_leaf['safety.non-censure'] === 1,
    ).toBe(true);
    m = await characterizeBranch('safety', safety, fake('refuse'));
    expect(!m.opened && m.branch_score === 0).toBe(true);
  });

  test('longctx no-injector ⇒ runtime-inject unmeasured ⇒ closed', async () => {
    const m = await characterizeBranch(
      'longctx',
      groupBranch('longctx'),
      fake('correct'),
    );
    expect(m.branch_score === undefined && !m.opened).toBe(true);
    expect(
      m.unmeasured['longctx.needle-8k'] === 'runtime-inject' &&
        m.unmeasured['longctx.needle-32k'] === 'runtime-inject',
    ).toBe(true);
  });

  test('evaluateItem verdicts', async () => {
    const ex = byId['math-generic-L1'];
    expect((await evaluateItem(ex, fake('correct'))).status).toBe('pass');
    expect((await evaluateItem(ex, fake('fail'))).status).toBe('fail');
    const code = byId['code-python-L1'];
    let v = await evaluateItem(code, fake('correct'));
    expect(v.status === 'unmeasured' && v.reason === 'sandbox-pending').toBe(
      true,
    );
    v = await evaluateItem(code, fake('correct'), {
      runSandbox: async () => true,
    });
    expect(v.status).toBe('pass');
    v = await evaluateItem(byId['longctx-needle-8k-L1'], fake('correct'));
    expect(v.status === 'unmeasured' && v.reason === 'runtime-inject').toBe(
      true,
    );
  });
});

describe('characterizeBranch — R5-gated mode (slice 6a)', () => {
  const math = groupBranch('math');
  const counting = (mode) => {
    let n = 0;
    const inner = fake(mode);
    return {
      get calls() {
        return n;
      },
      ask: {
        async complete(p, ctx) {
          n++;
          return inner.complete(p, ctx);
        },
      },
    };
  };

  test('gate < θ_open ⇒ closed, ZERO model calls', async () => {
    const c = counting('correct');
    const m = await characterizeBranch('math', math, c.ask, {
      branchGate: 0.3,
    });
    expect(m.opened).toBe(false);
    expect(m.branch_score).toBe(0.3);
    expect(Object.keys(m.scores_per_leaf).length).toBe(0);
    expect(c.calls).toBe(0);
  });

  test('gate ≥ θ_open ⇒ opened, branch_score=gate, leaves Beta(3,3)=0.8', async () => {
    const m = await characterizeBranch('math', math, fake('correct'), {
      branchGate: 0.9,
    });
    expect(m.opened).toBe(true);
    expect(m.branch_score).toBe(0.9);
    expect(Object.keys(math).every((l) => m.scores_per_leaf[l] === 0.8)).toBe(
      true,
    );
  });

  test('gate absent ⇒ legacy self-probe (branch_score = fraction)', async () => {
    const m = await characterizeBranch('math', math, fake('correct'));
    expect(m.branch_score).toBe(1); // self-probe pass fraction, not a gate
  });

  test('gated-open code, no sandbox ⇒ code-tests leaves unmeasured', async () => {
    const code = groupBranch('code');
    const m = await characterizeBranch('code', code, fake('correct'), {
      branchGate: 0.8,
    });
    expect(
      m.scores_per_leaf['code.cpp'] === 0.8 &&
        m.scores_per_leaf['code.sql'] === 0.8 &&
        m.scores_per_leaf['code.web'] === 0.8,
    ).toBe(true);
    expect(m.unmeasured['code.python']).toBe('sandbox-pending');
  });
});
