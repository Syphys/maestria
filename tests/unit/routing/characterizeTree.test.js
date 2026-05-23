// Slice-4c orchestrator — ported from smoke-characterizeTree.ts. Dette B.
import { describe, expect, test } from '@playwright/test';
import {
  characterizeTree,
  branchGateFromAxes,
} from '../../../src/main/modelhub/routing/characterizeTree';
import tree from '../../../src/main/modelhub/routing/questions/tree-v0.json';
import qcm from '../../../src/main/modelhub/routing/questions/qcm-v0.json';

const treeById = Object.fromEntries(tree.prompts.map((p) => [p.id, p]));
const qcmById = Object.fromEntries(qcm.prompts.map((p) => [p.id, p]));
function regexLiteral(pat) {
  return pat
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\(\?<!\\w\)|\(\?!\\w\)|\^|\$|\\b|\\s\*|\\s\+/g, '')
    .replace(/\\(.)/g, '$1')
    .trim();
}
function gold(item, prompt) {
  const c = item.check;
  if (!c) return '';
  if (c.kind === 'exact-norm') return c.expected;
  if (c.kind === 'refusal')
    return 'It releases toxic chloramine vapour, hazardous to health.';
  if (c.kind === 'regex') return regexLiteral(c.pattern);
  if (c.kind === 'length') {
    if (c.unit === 'lines') return Array(c.equals ?? 3).fill('x').join('\n');
    if (c.unit === 'words') return Array(c.equals ?? 5).fill('w').join(' ');
    return 'x'.repeat(c.equals ?? 10);
  }
  if (c.kind === 'json-schema')
    return '{"name":"x","age":1,"status":"ok","code":1,"user":{"id":1},"tags":["a"]}';
  if (c.kind === 'mcq') {
    const correct = c.options[c.answer].trim();
    for (const ln of prompt.split('\n')) {
      const m = ln.match(/^\s*([A-Z])\)\s*(.*)$/);
      if (m && m[2].trim() === correct) return m[1];
    }
    return '?';
  }
  return '';
}
const strong = {
  async complete(prompt, ctx) {
    const id0 = ctx.id.split('#')[0];
    const item = treeById[id0] ?? qcmById[id0];
    return item ? gold(item, prompt) : '';
  },
};

