// Content integrity — ported from SEMANTIC_ROUTING_FEATURES/check-tree-v0.ts.
// Guards the frozen tree / suites / anchors / triplets against drift. Dette B.
import { describe, expect, test } from '@playwright/test';
import { COMPETENCE_TREE } from '../../../src/shared/RoutingTypes';
import tree from '../../../src/main/modelhub/routing/questions/tree-v0.json';
import qcm from '../../../src/main/modelhub/routing/questions/qcm-v0.json';
import anchors from '../../../src/main/modelhub/routing/questions/probe-anchors.json';
import triplets from '../../../src/main/modelhub/routing/questions/embedding-triplets.json';

const AXES = new Set([
  'code','math','reasoning','creative','fr','en','zh','vision','refusal',
  'fim','instruction','longctx','factual','multistep','meta',
]);
const CHECK_KINDS = new Set([
  'exact-norm','regex','json-schema','length','refusal','code-tests','mcq',
]);
const validLeaves = new Set();
for (const b of Object.keys(COMPETENCE_TREE))
  for (const lf of COMPETENCE_TREE[b]) validLeaves.add(`${b}.${lf}`);

describe('tree-v0 content', () => {
  test('per-prompt: ids unique, leaf/level/axes/check well-formed', () => {
    const fail = [];
    const ids = new Set();
    for (const p of tree.prompts) {
      if (ids.has(p.id)) fail.push(`dup id ${p.id}`);
      ids.add(p.id);
      if (!p.leaf || !validLeaves.has(p.leaf))
        fail.push(`${p.id}: bad leaf ${p.leaf}`);
      if (typeof p.level !== 'number' || p.level < 1)
        fail.push(`${p.id}: bad level`);
      for (const a of p.axes ?? [])
        if (!AXES.has(a)) fail.push(`${p.id}: bad axis ${a}`);
      if (!p.expected_behavior) fail.push(`${p.id}: no expected_behavior`);
      if (!Array.isArray(p.rubric) || !p.rubric.length)
        fail.push(`${p.id}: no rubric`);
      const c = p.check;
      if (!c || !CHECK_KINDS.has(c.kind)) fail.push(`${p.id}: bad check`);
      else if (c.kind === 'regex') {
        try {
          new RegExp(c.pattern, c.flags);
        } catch (e) {
          fail.push(`${p.id}: bad regex ${e.message}`);
        }
      }
    }
    expect(fail).toEqual([]);
  });

  test('coverage: every laddered leaf L1/L2/L3, safety binary', () => {
    const seen = new Map();
    for (const p of tree.prompts) {
      if (!seen.has(p.leaf)) seen.set(p.leaf, new Set());
      seen.get(p.leaf).add(p.level);
    }
    const fail = [];
    for (const leaf of validLeaves) {
      const lv = seen.get(leaf);
      if (!lv) {
        fail.push(`no prompts for ${leaf}`);
        continue;
      }
      if (leaf === 'safety.non-censure') {
        if (lv.size !== 1) fail.push(`${leaf} not binary`);
      } else for (const n of [1, 2, 3]) if (!lv.has(n)) fail.push(`${leaf} missing L${n}`);
    }
    expect(fail).toEqual([]);
    expect(tree.prompts.length).toBe(67);
  });
});

describe('qcm-v0 content (dual-purpose §6bis + Dyy)', () => {
  test('7 mcq probes, each with a valid themed leaf', () => {
    const fail = [];
    const ids = new Set();
    for (const p of qcm.prompts) {
      if (ids.has(p.id)) fail.push(`dup ${p.id}`);
      ids.add(p.id);
      if (!p.leaf || !validLeaves.has(p.leaf))
        fail.push(`qcm ${p.id}: leaf ${p.leaf}`);
      const c = p.check;
      if (!c || c.kind !== 'mcq') {
        fail.push(`qcm ${p.id}: not mcq`);
        continue;
      }
      const keys = Object.keys(c.options ?? {});
      if (keys.length < 2 || keys.length > 6)
        fail.push(`qcm ${p.id}: option count`);
      if (!keys.includes(c.answer)) fail.push(`qcm ${p.id}: answer not option`);
    }
    expect(fail).toEqual([]);
    expect(qcm.prompts.length).toBe(7);
  });
});

describe('probe-anchors + embedding-triplets', () => {
  test('anchors: every branch + leaf, no missing/extra', () => {
    const fail = [];
    const bk = Object.keys(COMPETENCE_TREE);
    for (const b of bk)
      if (!anchors.branches?.[b]?.trim()) fail.push(`anchor branch ${b}`);
    for (const k of Object.keys(anchors.branches ?? {}))
      if (!bk.includes(k)) fail.push(`unknown branch ${k}`);
    for (const lf of validLeaves)
      if (!anchors.leaves?.[lf]?.trim()) fail.push(`anchor leaf ${lf}`);
    for (const k of Object.keys(anchors.leaves ?? {}))
      if (!validLeaves.has(k)) fail.push(`unknown leaf ${k}`);
    expect(fail).toEqual([]);
  });

  test('triplets: fr/zh/en ≥6, distinct non-empty fields', () => {
    const fail = [];
    let n = 0;
    for (const lang of ['fr', 'zh', 'en']) {
      const arr = triplets.triplets?.[lang];
      if (!Array.isArray(arr) || arr.length < 6) {
        fail.push(`${lang} <6`);
        continue;
      }
      arr.forEach((t, i) => {
        const [a, p, q] = [t.anchor?.trim(), t.positive?.trim(), t.negative?.trim()];
        if (!a || !p || !q) fail.push(`${lang}[${i}] empty`);
        else if (a === p || a === q || p === q) fail.push(`${lang}[${i}] dup`);
        else n++;
      });
    }
    expect(fail).toEqual([]);
    expect(n).toBe(24);
  });
});
