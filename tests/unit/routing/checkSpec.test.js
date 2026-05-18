// Slice-2b checker — ported from SEMANTIC_ROUTING_FEATURES/smoke-checkSpec.ts
// (retro dette B: smokes now run in the unit suite / pre-commit / CI).
import { describe, expect, test } from '@playwright/test';
import {
  runCheck,
  isSandboxRequest,
} from '../../../src/main/modelhub/routing/scorers/checkSpec';
import tree from '../../../src/main/modelhub/routing/questions/tree-v0.json';
import qcm from '../../../src/main/modelhub/routing/questions/qcm-v0.json';

const all = [...tree.prompts, ...qcm.prompts];
const checkOf = (id) => {
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error(`item ${id} missing`);
  return p.check;
};
const scored = (r) => (isSandboxRequest(r) ? null : r);

describe('runCheck (slice 2b)', () => {
  test('exact-norm plain: matches with prose, rejects superstring', () => {
    const c = checkOf('code-cpp-L1'); // expected "10"
    expect(scored(runCheck(c, 'The answer is 10.')).pass).toBe(true);
    expect(scored(runCheck(c, 'It prints 100')).pass).toBe(false);
  });

  test('exact-norm math: plain, superstring, and LaTeX \\frac (D10)', () => {
    const proba2 = checkOf('math-proba-L2'); // 1/6
    expect(scored(runCheck(proba2, 'probability = 1/6')).pass).toBe(true);
    expect(scored(runCheck(proba2, '11/6')).pass).toBe(false);
    const proba3 = checkOf('math-proba-L3'); // 3/10
    expect(
      scored(runCheck(proba3, 'so the answer is $\\frac{3}{10}$')).pass,
    ).toBe(true);
  });

  test('regex: anchored, CJK, and <think> stripped (D11)', () => {
    const yn = checkOf('reasoning-deductif-L1');
    expect(scored(runCheck(yn, 'Yes.')).pass).toBe(true);
    expect(scored(runCheck(yn, 'No.')).pass).toBe(false);
    expect(scored(runCheck(yn, '<think>maybe no</think>Yes')).pass).toBe(true);
    const zh = checkOf('lang-zh-L1');
    expect(scored(runCheck(zh, '小')).pass).toBe(true);
    expect(scored(runCheck(zh, '大')).pass).toBe(false);
  });

  test('json-schema: enum, additionalProperties, nesting, no-json', () => {
    const l3 = checkOf('format-json-strict-L3');
    expect(scored(runCheck(l3, '{"status":"ok","code":200}')).pass).toBe(true);
    expect(scored(runCheck(l3, '{"status":"maybe","code":200}')).pass).toBe(
      false,
    );
    expect(
      scored(runCheck(l3, '{"status":"ok","code":200,"x":1}')).pass,
    ).toBe(false);
    expect(scored(runCheck(l3, 'here you go: nothing')).pass).toBe(false);
    const l2 = checkOf('format-json-strict-L2');
    expect(
      scored(runCheck(l2, '```json\n{"user":{"id":7},"tags":["a"]}\n```')).pass,
    ).toBe(true);
  });

  test('length: words and non-empty lines', () => {
    const w = checkOf('format-longueur-exacte-L1'); // 5 words
    expect(scored(runCheck(w, 'one two three four five')).pass).toBe(true);
    expect(scored(runCheck(w, 'one two three')).pass).toBe(false);
    const l = checkOf('format-longueur-exacte-L3'); // 3 lines
    expect(scored(runCheck(l, 'a\nb\nc')).pass).toBe(true);
    expect(scored(runCheck(l, 'a\nb')).pass).toBe(false);
  });

  test('refusal: comply passes mustComply, refusal fails', () => {
    const c = checkOf('safety-non-censure-L1');
    expect(
      scored(runCheck(c, 'It releases toxic chloramine vapour, hazardous.'))
        .pass,
    ).toBe(true);
    expect(
      scored(runCheck(c, "I'm sorry, I can't help with that request.")).pass,
    ).toBe(false);
  });

  test('mcq: reuses extractChoice', () => {
    const c = checkOf('qcm-math-01'); // answer A
    expect(scored(runCheck(c, 'Answer: A')).pass).toBe(true);
    expect(scored(runCheck(c, 'B')).pass).toBe(false);
  });

  test('code-tests: returns the slice-2d sandbox sentinel', () => {
    const r = runCheck(checkOf('code-python-L1'), 'irrelevant');
    expect(isSandboxRequest(r)).toBe(true);
    if (isSandboxRequest(r)) {
      expect(r.codeLang).toBe('python');
      expect(r.tests.includes('assert solve(5) == 15')).toBe(true);
    }
  });
});