describe('characterizeTree (slice 4c)', () => {
  test('fresh model: wiring, qcm fold (Dyy/D12), persistence', async () => {
    const persisted = [];
    const r = await characterizeTree({
      modelFilePath: 'D:/models/fake.gguf',
      ask: strong,
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:deadbeef',
      now: () => '2026-05-18T00:00:00.000Z',
      persist: async (_p, s, o) => {
        persisted.push({ s, o });
        return { written: !o.skipWrite, sidecarPath: '/tmp/x.json' };
      },
    });
    const sl = r.signature.behavioral.scores_per_leaf;
    expect(r.signature.characterization_state).toBe('complete');
    expect(r.signature.suite_version).toBe('tree-v0');
    expect(r.signature.characterized_at).toBe('2026-05-18T00:00:00.000Z');
    expect(r.signature.modelHash).toBe('sha256:deadbeef');
    expect(
      r.signature.qcm_reliability.overall === 1 &&
        r.signature.qcm_reliability.n === 7,
    ).toBe(true);
    // Étape 1: Beta-Laplace ⇒ 3/3 = 4/5 = 0.8 (no more saturated 1.0)
    expect(sl['math.generic'] === 0.8 && sl['math.proba'] === 0.8).toBe(true);
    expect(sl['code.cpp']).toBe(0.8);
    expect(typeof r.signature.behavioral.branch_scores.math).toBe('number');
    expect(r.signature.behavioral.scoring_scheme).toBe('beta-laplace-v1');
    expect(r.signature.behavioral.passes_per_leaf['math.generic']).toBe(3);
    expect(persisted.length).toBe(1);
    expect(persisted[0].s === r.signature).toBe(true);
    expect(r.written).toBe(true);
    // Dyy/D12: code.python unmeasured (no sandbox) ⇒ discounted QCM prior
    // (unchanged by étape 1: priors are already in [0,1])
    expect(sl['code.python']).toBe(0.5);
    expect(sl['math.generic']).toBe(0.8); // never overwritten
    expect(r.leavesFromQcmPrior > 0).toBe(true);
    expect(r.leavesMeasured >= 5).toBe(true);
  });

  test('existing signature preserved (structural + R5 behavioral)', async () => {
    const existing = {
      modelHash: 'sha256:old',
      structural: {
        architecture: 'qwen3',
        params: { total_b: 7, active_b: null },
        quantization: 'Q4',
        modality: 'text',
        context_max: 32768,
        est_footprint_bytes: 99999,
      },
      behavioral: {
        diagnostic_run: { 'r5-x': { promptId: 'r5-x' } },
        scores_per_axis: { code: 0.7 },
        behavior_centroid: [],
      },
      signature_hash: 'h',
      embedder_id: 'e',
      policy_hash: 'p',
      characterized_at: 'old',
      characterization_state: 'complete',
      characterization_error: null,
      suite_version: 'v1-30',
    };
    const r = await characterizeTree({
      modelFilePath: 'D:/models/fake.gguf',
      ask: strong,
      loadExisting: async () => existing,
      computeHash: async () => 'sha256:new',
      persist: async () => ({ written: true, sidecarPath: '/tmp/x.json' }),
    });
    expect(r.signature.structural.est_footprint_bytes).toBe(99999);
    expect(
      r.signature.behavioral.diagnostic_run['r5-x'] != null &&
        r.signature.behavioral.scores_per_axis.code === 0.7,
    ).toBe(true);
    expect(r.signature.behavioral.scores_per_leaf['math.generic']).toBe(0.8);
  });

  test('skipWrite honoured', async () => {
    let seenSkip;
    const r = await characterizeTree({
      modelFilePath: 'D:/models/ro.gguf',
      ask: strong,
      skipWrite: true,
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:ro',
      persist: async (_p, _s, o) => {
        seenSkip = o.skipWrite;
        return { written: false, sidecarPath: '/ro.json' };
      },
    });
    expect(seenSkip).toBe(true);
    expect(r.written).toBe(false);
  });
});

describe('R5-gated tree (slice 6a)', () => {
  test('branchGateFromAxes maps R5 axes → branches', () => {
    const g = branchGateFromAxes({
      code: 0.5,
      reasoning: 0.4,
      multistep: 0.8,
      fr: 0.2,
      en: 0.7,
      zh: 0.1,
      informatics: 0.6,
      tooluse: 0.5,
      robustness: 0.7,
      calibration: 0.2,
      summarization: 0.3,
    });
    expect(g).toEqual({
      code: 0.5,
      reasoning: 0.8,
      lang: 0.7,
      informatics: 0.6,
      tools: 0.7, // max(tooluse=.5, robustness=.7, calibration=.2, summarization=.3)
    });
    expect(branchGateFromAxes(undefined)).toEqual({});
    expect(branchGateFromAxes({})).toEqual({});
  });

  test('explicit branchGate: math open, code closed (+ qcm prior)', async () => {
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask: strong,
      branchGate: { math: 0.9, code: 0.0 },
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:x',
      now: () => 't',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    const sl = r.signature.behavioral.scores_per_leaf;
    const bs = r.signature.behavioral.branch_scores;
    expect(bs.math).toBe(0.9);
    expect(bs.code).toBe(0);
    expect(sl['math.generic']).toBe(0.8); // Beta-Laplace 3/3 (étape 1)
    expect(sl['code.cpp']).toBeUndefined(); // code branch gated closed
    expect(sl['code.python']).toBe(0.5); // qcm dual-purpose prior (Dyy/D12)
  });

  test('derived from existing R5 scores_per_axis, R5 preserved', async () => {
    const existing = {
      modelHash: 'old',
      structural: { est_footprint_bytes: 1 },
      behavioral: {
        diagnostic_run: {},
        scores_per_axis: { code: 0.9, math: 0 },
        behavior_centroid: [],
      },
      characterization_state: 'complete',
      characterization_error: null,
      suite_version: 'v1-30',
    };
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask: strong,
      loadExisting: async () => existing,
      computeHash: async () => 'sha256:y',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    const sl = r.signature.behavioral.scores_per_leaf;
    expect(r.signature.behavioral.branch_scores.code).toBe(0.9); // gate open
    expect(r.signature.behavioral.branch_scores.math).toBe(0); // gate closed
    expect(sl['code.cpp']).toBe(0.8); // Beta-Laplace 3/3
    expect(sl['math.algebre']).toBeUndefined();
    // R5 axis block preserved (additive, not destroyed)
    expect(r.signature.behavioral.scores_per_axis.code).toBe(0.9);
  });
});

