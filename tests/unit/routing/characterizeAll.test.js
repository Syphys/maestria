// Slice 6b — characterizeAll: validates the `skipExisting` toggle.
// Default true (resumable) skips `complete` AND `failed` signatures.
// `false` (= "force" toggle in the UI) re-runs both. Cancelable. Orders
// by size ascending. All external effects injected for offline testing.
import { describe, expect, test } from '@playwright/test';
import { characterizeAll } from '../../../src/main/modelhub/routing/characterizeAll';

function makeDeps(opts = {}) {
  const calls = { run: [], mu: [] };
  const ls = opts.ls ?? (async () => undefined);
  return {
    deps: {
      listModelFiles: async () =>
        opts.files ?? ['/m/a.gguf', '/m/b.gguf', '/m/c.gguf'],
      sumShardBytes: async (f) => ({
        totalBytes: opts.bytes?.[f] ?? f.length, // stable size-based order
      }),
      loadSignature: ls,
      runCharacterization: async (f, runOpts) => {
        calls.run.push(f);
        runOpts?.onStatus?.({ stage: 'preparing', detail: 'launching' });
        runOpts?.onStatus?.({ stage: 'done' });
        return { ok: true };
      },
      markUnsupported: async (f, reason) => {
        calls.mu.push({ f, reason });
        return { written: true, sidecarPath: '/x' };
      },
    },
    calls,
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
      ls: async (f) => {
        if (f === '/m/done.gguf')
          return {
            behavioral: { scores_per_axis: {} },
            characterization_state: 'complete',
          };
        if (f === '/m/failed.gguf')
          return { characterization_state: 'failed' };
        return undefined; // pending: never characterized
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
      ls: async (f) => {
        if (f === '/m/done.gguf')
          return {
            behavioral: { scores_per_axis: {} },
            characterization_state: 'complete',
          };
        if (f === '/m/failed.gguf')
          return { characterization_state: 'failed' };
        return undefined;
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
      ls: async () => ({ characterization_state: 'failed' }),
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

describe('characterizeAll progress emission', () => {
  test('phase transitions: enumerating → running → done', async () => {
    const phases = [];
    const { deps } = makeDeps();
    await characterizeAll('/root', {
      deps,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases[0]).toBe('enumerating');
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases.includes('running')).toBe(true);
  });
});
