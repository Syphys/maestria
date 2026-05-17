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
import { loadSidecar, patchSidecar } from '../sidecar';
import { resolveCanonicalShardPath } from '../shardFs';

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