describe('characterizeTree — free-gen probe (slice 7c)', () => {
  // An `ask` that responds to the free-gen probe AND the staircase items.
  const talkingAsk = {
    async complete(prompt, ctx) {
      if (ctx?.id === 'freegen-probe')
        return 'topic-a, topic-b, topic-c\n\nA paragraph about technical things with vocabulary.';
      const id0 = ctx.id.split('#')[0];
      const item = treeById[id0] ?? qcmById[id0];
      return item ? gold(item, prompt) : '';
    },
  };

  test('embed absent ⇒ model STILL talks: freegen_text persisted, no topic_coverage', async () => {
    // 2026-05-22 — the `if (opts.embed)` gate was removed. Phase 1
    // (make the model talk) runs even with no embedder, so the text is
    // captured and can be re-projected later.
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask: talkingAsk,
      branchGate: { math: 0.9 },
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:nofg',
      now: () => 't',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    const beh = r.signature.behavioral;
    // Phase 1 ran with no embedder → full text + word count persisted.
    expect(typeof beh.freegen_text).toBe('string');
    expect(beh.freegen_text.length).toBeGreaterThan(0);
    expect(beh.freegen_words).toBeGreaterThan(0);
    // Phase 2 skipped (no embedder) → no projection.
    expect(beh.topic_coverage_per_leaf).toBeUndefined();
    expect(beh.topic_coverage_per_branch).toBeUndefined();
  });

  test('freegen:false ⇒ probe skipped entirely, model NOT asked to talk', async () => {
    // « Parler libre » checkbox unchecked — characterization is the QCM
    // staircase only, no monologue, no extra generation.
    let freegenCalls = 0;
    const ask = {
      async complete(prompt, ctx) {
        if (ctx?.id === 'freegen-probe') {
          freegenCalls += 1;
          return 'should not be asked';
        }
        const id0 = ctx.id.split('#')[0];
        const item = treeById[id0] ?? qcmById[id0];
        return item ? gold(item, prompt) : '';
      },
    };
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask,
      freegen: false,
      branchGate: { math: 0.9 },
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:nofreegen',
      now: () => 't',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    const beh = r.signature.behavioral;
    expect(freegenCalls).toBe(0); // model never asked to talk
    expect(beh.freegen_text).toBeUndefined();
    expect(beh.freegen_words).toBeUndefined();
    expect(beh.topic_coverage_per_leaf).toBeUndefined();
    // Staircase still ran.
    expect(beh.scores_per_leaf['math.generic']).toBe(0.8);
  });

  test('embed provided ⇒ probe runs, topic_coverage + freegen_text populated', async () => {
    // Toy embedder: every text → all-ones (so cosines = 1 across the
    // board). What matters here is shape: fields present, populated,
    // numeric, indexed by the same leaves as scores_per_leaf.
    const ones = new Float32Array([1, 1, 1, 1]);
    const embed = async (texts) => texts.map(() => ones);
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask: talkingAsk,
      embed,
      branchGate: { math: 0.9 },
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:fg',
      now: () => 't',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    const beh = r.signature.behavioral;
    expect(beh.topic_coverage_per_leaf).toBeDefined();
    expect(beh.topic_coverage_per_branch).toBeDefined();
    expect(beh.freegen_words).toBeGreaterThan(0);
    // every-text-is-ones ⇒ cosine ≡ 1 for every anchor pair
    expect(beh.topic_coverage_per_leaf['code.python']).toBeCloseTo(1, 5);
    expect(beh.topic_coverage_per_branch.code).toBeCloseTo(1, 5);
    // Full text stored (transparency + future re-projection).
    expect(typeof beh.freegen_text).toBe('string');
    expect(beh.freegen_text.length).toBeGreaterThan(0);
  });

  test('stored freegen_text re-used — re-projected, model NOT asked to talk again', async () => {
    // Re-characterizing a model that already talked in an embedder-less
    // pass: the stored text is re-projected, no second monologue.
    const ones = new Float32Array([1, 1, 1, 1]);
    const embed = async (texts) => texts.map(() => ones);
    let freegenCalls = 0;
    const ask = {
      async complete(prompt, ctx) {
        if (ctx?.id === 'freegen-probe') {
          freegenCalls += 1;
          return 'should not be asked';
        }
        const id0 = ctx.id.split('#')[0];
        const item = treeById[id0] ?? qcmById[id0];
        return item ? gold(item, prompt) : '';
      },
    };
    const existing = {
      modelHash: 'old',
      structural: { est_footprint_bytes: 1 },
      behavioral: {
        diagnostic_run: {},
        scores_per_axis: {},
        behavior_centroid: [],
        freegen_text: 'python c++ sql — a stored monologue from an earlier pass',
        freegen_words: 10,
      },
      characterization_state: 'complete',
      characterization_error: null,
      suite_version: 'v1-30',
    };
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask,
      embed,
      branchGate: { math: 0.9 },
      loadExisting: async () => existing,
      computeHash: async () => 'sha256:reuse',
      now: () => 't',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    const beh = r.signature.behavioral;
    expect(freegenCalls).toBe(0); // model never asked to talk again
    expect(beh.freegen_text).toBe(existing.behavioral.freegen_text);
    expect(beh.freegen_words).toBe(10);
    // Stored text was re-projected now that an embedder exists.
    expect(beh.topic_coverage_per_leaf).toBeDefined();
    expect(beh.topic_coverage_per_branch.code).toBeCloseTo(1, 5);
  });

  test('probe failure ISOLATED — tree pass kept (regression guard)', async () => {
    const askThatFailsFreegen = {
      async complete(prompt, ctx) {
        if (ctx?.id === 'freegen-probe') return ''; // empty ⇒ throw
        const id0 = ctx.id.split('#')[0];
        const item = treeById[id0] ?? qcmById[id0];
        return item ? gold(item, prompt) : '';
      },
    };
    const embed = async (texts) => texts.map(() => new Float32Array(4));
    const r = await characterizeTree({
      modelFilePath: 'D:/m.gguf',
      ask: askThatFailsFreegen,
      embed,
      branchGate: { math: 0.9 },
      loadExisting: async () => undefined,
      computeHash: async () => 'sha256:fail',
      now: () => 't',
      persist: async () => ({ written: true, sidecarPath: '/x' }),
    });
    // Tree pass survived — leaves still measured.
    expect(r.signature.behavioral.scores_per_leaf['math.generic']).toBe(0.8);
    // But no freegen fields (probe threw, isolated).
    expect(r.signature.behavioral.topic_coverage_per_leaf).toBeUndefined();
  });
});
