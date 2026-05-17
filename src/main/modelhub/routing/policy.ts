// R0.6 — Hashes that gate signature validity vs. decision provenance.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.6 ; arbitration: DECISIONS.md D8.
//
// D8 (authoritative — supersedes the spec on this point): a model's
// BEHAVIORAL signature is intrinsic to (model × suite × embedder). It does
// NOT depend on the routing weights (α/β/γ). Those, plus live resource state
// (free VRAM/RAM, hot/resident model, queue depth, fit), are applied at
// *routing time* by the dynamic, capability-aware scorer (R5). Changing a
// weight must re-rank instantly — never re-characterize.
//
// Therefore two distinct hashes:
//   • signatureHash = sha256(suiteCore + embedderId)
//       The ONLY thing that invalidates a cached behavioral signature
//       (together with modelHash + suite_version). Used by signatureStore
//       (R0.3) to decide "is this signature still trustworthy?".
//   • policyHash    = sha256(suiteCore + weights + embedderId)
//       AUDIT ONLY. Stamped into a RoutingDecision so a past ranking is
//       reproducible. Never gates signature validity.

import { createHash } from 'node:crypto';
import type {
  DiagnosticSuite,
  RoutingWeights,
  Policy,
} from '../../../shared/RoutingTypes';

/**
 * Canonical JSON: keys sorted, no whitespace. Same input → same string → same hash.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonicalize((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * The part of a suite that actually changes what a model is asked to do:
 * id + version + (per prompt) id, axes, prompt text, rubric, runtime inject,
 * skip rule. Descriptive fields (name/description/createdAt) are ignored —
 * editing a comment must not invalidate signatures.
 */
function suiteCore(suite: DiagnosticSuite) {
  return {
    id: suite.id,
    version: suite.version,
    prompts: suite.prompts.map((p) => ({
      id: p.id,
      axes: [...p.axes].sort(),
      prompt: p.prompt,
      rubric: p.rubric.map((r) => ({ c: r.criterion, w: r.weight })),
      runtime_inject: p.runtime_inject ?? null,
      skip_if: p.skip_if ?? null,
    })),
  };
}

/**
 * Invalidation key for a behavioral signature. A cached signature is trusted
 * iff its stored signatureHash matches this AND its modelHash still matches
 * the file on disk. Weights / live capabilities are deliberately NOT inputs
 * (D8) — they only affect routing-time ranking, not the measurements.
 */
export function computeSignatureHash(args: {
  suite: DiagnosticSuite;
  embedderId: string;
}): string {
  return (
    'sha256:' +
    sha256Hex(
      canonicalize({
        suite: suiteCore(args.suite),
        embedderId: args.embedderId,
      }),
    )
  );
}

/**
 * Provenance hash for a routing decision (audit only). Includes the weights
 * so a past ranking can be reproduced exactly. MUST NOT be used to decide
 * whether a behavioral signature is stale — see {@link computeSignatureHash}
 * and DECISIONS.md D8.
 */
export function computePolicyHash(args: {
  suite: DiagnosticSuite;
  weights: RoutingWeights;
  embedderId: string;
}): string {
  return (
    'sha256:' +
    sha256Hex(
      canonicalize({
        suite: suiteCore(args.suite),
        weights: args.weights,
        embedderId: args.embedderId,
      }),
    )
  );
}

/**
 * Build a complete Policy object with its (audit) hash populated.
 */
export function buildPolicy(args: {
  id: string;
  name: string;
  suite: DiagnosticSuite;
  weights: RoutingWeights;
  embedderId: string;
}): Policy {
  return {
    id: args.id,
    name: args.name,
    suiteVersion: args.suite.id,
    weights: args.weights,
    policyHash: computePolicyHash({
      suite: args.suite,
      weights: args.weights,
      embedderId: args.embedderId,
    }),
  };
}
