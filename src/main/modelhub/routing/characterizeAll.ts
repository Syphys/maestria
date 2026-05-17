// Slice 5 — Bulk characterization ("Characterize all models").
// Spec: SEMANTIC_ROUTING_FEATURES.md §R3 ; Slice-5 decisions:
//   - scope: the opened location's models;
//   - order: SMALLEST FIRST (sum of shard bytes, ascending) — quick wins
//     first, and small models cold-load fast;
//   - skip models that already have a complete signature (resumable);
//   - cancel = stop after the current model (no hard abort).
//
// Reuses the Slice-4 runner per model (hybrid launch/reuse + ephemeral
// stop + persistence + single in-flight). We just enumerate, sort, skip,
// and drive it sequentially. Every external effect is injectable so the
// orchestration is unit-testable offline (no fs / no spawn / no network).

import { listModelFiles } from '../listModelFiles';
import { sumShardBytes } from '../shardFs';
import { loadSignature } from './signatureStore';
import {
  runCharacterization,
  type CharacterizeRunStatus,
} from './characterizeRunner';

export interface CharacterizeAllProgress {
  phase: 'enumerating' | 'running' | 'done' | 'cancelled';
  total: number; // models to run (after the skip filter)
  done: number; // finished (ok + errors)
  ok: number;
  errors: number;
  skipped: number; // already characterized, not re-run
  currentIndex: number; // 0-based position in the work list
  currentFile?: string;
  currentName?: string;
  /** Per-model sub-progress from the Slice-4 runner (Question i/n …). */
  modelStatus?: CharacterizeRunStatus;
  errorSamples: { file: string; error: string }[];
}

export interface CharacterizeAllDeps {
  listModelFiles?: typeof listModelFiles;
  sumShardBytes?: typeof sumShardBytes;
  loadSignature?: typeof loadSignature;
  runCharacterization?: typeof runCharacterization;
}

export interface CharacterizeAllOptions {
  /** Pass `loc.isReadOnly` — propagated to each per-model run. */
  skipWrite?: boolean;
  /** Skip models that already have a complete signature. Default true. */
  skipExisting?: boolean;
  onProgress?: (p: CharacterizeAllProgress) => void;
  deps?: CharacterizeAllDeps;
}

let running = false;
let cancelFlag = false;

export function isCharacterizeAllRunning(): boolean {
  return running;
}

/** Request a stop — honoured between models (the current one finishes). */
export function cancelCharacterizeAll(): void {
  if (running) cancelFlag = true;
}

function baseName(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

/**
 * Characterize every model under `rootDir`, smallest first. Resolves with
 * the final progress snapshot. Rejects only if a bulk run is already going.
 */
export async function characterizeAll(
  rootDir: string,
  opts: CharacterizeAllOptions = {},
): Promise<CharacterizeAllProgress> {
  if (running) {
    throw new Error('A bulk characterization is already running');
  }
  running = true;
  cancelFlag = false;

  const d = opts.deps ?? {};
  const lmf = d.listModelFiles ?? listModelFiles;
  const ssb = d.sumShardBytes ?? sumShardBytes;
  const ls = d.loadSignature ?? loadSignature;
  const rc = d.runCharacterization ?? runCharacterization;
  const skipExisting = opts.skipExisting ?? true;
  const emit = opts.onProgress ?? (() => undefined);

  const prog: CharacterizeAllProgress = {
    phase: 'enumerating',
    total: 0,
    done: 0,
    ok: 0,
    errors: 0,
    skipped: 0,
    currentIndex: 0,
    errorSamples: [],
  };
  const push = () => emit({ ...prog });

  try {
    push();

    const files = await lmf(rootDir);
    const sized = await Promise.all(
      files.map(async (f) => {
        try {
          return { f, bytes: (await ssb(f)).totalBytes };
        } catch {
          return { f, bytes: Number.MAX_SAFE_INTEGER }; // unsized → last
        }
      }),
    );
    sized.sort((a, b) => a.bytes - b.bytes); // smallest first

    const work: string[] = [];
    for (const { f } of sized) {
      if (skipExisting) {
        const sig = await ls(f).catch(() => undefined);
        if (sig?.behavioral && sig.characterization_state === 'complete') {
          prog.skipped += 1;
          continue;
        }
      }
      work.push(f);
    }

    prog.total = work.length;
    prog.phase = 'running';
    push();

    for (let i = 0; i < work.length; i++) {
      if (cancelFlag) {
        prog.phase = 'cancelled';
        push();
        return prog;
      }
      const file = work[i];
      prog.currentIndex = i;
      prog.currentFile = file;
      prog.currentName = baseName(file);
      prog.modelStatus = undefined;
      push();

      try {
        await rc(file, {
          skipWrite: opts.skipWrite,
          onStatus: (s) => {
            prog.modelStatus = s;
            push();
          },
        });
        prog.ok += 1;
      } catch (e) {
        prog.errors += 1;
        if (prog.errorSamples.length < 10) {
          prog.errorSamples.push({ file, error: (e as Error).message });
        }
      }
      prog.done += 1;
      push();
    }

    prog.phase = cancelFlag ? 'cancelled' : 'done';
    push();
    return prog;
  } finally {
    running = false;
    cancelFlag = false;
  }
}
