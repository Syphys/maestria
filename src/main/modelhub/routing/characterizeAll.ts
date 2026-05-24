// Slice 5 — Bulk characterization ("Characterize all models").
// Spec: SEMANTIC_ROUTING_FEATURES.md §R3.
//
// Single-pass protocol (2026-05-23, after the user pushed back on the
// "two-pass / wait for all tests" UX): for each model in size order,
//
//   1. TEST  — launch llama-server → R5 suite + tree staircase + free-gen
//      TEXT (no embedder) → stop. The test model is the only thing in
//      RAM during this step.
//   2. EMBED — if the model now has a `freegen_text` to project AND the
//      embedder is available (managed GGUF + sibling `llama-embedding`
//      binary), spawn `llama-embedding.exe` once, project, exit. The
//      embedder is in RAM for ~3 s, never concurrent with the test model.
//   3. NEXT  — move on.
//
// Why single-pass with a per-model CLI embedder:
//   - the user sees each model's full result (tests + projection) as
//     soon as it's done — no "wait for all 50 tests, then projections";
//   - RAM goes back to ~zero between models;
//   - we use the official llama.cpp tool (`llama-embedding`) that exists
//     for exactly this case, instead of starting/stopping a long-lived
//     embedding server.
//
// Two gates suppress projection (silent, non-blocking):
//   - `opts.skipProjection` — UI checkbox « Sans calcul vectoriel »;
//     the user wants tests + texts now, projections later.
//   - no embedder available — config missing the managed GGUF path, or
//     the `llama-embedding` binary not found next to llama-server. We
//     surface a single info-level error sample so the user knows why
//     the projections weren't done, but the bulk run completes.
//
// Other decisions baked in:
//   - scope: the opened location's models;
//   - order: SMALLEST FIRST (sum of shard bytes, ascending);
//   - non-GGUF/safetensors files are skipped silently;
//   - models already `complete` (with text AND projection) are skipped;
//   - models with text but no projection get just the projection step;
//   - quarantined `failed` models are never revisited;
//   - cancel = stop after the current model (no hard abort).
//
// Every external effect is injectable so the orchestration is offline-
// testable (no fs / no spawn / no network).

import { listModelFiles } from '../listModelFiles';
import { sumShardBytes } from '../shardFs';
import { loadSignature, markUnsupported } from './signatureStore';
import { appendErrorLog, archiveServerLog } from '../modelLogStore';
import {
  runCharacterization,
  runFreeGenGenerate,
  runFreeGenProject,
  UnsupportedModelError,
  type CharacterizeRunStatus,
} from './characterizeRunner';
import { resolveEmbedderCliFn } from './embedderCli';
import type { EmbedFn } from './embedProject';

/** A model that can't be characterized at all → quarantine, don't retry. */
function isUnsupported(e: unknown): boolean {
  if (e instanceof UnsupportedModelError) return true;
  const m = (e as Error)?.message ?? '';
  return /unsupported architecture|unknown model architecture|failed to load model|server exited before becoming ready|non-chat model/i.test(
    m,
  );
}

export interface CharacterizeAllProgress {
  /**
   * `enumerating` — listing files. `running` — per-model loop
   * (test then optional projection). `done` / `cancelled` — terminal.
   */
  phase: 'enumerating' | 'running' | 'done' | 'cancelled';
  /** Total models to process. */
  total: number;
  /** Cumulative ops finished. */
  done: number;
  /** Newly-characterized models (fresh `full` successes only). */
  ok: number;
  /** Failed ops. */
  errors: number;
  /** Models not processed (quarantined, already done, non-GGUF). */
  skipped: number;
  /** Projections successfully written this run. */
  projected: number;
  /** 0-based index in the work list. */
  currentIndex: number;
  currentFile?: string;
  currentName?: string;
  /** Per-model sub-progress from the Slice-4 runner. */
  modelStatus?: CharacterizeRunStatus;
  errorSamples: { file: string; error: string }[];
}

export interface CharacterizeAllDeps {
  listModelFiles?: typeof listModelFiles;
  sumShardBytes?: typeof sumShardBytes;
  loadSignature?: typeof loadSignature;
  runCharacterization?: typeof runCharacterization;
  /** Generate the free-gen text without projecting (no embedder). */
  runFreeGenGenerate?: typeof runFreeGenGenerate;
  /** Project a stored free-gen text via an injected embedder. */
  runFreeGenProject?: typeof runFreeGenProject;
  /**
   * Resolve a per-call EmbedFn. The default is the CLI-backed factory
   * (`embedderCli.resolveEmbedderCliFn`) — each invocation of the
   * returned `EmbedFn` spawns `llama-embedding`, embeds, exits. Tests
   * inject a deterministic in-memory embedder instead.
   */
  resolveEmbed?: () => Promise<EmbedFn>;
  markUnsupported?: typeof markUnsupported;
}

