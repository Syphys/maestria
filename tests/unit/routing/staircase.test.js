// Slice-4a staircase engine — ported from smoke-staircase.ts. Retro dette B.
import { describe, expect, test } from '@playwright/test';
import {
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

describe('characterizeBranch (slice 4a)', () => {
  const math = groupBranch('math');

  test('all-correct ⇒ opened, every leaf rung 3, n=3', async () => {
    const m = await characterizeBranch('math', math, fake('correct'));
    expect(m.opened && m.branch_score === 1).toBe(true);
    expect(
      Object.keys(math).every((l) => m.scores_per_leaf[l] === 3) &&
        Object.keys(m.scores_per_leaf).length === 5,
    ).toBe(true);
    expect(Object.values(m.n_per_leaf).every((n) => n === 3)).toBe(true);
  });

  test('weak (L1 only) ⇒ opened, breaking rung 1, n=2', async () => {
    const m = await characterizeBranch('math', math, fake('weak'));
    expect(
      m.opened && Object.keys(math).every((l) => m.scores_per_leaf[l] === 1),
    ).toBe(true);
    expect(Object.values(m.n_per_leaf).every((n) => n === 2)).toBe(true);
  });

  test('fail ⇒ branch_score 0 < θ_open ⇒ closed', async () => {
    const m = await characterizeBranch('math', math, fake('fail'));
    expect(
      !m.opened &&
        m.branch_score === 0 &&
        Object.keys(m.scores_per_leaf).length === 0,
    ).toBe(true);
  });

  test('code no-sandbox: exact-norm leaves climb, code-tests unmeasured', async () => {
    const code = groupBranch('code');
    const m = await characterizeBranch('code', code, fake('correct'));
    expect(
      m.scores_per_leaf['code.cpp'] === 3 &&
        m.scores_per_leaf['code.sql'] === 3 &&
        m.scores_per_leaf['code.web'] === 3,
    ).toBe(true);
    expect(
      m.unmeasured['code.python'] === 'sandbox-pending' &&
        m.unmeasured['code.algo-dur'] === 'sandbox-pending' &&
        m.unmeasured['code.generic'] === 'sandbox-pending',
    ).toBe(true);
    expect(m.branch_score).toBe(1);
  });

  test('code +runSandbox: all 6 leaves measured rung 3', async () => {
    const code = groupBranch('code');
    const m = await characterizeBranch('code', code, fake('correct'), {
      seams: { runSandbox: async () => true },
    });
    expect(
      Object.keys(code).every((l) => m.scores_per_leaf[l] === 3) &&
        Object.keys(m.unmeasured).length === 0,
    ).toBe(true);
  });

  test('safety binary (n=1) comply→1, refuse→closed', async () => {
    const safety = groupBranch('safety');
    let m = await characterizeBranch('safety', safety, fake('correct'));
    expect(
      m.opened &&
        m.scores_per_leaf['safety.non-censure'] === 1 &&
        m.n_per_leaf['safety.non-censure'] === 1,
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
