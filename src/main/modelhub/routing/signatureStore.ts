// R0.3 — Sidecar `signature` block: read/write helpers + D8 freshness rule.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.3 ; arbitration: DECISIONS.md D8.
//
// The signature lives as a top-level `signature` key in the model's TagSpaces
// sidecar (`.ts/<file>.json`), alongside `modelMeta`/`tags`. Writes are
// gated by the read-only flag — callers pass `skipWrite: loc.isReadOnly`,
// exactly like the rest of the modelhub sidecar IO. We resolve the canonical
// shard first so a sharded model's signature always lands on shard 1's
// sidecar (codebase shard convention).

import type {
  Signature,
  StructuralSignature,
} from '../../../shared/RoutingTypes';
import { promises as fs } from 'fs';
import path from 'path';
import { loadSidecar, patchSidecar, sidecarPathFor } from '../sidecar';
import { resolveCanonicalShardPath } from '../shardFs';
import { listModelFiles } from '../listModelFiles';

/** Returns the stored signature for a model (canonical shard), or undefined. */
export async function loadSignature(
  filePath: string,
): Promise<Signature | undefined> {
  const canonical = await resolveCanonicalShardPath(filePath);
  const sidecar = await loadSidecar(canonical);
  return sidecar.signature;
}

/**
 * Persist a full signature block. Honours `skipWrite` (read-only locations)
 * and the filesystem-says-no fallback via `patchSidecar`. Other sidecar
 * fields (modelMeta, tags, description, …) are preserved untouched.
 */
export async function saveSignature(
  filePath: string,
  signature: Signature,
  options: { skipWrite?: boolean } = {},
): Promise<{ written: boolean; sidecarPath: string }> {
  const canonical = await resolveCanonicalShardPath(filePath);
  return patchSidecar(canonical, { signature }, options);
}

/**
 * Shallow-merge a partial into the existing signature (or create a fresh
 * pending one if absent). Used for cheap state transitions
 * (`characterization_state` pending→running→complete, error stamps) without
 * rewriting the whole block.
 */
export async function patchSignature(
  filePath: string,
  patch: Partial<Signature>,
  options: { skipWrite?: boolean } = {},
): Promise<{ written: boolean; sidecarPath: string }> {
  const existing = await loadSignature(filePath);
  const merged: Signature = { ...(existing as Signature), ...patch };
  return saveSignature(filePath, merged, options);
}

/**
 * Build the initial signature stored at ParseAll: structural is known
 * immediately (R0.4), behavioral comes later (R3/R4). Everything D8 keys on
 * (`signature_hash`, `embedder_id`, `policy_hash`, `characterized_at`) stays
 * null until the model is actually characterized.
 */
export function makePendingSignature(args: {
  modelHash: string;
  structural: StructuralSignature;
  suiteVersion: string;
}): Signature {
  return {
    modelHash: args.modelHash,
    structural: args.structural,
    behavioral: null,
    signature_hash: null,
    embedder_id: null,
    policy_hash: null,
    characterized_at: null,
    characterization_state: 'pending',
    characterization_error: null,
    suite_version: args.suiteVersion,
  };
}

const UNKNOWN_STRUCTURAL: StructuralSignature = {
  architecture: 'unknown',
  params: { total_b: 0, active_b: null },
  quantization: 'unknown',
  modality: 'text',
  context_max: 0,
  est_footprint_bytes: 0,
};

/**
 * Quarantine a model that llama-server can't run (e.g. ASR `whisper`,
 * `clip`, an embedding-only arch, or any boot-crash). Persists a `failed`
 * signature so bulk characterization skips it on every subsequent pass
 * instead of re-launching a known-bad model. `skipWrite` honoured.
 */
export async function markUnsupported(
  filePath: string,
  reason: string,
  options: { skipWrite?: boolean } = {},
): Promise<{ written: boolean; sidecarPath: string }> {
  const existing = await loadSignature(filePath);
  const base =
    existing ??
    makePendingSignature({
      modelHash: 'sha256:unknown',
      structural: UNKNOWN_STRUCTURAL,
      suiteVersion: 'n/a',
    });
  const failed: Signature = {
    ...base,
    behavioral: null,
    characterization_state: 'failed',
    characterization_error: reason,
  };
  return saveSignature(filePath, failed, options);
}