export interface CharacterizeAllOptions {
  /** Pass `loc.isReadOnly` — propagated to each per-model run. */
  skipWrite?: boolean;
  /** Skip models that already have a complete signature. Default true. */
  skipExisting?: boolean;
  /**
   * Free-gen probe master switch (« Parler libre » checkbox). Default
   * ON (`undefined` ⇒ true). `false` ⇒ run the QCM staircase only (no
   * monologue, no projection).
   */
  freegen?: boolean;
  /**
   * « Sans calcul vectoriel » checkbox. When true, the monologue is
   * still generated and saved (`freegen_text`), but the projection
   * step is skipped — the user can run the projection later, batched
   * or on-demand. Implicitly true when no embedder is available.
   */
  skipProjection?: boolean;
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
 * Per-model work classification. `'full'` = no usable signature, run
 * everything. `'gen'` = signature complete but missing the free-gen
 * text. `'project-only'` = signature complete + text stored, but never
 * projected (e.g. previous run finished without an embedder).
 * `undefined` = nothing to do here (skipped at enumeration).
 */
type ModelWorkKind = 'full' | 'gen' | 'project-only';

interface ModelWork {
  file: string;
  kind: ModelWorkKind;
}

/**
 * Characterize every model under `rootDir`, smallest first. Each model
 * gets its test phase, then an optional projection (if free-gen is on,
 * the embedder is reachable, and projections aren't suppressed). The
 * embedder spawns per model via `llama-embedding` CLI — no resident
 * server, RAM frees between models.
 *
 * Resolves with the final progress snapshot. Rejects only if a bulk
 * run is already going.
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
  const rg = d.runFreeGenGenerate ?? runFreeGenGenerate;
  const rp = d.runFreeGenProject ?? runFreeGenProject;
  const re = d.resolveEmbed ?? resolveEmbedderCliFn;
  const skipExisting = opts.skipExisting ?? true;
  const emit = opts.onProgress ?? (() => undefined);

  const prog: CharacterizeAllProgress = {
    phase: 'enumerating',
    total: 0,
    done: 0,
    ok: 0,
    errors: 0,
    skipped: 0,
    projected: 0,
    currentIndex: 0,
    errorSamples: [],
  };
  const push = () => emit({ ...prog });

  try {
    push();

    // ── Enumerate + size-sort ──────────────────────────────────────
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

    // ── Classify work per model ────────────────────────────────────
    const work: ModelWork[] = [];
    for (const { f } of sized) {
      // llama.cpp launches GGUF only (safetensors in principle).
      // PyTorch/TF checkpoints — .pt / .pth / .bin / .ckpt — can never
      // be characterized; skip them silently rather than erroring.
      if (!/\.(gguf|safetensors)$/i.test(f)) {
        prog.skipped += 1;
        continue;
      }
      if (!skipExisting) {
        // Force re-run everything (« Forcer ») — full characterization.
        work.push({ file: f, kind: 'full' });
        continue;
      }
      const sig = await ls(f).catch(() => undefined);
      // Quarantined (a model llama-server can't run) — never revisit.
      if (sig?.characterization_state === 'failed') {
        prog.skipped += 1;
        continue;
      }
      if (sig?.behavioral && sig.characterization_state === 'complete') {
        // Already complete. Revisit only to backfill free-gen evidence
        // (« Parler libre » on) and only when something is missing.
        if (!opts.freegen) {
          prog.skipped += 1;
          continue;
        }
        const beh = sig.behavioral;
        if (beh.freegen_text && beh.topic_coverage_per_leaf) {
          prog.skipped += 1;
          continue;
        }
        if (beh.freegen_text) {
          // Text already there — projection only (no model relaunch).
          work.push({ file: f, kind: 'project-only' });
          continue;
        }
        // Text missing → generate it (no QCM staircase re-run).
        work.push({ file: f, kind: 'gen' });
        continue;
      }
      // No usable signature → full characterization.
      work.push({ file: f, kind: 'full' });
    }

    // ── Resolve the embedder up-front (once, lazily-used) ─────────
    // The factory returns an EmbedFn that internally spawns
    // `llama-embedding` per invocation, so calling it once here doesn't
    // load anything; it only validates that the binary + the
    // configured GGUF exist. A failure flips `embed` to undefined so
    // every model below skips its projection step (silently — we
    // surface the reason once in the error samples).
    let embed: EmbedFn | undefined;
    const projectionsAsked = !!opts.freegen && !opts.skipProjection;
    if (projectionsAsked) {
      try {
        embed = await re();
      } catch (e) {
        const reason = (e as Error).message;
        // eslint-disable-next-line no-console
        console.warn(`[characterizeAll] projections deferred — ${reason}`);
        prog.errorSamples.push({
          file: '(embedder)',
          error: `projections skipped: ${reason}`,
        });
        // NB: this is not counted in `prog.errors` — it's an info, not
        // a per-model failure. The bulk run still completes "ok".
      }
    }

    // ── PASS — one loop, test then (optionally) project per model ─
    prog.total = work.length;
    prog.phase = 'running';
    push();

    for (let i = 0; i < work.length; i++) {
      if (cancelFlag) {
        prog.phase = 'cancelled';
        push();
        return prog;
      }
      const { file, kind } = work[i];
      prog.currentIndex = i;
      prog.currentFile = file;
      prog.currentName = baseName(file);
      prog.modelStatus = undefined;
      push();

      // Rotate the previous session's `.log` into a timestamped
      // archive so this model's run starts on a clean file AND the
      // prior diagnostic content is preserved (« Garde le log pour
      // chaque modèle dans un fichier propre », 2026-05-24). Best
      // effort: any failure here must NOT block the run.
      await archiveServerLog(file, { skipWrite: opts.skipWrite }).catch(
        () => undefined,
      );

      const onStatus = (s: CharacterizeRunStatus) => {
        prog.modelStatus = s;
        push();
      };

      // Phase 1 — make sure the test work is done.
      let testFailed = false;
      try {
        if (kind === 'full') {
          await rc(file, {
            skipWrite: opts.skipWrite,
            freegen: opts.freegen,
            onStatus,
          });
          prog.ok += 1;
        } else if (kind === 'gen') {
          // Already complete; just make the model talk once.
          await rg(file, { skipWrite: opts.skipWrite, onStatus });
        }
        // kind === 'project-only' ⇒ nothing to do here.
      } catch (e) {
        testFailed = true;
        const reason = (e as Error).message;
        if (isUnsupported(e)) {
          prog.skipped += 1;
          const mu = d.markUnsupported ?? markUnsupported;
          await mu(file, reason, { skipWrite: opts.skipWrite }).catch(
            () => undefined,
          );
        } else {
          prog.errors += 1;
          // eslint-disable-next-line no-console
          console.error(`[characterizeAll] ${baseName(file)}: ${reason}`);
          // No cap — keep every error so the UI's infinite-scroll
          // error tab shows the whole picture for the bulk run.
          prog.errorSamples.push({ file, error: reason });
          // Persist to the per-model `.error` journal alongside the
          // sidecar so the « Erreurs » tab can show the full history
          // even across app restarts.
          await appendErrorLog(file, reason, {
            skipWrite: opts.skipWrite,
          }).catch(() => undefined);
        }
      }

      // Phase 2 — projection. Only when the test phase didn't blow up,
      // free-gen is on, projections aren't suppressed, and the embedder
      // resolved. We reload the signature so we work off whatever phase
      // 1 just wrote (fresh `freegen_text`) or the pre-existing text.
      if (!testFailed && embed && opts.freegen && !opts.skipProjection) {
        try {
          const sig = await ls(file).catch(() => undefined);
          const beh = sig?.behavioral;
          if (beh?.freegen_text && !beh.topic_coverage_per_leaf) {
            await rp(file, embed, {
              skipWrite: opts.skipWrite,
              onStatus,
            });
            prog.projected += 1;
          }
        } catch (e) {
          const reason = (e as Error).message;
          prog.errors += 1;
          // eslint-disable-next-line no-console
          console.error(
            `[characterizeAll] projection ${baseName(file)}: ${reason}`,
          );
          prog.errorSamples.push({
            file,
            error: `projection: ${reason}`,
          });
          await appendErrorLog(file, `projection: ${reason}`, {
            skipWrite: opts.skipWrite,
          }).catch(() => undefined);
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
