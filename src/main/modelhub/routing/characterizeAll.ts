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
import {
  clearSignaturesUnder,
  loadSignature,
  markUnsupported,
} from './signatureStore';
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
import { listRunning, stopProcess } from '../runners/launch';

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
// Aborted on `cancelCharacterizeAll()` and re-created at the start of
// every new run. Propagated through `RunCharacterizationOptions.signal`
// → `CharacterizeOptions.signal` → `chat.complete({ signal })` so an
// in-flight HTTP request to llama-server is killed immediately; the
// inner prompt loop also re-checks `.aborted` between every iteration.
let cancelController: AbortController | undefined;

export function isCharacterizeAllRunning(): boolean {
  return running;
}

/**
 * Request a stop. Immediate: the current chat.complete()'s fetch is
 * aborted (server-side generation ends on the disconnect), the inner
 * prompt loop sees `signal.aborted` at its next check, and the outer
 * model loop bails on `cancelFlag` at the next boundary. No "wait for
 * the current model to finish" — that was the old contract, replaced
 * because a 30k-token runaway generation could hold the run hostage
 * for minutes per stuck model.
 *
 * DEFENCE-IN-DEPTH: also kills any llama-server we LAUNCHED for the
 * characterization pass that hasn't been stopped yet by
 * runCharacterization's finally. Symptoms this catches: a tree-pass
 * abort that for some reason didn't reach the runner's finally, or a
 * launch that completed but whose pid never made it back into the
 * `ephemeral` tracking. Without this, the user sees the « Cancel »
 * click leave llama-server alive in the supervisor panel and is
 * unable to relaunch a fresh characterization without manually
 * killing the orphan server.
 */
export function cancelCharacterizeAll(): void {
  if (!running) return;
  cancelFlag = true;
  cancelController?.abort();
  for (const entry of listRunning()) {
    if (entry.exited) continue;
    if (entry.launchedBy !== 'characterize') continue;
    try {
      stopProcess(entry.pid);
    } catch {
      // already gone — harmless
    }
  }
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
  // Fresh AbortController per run — old aborted ones can't be reused.
  cancelController = new AbortController();
  const signal = cancelController.signal;

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

    // ── Forcer = reset BEFORE the loop ─────────────────────────────
    // Wipe every existing `signature` block so an interrupted run
    // leaves the un-reached models with NO signature (resumable). A
    // subsequent invocation — whether Forcer is still ticked or not
    // — picks up exactly where this one stopped, instead of silently
    // skipping the half-processed library because the old signatures
    // still look `complete`. See the user-visible confirmation dialog
    // in CharacterizeAllPanel.tsx for the warning shown beforehand.
    if (!skipExisting) {
      try {
        const cleared = await clearSignaturesUnder(rootDir, {
          skipWrite: opts.skipWrite,
        });
        if (cleared.cleared > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[characterizeAll] Forcer: cleared ${cleared.cleared} signature(s) ` +
              `(scanned ${cleared.scanned}, skipped ${cleared.skipped})`,
          );
        }
      } catch (e) {
        // Reset failure is logged but does NOT block the run — the
        // worst case is the legacy behaviour (skipExisting=false still
        // re-does every model, just without the clean-slate guarantee).
        const reason = (e as Error).message;
        // eslint-disable-next-line no-console
        console.warn(
          `[characterizeAll] Forcer reset failed — continuing without wipe: ${reason}`,
        );
        prog.errorSamples.push({
          file: '(reset)',
          error: `signature wipe failed: ${reason}`,
        });
      }
    }

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
            signal,
          });
          prog.ok += 1;
        } else if (kind === 'gen') {
          // Already complete; just make the model talk once.
          await rg(file, { skipWrite: opts.skipWrite, onStatus, signal });
        }
        // kind === 'project-only' ⇒ nothing to do here.
      } catch (e) {
        // User cancelled mid-flight — don't count it as a regular
        // failure (no error log, no errorSamples bump). The outer
        // loop's `if (cancelFlag)` will catch up next iteration and
        // set the terminal `cancelled` phase.
        if (cancelFlag) {
          break;
        }
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
    cancelController = undefined;
  }
}
