// Slice 5 — single-pass protocol (2026-05-23 rev.). For each model in
// size order: test (no embedder), then project via per-call embedder
// (one llama-embedding spawn). Tests validate ordering, skip logic,
// free-gen backfill, force toggle, projection gating (skipProjection
// flag + silent embedder-missing fallback), non-GGUF skipping, and
// progress phases. All external effects injected for offline testing.
import { describe, expect, test } from '@playwright/test';
import { characterizeAll } from '../../../src/main/modelhub/routing/characterizeAll';

function makeDeps(opts = {}) {
  const calls = { run: [], gen: [], proj: [], mu: [], embedResolves: 0 };
  // Stateful sig store: the mocks UPDATE it the way real runners would,
  // so reads after writes see the freshly-stored state.
  const sigs = { ...(opts.initialSigs ?? {}) };
  return {
    deps: {
      listModelFiles: async () =>
        opts.files ?? ['/m/a.gguf', '/m/b.gguf', '/m/c.gguf'],
      sumShardBytes: async (f) => ({
        totalBytes: opts.bytes?.[f] ?? f.length, // stable size-based order
      }),
      loadSignature: async (f) => sigs[f],
      runCharacterization: async (f, runOpts) => {
        calls.run.push(f);
        runOpts?.onStatus?.({ stage: 'preparing', detail: 'launching' });
        runOpts?.onStatus?.({ stage: 'done' });
        // Simulate a successful characterization: write a complete sig
        // (with freegen_text if « Parler libre » asked).
        sigs[f] = {
          behavioral: {
            scores_per_leaf: {},
            ...(runOpts?.freegen !== false
              ? { freegen_text: 'generated', freegen_words: 1 }
              : {}),
          },
          characterization_state: 'complete',
        };
        return { ok: true };
      },
      runFreeGenGenerate: async (f, runOpts) => {
        calls.gen.push(f);
        runOpts?.onStatus?.({ stage: 'preparing', detail: 'launching' });
        runOpts?.onStatus?.({ stage: 'done' });
        const sig = sigs[f];
        if (sig?.behavioral) {
          sigs[f] = {
            ...sig,
            behavioral: {
              ...sig.behavioral,
              freegen_text: 'generated',
              freegen_words: 1,
            },
          };
        }
        return { ok: true };
      },
      runFreeGenProject: async (f, _embed, runOpts) => {
        calls.proj.push(f);
        runOpts?.onStatus?.({ stage: 'preparing', detail: 'reuse' });
        runOpts?.onStatus?.({ stage: 'done' });
        const sig = sigs[f];
        if (sig?.behavioral) {
          sigs[f] = {
            ...sig,
            behavioral: {
              ...sig.behavioral,
              topic_coverage_per_leaf: { 'math.algebre': 1 },
            },
          };
        }
        return { ok: true };
      },
      resolveEmbed:
        opts.resolveEmbed ??
        (async () => {
          calls.embedResolves += 1;
          // Per-call EmbedFn: one all-ones vector per text.
          return async (texts) =>
            texts.map(() => new Float32Array([1, 1, 1, 1]));
        }),
      markUnsupported: async (f, reason) => {
        calls.mu.push({ f, reason });
        sigs[f] = { characterization_state: 'failed' };
        return { written: true, sidecarPath: '/x' };
      },
    },
    calls,
    sigs,
  };
}

describe('characterizeAll (slice 5) — skipExisting default', () => {
  test('smallest-first ordering by totalBytes', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/big.gguf', '/m/small.gguf', '/m/mid.gguf'],
      bytes: { '/m/big.gguf': 30, '/m/small.gguf': 10, '/m/mid.gguf': 20 },
    });
    const final = await characterizeAll('/root', { deps });
    expect(final.phase).toBe('done');
    expect(calls.run).toEqual([
      '/m/small.gguf',
      '/m/mid.gguf',
      '/m/big.gguf',
    ]);
  });

  test('skipExisting=true (default) skips both complete AND failed', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/done.gguf', '/m/failed.gguf', '/m/pending.gguf'],
      initialSigs: {
        '/m/done.gguf': {
          behavioral: { scores_per_axis: {} },
          characterization_state: 'complete',
        },
        '/m/failed.gguf': { characterization_state: 'failed' },
      },
    });
    const final = await characterizeAll('/root', { deps });
    expect(calls.run).toEqual(['/m/pending.gguf']);
    expect(final.skipped).toBe(2);
    expect(final.ok).toBe(1);
  });
});

