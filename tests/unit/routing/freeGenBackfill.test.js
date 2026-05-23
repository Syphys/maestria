// 2026-05-22 — runFreeGenBackfill: add ONLY the « Parler libre » free-gen
// evidence to an already-characterized model, without re-running the QCM
// staircase. Stored text ⇒ re-project (no model launch). No text ⇒ launch,
// talk once, project. All external effects injected for offline testing.
import { describe, expect, test } from '@playwright/test';
import {
  runFreeGenBackfill,
  isEmbeddingKv,
} from '../../../src/main/modelhub/routing/characterizeRunner';

/** Toy embedder: every text → all-ones ⇒ every cosine ≡ 1. */
const onesEmbed = async (texts) =>
  texts.map(() => new Float32Array([1, 1, 1, 1]));

function completeSig(behavioralExtra = {}) {
  return {
    modelHash: 'sha256:x',
    structural: {},
    behavioral: {
      scores_per_leaf: { 'math.algebre': 0.8 },
      ...behavioralExtra,
    },
    characterization_state: 'complete',
    suite_version: 'tree-v0',
  };
}

function baseDeps(over = {}) {
  return {
    resolveCanonical: async (p) => p,
    resolveEmbed: async () => onesEmbed,
    ...over,
  };
}

describe('runFreeGenBackfill (2026-05-22)', () => {
  test('stored freegen_text ⇒ re-projects, model NOT launched', async () => {
    let acquireCalls = 0;
    let saved;
    const deps = baseDeps({
      loadSignature: async () =>
        completeSig({
          freegen_text: 'python c++ sql stored monologue',
          freegen_words: 5,
        }),
      saveSignature: async (_p, sig) => {
        saved = sig;
        return { written: true, sidecarPath: '/x.json' };
      },
      acquireChat: async () => {
        acquireCalls += 1;
        throw new Error('acquireChat must not be called');
      },
    });
    const r = await runFreeGenBackfill('/m/a.gguf', { deps });
    expect(acquireCalls).toBe(0); // re-projection only, no launch
    expect(saved.behavioral.freegen_text).toBe(
      'python c++ sql stored monologue',
    );
    expect(saved.behavioral.freegen_words).toBe(5);
    expect(
      saved.behavioral.topic_coverage_per_leaf['code.python'],
    ).toBeCloseTo(1, 5);
    // QCM staircase data left untouched (no re-characterization).
    expect(saved.behavioral.scores_per_leaf['math.algebre']).toBe(0.8);
    expect(r.written).toBe(true);
  });

  test('no stored text ⇒ launches model, makes it talk, releases it', async () => {
    let released = 0;
    let saved;
    // Stateful sig — reflects writes so the project phase (which reloads
    // after generate has written the fresh text) sees the new state.
    let currentSig = completeSig();
    const deps = baseDeps({
      loadSignature: async () => currentSig,
      saveSignature: async (_p, sig) => {
        currentSig = sig;
        saved = sig;
        return { written: true, sidecarPath: '/x.json' };
      },
      acquireChat: async () => ({
        ask: {
          complete: async () => 'python c++ sql — a fresh monologue here',
        },
        release: () => {
          released += 1;
        },
      }),
    });
    await runFreeGenBackfill('/m/a.gguf', { deps });
    expect(released).toBe(1); // ephemeral server stopped
    expect(saved.behavioral.freegen_text).toMatch(/fresh monologue/);
    expect(saved.behavioral.freegen_words).toBeGreaterThan(3);
    expect(saved.behavioral.topic_coverage_per_branch.code).toBeCloseTo(1, 5);
  });

  test('no complete signature ⇒ throws', async () => {
    const deps = baseDeps({ loadSignature: async () => undefined });
    await expect(runFreeGenBackfill('/m/a.gguf', { deps })).rejects.toThrow(
      /no complete signature/,
    );
  });

  test('no embedder configured ⇒ throws', async () => {
    const deps = baseDeps({
      loadSignature: async () => completeSig({ freegen_text: 'stored' }),
      resolveEmbed: async () => {
        throw new Error('no embedder configured');
      },
    });
    await expect(runFreeGenBackfill('/m/a.gguf', { deps })).rejects.toThrow(
      /no embedder/,
    );
  });
});

describe('isEmbeddingKv — embedding-model detection via pooling_type', () => {
  test('embedding GGUF (qwen3.pooling_type ≥ 1) ⇒ true', () => {
    expect(
      isEmbeddingKv({ 'general.architecture': 'qwen3', 'qwen3.pooling_type': 1 }),
    ).toBe(true);
  });

  test('BGE/BERT embedding (bert.pooling_type = 2 / CLS) ⇒ true', () => {
    expect(isEmbeddingKv({ 'bert.pooling_type': 2 })).toBe(true);
  });

  test('generative chat GGUF (no pooling key) ⇒ false', () => {
    expect(
      isEmbeddingKv({
        'general.architecture': 'qwen3',
        'qwen3.context_length': 32768,
      }),
    ).toBe(false);
  });

  test('pooling_type = 0 (NONE) ⇒ false (still generative)', () => {
    expect(isEmbeddingKv({ 'llama.pooling_type': 0 })).toBe(false);
  });

  test('undefined / non-object ⇒ false', () => {
    expect(isEmbeddingKv(undefined)).toBe(false);
    expect(isEmbeddingKv(null)).toBe(false);
    expect(isEmbeddingKv('nope')).toBe(false);
  });
});
