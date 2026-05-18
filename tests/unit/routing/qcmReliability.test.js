// Slice-4b qcm_reliability — ported from smoke-qcmReliability.ts. Retro dette B.
import { describe, expect, test } from '@playwright/test';
import { measureQcmReliability } from '../../../src/main/modelhub/routing/qcmReliability';
import qcm from '../../../src/main/modelhub/routing/questions/qcm-v0.json';

const prompts = qcm.prompts;
const byId = Object.fromEntries(prompts.map((p) => [p.id, p]));
const near = (a, b) => Math.abs(a - b) < 1e-9;

// always picks the semantically-correct option, whatever letter it sits under
const smart = {
  async complete(prompt, ctx) {
    const item = byId[ctx.id.split('#')[0]];
    const correct = item.check.options[item.check.answer].trim();
    for (const line of prompt.split('\n')) {
      const m = line.match(/^\s*([A-Z])\)\s*(.*)$/);
      if (m && m[2].trim() === correct) return m[1];
    }
    return '?';
  },
};
const alwaysA = { async complete() { return 'The answer is A.'; } };
const garbage = { async complete() { return 'Hmm, hard to say really.'; } };

describe('measureQcmReliability (slice 4b §6bis + Dyy)', () => {
  test('smart: fa=1, cons=1, overall=1, all 7 leaf priors=1', async () => {
    const r = await measureQcmReliability(prompts, smart);
    expect(r.qcm_reliability.n).toBe(7);
    expect(near(r.qcm_reliability.format_adherence, 1)).toBe(true);
    expect(near(r.qcm_reliability.consistency, 1)).toBe(true);
    expect(near(r.qcm_reliability.overall, 1)).toBe(true);
    expect(
      Object.keys(r.leaf_priors).length === 7 &&
        Object.values(r.leaf_priors).every((v) => v === 1),
    ).toBe(true);
    expect(
      r.leaf_priors['code.python'] === 1 &&
        r.leaf_priors['safety.non-censure'] === 1,
    ).toBe(true);
  });

  test('alwaysA: position bias ⇒ cons=0, overall=0.5, prior only gold=A', async () => {
    const r = await measureQcmReliability(prompts, alwaysA);
    expect(near(r.qcm_reliability.format_adherence, 1)).toBe(true);
    expect(near(r.qcm_reliability.consistency, 0)).toBe(true);
    expect(near(r.qcm_reliability.overall, 0.5)).toBe(true);
    expect(
      r.leaf_priors['code.python'] === 1 &&
        r.leaf_priors['math.generic'] === 1 &&
        r.leaf_priors['reasoning.multi-step'] === 0 &&
        r.leaf_priors['safety.non-censure'] === 0,
    ).toBe(true);
  });

  test('garbage: everything 0', async () => {
    const r = await measureQcmReliability(prompts, garbage);
    expect(near(r.qcm_reliability.format_adherence, 0)).toBe(true);
    expect(near(r.qcm_reliability.consistency, 0)).toBe(true);
    expect(near(r.qcm_reliability.overall, 0)).toBe(true);
    expect(Object.values(r.leaf_priors).every((v) => v === 0)).toBe(true);
  });

  test('empty suite: zeroed, no throw', async () => {
    const r = await measureQcmReliability([], smart);
    expect(
      r.qcm_reliability.n === 0 &&
        r.qcm_reliability.overall === 0 &&
        Object.keys(r.leaf_priors).length === 0,
    ).toBe(true);
  });
});