describe('characterizeAll (slice 6b) — skipExisting=false force toggle', () => {
  test('force re-runs complete AND failed (no skip)', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/done.gguf', '/m/failed.gguf', '/m/pending.gguf'],
      initialSigs: {
        '/m/done.gguf': {
          behavioral: { scores_per_axis: {} },
          characterization_state: 'complete',
        },
        '/m/failed.gguf': { characterization_state: 'failed' },
      },
    });
    const final = await characterizeAll('/root', {
      skipExisting: false,
      deps,
    });
    expect(calls.run.sort()).toEqual([
      '/m/done.gguf',
      '/m/failed.gguf',
      '/m/pending.gguf',
    ]);
    expect(final.skipped).toBe(0);
    expect(final.ok).toBe(3);
  });

  test('force still quarantines a fresh UnsupportedModelError', async () => {
    const { UnsupportedModelError } = await import(
      '../../../src/main/modelhub/routing/characterizeRunner'
    );
    const failingDeps = makeDeps({
      files: ['/m/whisper.gguf'],
      initialSigs: { '/m/whisper.gguf': { characterization_state: 'failed' } },
    });
    failingDeps.deps.runCharacterization = async () => {
      throw new UnsupportedModelError('unsupported architecture: whisper');
    };
    const final = await characterizeAll('/root', {
      skipExisting: false,
      deps: failingDeps.deps,
    });
    // Force ran it (skip was bypassed), it failed again, re-quarantined.
    expect(failingDeps.calls.mu.length).toBe(1);
    expect(failingDeps.calls.mu[0].reason).toMatch(/whisper/);
    expect(final.skipped).toBe(1);
    expect(final.errors).toBe(0);
  });
});