/**
 * D8 freshness rule for the BEHAVIORAL block. It is trustworthy iff it was
 * completed AND the model weights, the suite+embedder identity, and the
 * suite version all still match. Pure — the caller is responsible for the
 * I/O of recomputing `modelHash` (R0.2) and `signatureHash` (R0.6) before
 * calling this. Weights/tare/live-capabilities are deliberately NOT inputs
 * (D8): tuning a routing weight must never invalidate a signature.
 */
export function isBehavioralFresh(
  sig: Signature | undefined,
  expected: { modelHash: string; signatureHash: string; suiteVersion: string },
): boolean {
  if (!sig || sig.behavioral === null) return false;
  return (
    sig.characterization_state === 'complete' &&
    sig.modelHash === expected.modelHash &&
    sig.signature_hash === expected.signatureHash &&
    sig.suite_version === expected.suiteVersion
  );
}

/** Convenience: true when a model needs (re-)characterization. */
export function needsCharacterization(
  sig: Signature | undefined,
  expected: { modelHash: string; signatureHash: string; suiteVersion: string },
): boolean {
  return !isBehavioralFresh(sig, expected);
}

/**
 * Count every model under `rootDir` that currently carries a `signature`
 * block (regardless of `characterization_state` — `complete`, `failed`,
 * `pending` and `running` all count). Used by the renderer's
 * "Forcer + TOUT CARACTÉRISER" confirmation dialog to preview the
 * destructive scope BEFORE the wipe happens.
 *
 * Pure read — never writes anything. Sidecar JSON read failures (corrupt
 * file, permission denied) silently skip the file rather than throwing,
 * since the goal is a best-effort *preview* count, not a correctness
 * gate. Errors that matter (no models in folder, root unreadable)
 * surface naturally via the empty / 0 result.
 */
export async function countSignaturesUnder(
  rootDir: string,
): Promise<{ scanned: number; withSignature: number }> {
  const files = await listModelFiles(rootDir).catch(() => [] as string[]);
  let withSignature = 0;
  for (const f of files) {
    try {
      const sidecar = await loadSidecar(f);
      if (sidecar.signature) withSignature += 1;
    } catch {
      /* skip — best effort */
    }
  }
  return { scanned: files.length, withSignature };
}

/**
 * Remove the `signature` block from every model sidecar under `rootDir`.
 * Other fields (`modelMeta`, `tags`, `description`, …) are preserved
 * untouched — only the routing/characterization layer is wiped. Used by
 * `characterizeAll` when invoked with `skipExisting: false` so a forced
 * bulk run starts from a clean slate AND remains resumable: an interrupt
 * leaves the un-reached models with NO signature, so a subsequent run
 * (with or without Forcer) re-characterizes them rather than skipping
 * stale data.
 *
 * Honours `skipWrite` (read-only locations short-circuit to a no-op
 * with the count of what *would* have been cleared).
 */
export async function clearSignaturesUnder(
  rootDir: string,
  options: { skipWrite?: boolean } = {},
): Promise<{ scanned: number; cleared: number; skipped: number }> {
  const files = await listModelFiles(rootDir).catch(() => [] as string[]);
  let cleared = 0;
  let skipped = 0;
  for (const f of files) {
    let sidecar;
    try {
      sidecar = await loadSidecar(f);
    } catch {
      skipped += 1;
      continue;
    }
    if (!sidecar.signature) continue;
    if (options.skipWrite) {
      cleared += 1; // counted as "would have cleared"
      continue;
    }
    try {
      const metaPath = sidecarPathFor(f);
      // Build a fresh object without the `signature` key — assignment
      // to `undefined` doesn't actually delete the key from the
      // in-memory shape (Object.keys would still surface it), and we
      // want clean JSON on disk.
      const { signature: _drop, ...rest } = sidecar;
      await fs.mkdir(path.dirname(metaPath), { recursive: true });
      await fs.writeFile(metaPath, JSON.stringify(rest, null, 2), 'utf-8');
      cleared += 1;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Same fallback semantics as patchSidecar — read-only locations
      // surface as "skipped" rather than throwing, so a partially
      // read-only tree doesn't abort the whole sweep.
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        skipped += 1;
        continue;
      }
      throw e;
    }
  }
  return { scanned: files.length, cleared, skipped };
}