describe('characterizeAll — single-pass free-gen (« Parler libre »)', () => {
  test('freegen on, complete missing text + pending fresh ⇒ gen + full, both projected', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/done.gguf', '/m/pending.gguf'],
      initialSigs: {
        '/m/done.gguf': {
          behavioral: { scores_per_leaf: { 'math.algebre': 0.8 } },
          characterization_state: 'complete',
        },
      },
    });
    const final = await characterizeAll('/root', { freegen: true, deps });
    // Already-complete model gets text-generation only (no staircase
    // re-run); the pending one gets the full characterization.
    expect(calls.gen).toEqual(['/m/done.gguf']);
    expect(calls.run).toEqual(['/m/pending.gguf']);
    // Both have text after their respective phase-1 step → both projected
    // (order matches the size-sorted work list).
    expect(calls.proj.sort()).toEqual(['/m/done.gguf', '/m/pending.gguf']);
    expect(final.projected).toBe(2);
    // Only the fresh `full` characterization bumps `ok` — backfill /
    // projection enrich an already-counted signature.
    expect(final.ok).toBe(1);
    expect(final.errors).toBe(0);
    // Embedder factory resolved exactly once (validation), the returned
    // EmbedFn is what gets called per projection.
    expect(calls.embedResolves).toBe(1);
  });

  test('freegen on, complete with text AND projection ⇒ skipped entirely', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/done.gguf'],
      initialSigs: {
        '/m/done.gguf': {
          behavioral: {
            scores_per_leaf: {},
            freegen_text: 'a stored monologue',
            topic_coverage_per_leaf: { 'math.algebre': 0.4 },
          },
          characterization_state: 'complete',
        },
      },
    });
    const final = await characterizeAll('/root', { freegen: true, deps });
    expect(calls.gen).toEqual([]);
    expect(calls.run).toEqual([]);
    expect(calls.proj).toEqual([]);
    expect(final.skipped).toBe(1);
    expect(final.projected).toBe(0);
  });

  test('freegen on, complete with text but no projection ⇒ project-only, no relaunch', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/done.gguf'],
      initialSigs: {
        '/m/done.gguf': {
          behavioral: { scores_per_leaf: {}, freegen_text: 'stored text' },
          characterization_state: 'complete',
        },
      },
    });
    const final = await characterizeAll('/root', { freegen: true, deps });
    // No pass-1 work (text already present).
    expect(calls.gen).toEqual([]);
    expect(calls.run).toEqual([]);
    // Projection runs (single-pass merges it in-line).
    expect(calls.proj).toEqual(['/m/done.gguf']);
    expect(final.projected).toBe(1);
  });

  test('freegen OFF ⇒ no projection, complete models skipped', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/done.gguf'],
      initialSigs: {
        '/m/done.gguf': {
          behavioral: { scores_per_leaf: {} },
          characterization_state: 'complete',
        },
      },
    });
    const final = await characterizeAll('/root', { deps }); // freegen undefined
    expect(calls.gen).toEqual([]);
    expect(calls.run).toEqual([]);
    expect(calls.proj).toEqual([]);
    expect(final.skipped).toBe(1);
    expect(final.projected).toBe(0);
    // Embedder factory never resolved when freegen is off.
    expect(calls.embedResolves).toBe(0);
  });

  test('embedder fails to resolve ⇒ tests still run, projections skipped silently', async () => {
    const failingDeps = makeDeps({
      files: ['/m/a.gguf'],
      resolveEmbed: async () => {
        throw new Error('no embedder configured');
      },
    });
    const final = await characterizeAll('/root', {
      freegen: true,
      deps: failingDeps.deps,
    });
    // Phase 1 ran the full characterization.
    expect(failingDeps.calls.run).toEqual(['/m/a.gguf']);
    expect(final.ok).toBe(1);
    // Projection step skipped — no error counted, just an info sample.
    expect(failingDeps.calls.proj).toEqual([]);
    expect(final.projected).toBe(0);
    expect(final.errors).toBe(0);
    expect(final.errorSamples.length).toBe(1);
    expect(final.errorSamples[0].file).toBe('(embedder)');
    expect(final.errorSamples[0].error).toMatch(/projections skipped/);
  });

  test('skipProjection=true ⇒ texts generated but projection step skipped', async () => {
    const { deps, calls } = makeDeps({
      files: ['/m/pending.gguf'],
    });
    const final = await characterizeAll('/root', {
      freegen: true,
      skipProjection: true,
      deps,
    });
    // Tests ran (and wrote freegen_text), projection skipped.
    expect(calls.run).toEqual(['/m/pending.gguf']);
    expect(calls.proj).toEqual([]);
    expect(final.projected).toBe(0);
    // Embedder factory not even consulted when skipProjection is on.
    expect(calls.embedResolves).toBe(0);
  });
});

describe('characterizeAll — non-GGUF files skipped', () => {
  test('.pt / .pth / .bin / .ckpt are skipped, never characterized', async () => {
    const { deps, calls } = makeDeps({
      files: [
        '/m/af_sky.pt',
        '/m/voice.pth',
        '/m/weights.bin',
        '/m/old.ckpt',
        '/m/model.gguf',
      ],
    });
    const final = await characterizeAll('/root', { deps });
    // Only the GGUF reaches the runner.
    expect(calls.run).toEqual(['/m/model.gguf']);
    expect(calls.gen).toEqual([]);
    expect(calls.proj).toEqual([]);
    // The four PyTorch/TF checkpoints are counted as skipped.
    expect(final.skipped).toBe(4);
    expect(final.errors).toBe(0);
  });
});

describe('characterizeAll progress emission', () => {
  test('phase transitions: enumerating → running → done (no freegen)', async () => {
    const phases = [];
    const { deps } = makeDeps();
    await characterizeAll('/root', {
      deps,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases[0]).toBe('enumerating');
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases.includes('running')).toBe(true);
    // Single-pass: no separate `projecting` phase, even with freegen on.
    expect(phases.includes('projecting')).toBe(false);
  });

  test('phase transitions stay single-pass when freegen is on', async () => {
    const phases = [];
    const { deps } = makeDeps();
    await characterizeAll('/root', {
      freegen: true,
      deps,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases[0]).toBe('enumerating');
    expect(phases.includes('running')).toBe(true);
    // Still no projecting phase in the single-pass design.
    expect(phases.includes('projecting')).toBe(false);
    expect(phases[phases.length - 1]).toBe('done');
  });
});
