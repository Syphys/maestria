// R0.6 — Pure function: canonical hash of (suite + weights + tare-table + embedder).
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.6.

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
 * Compute a stable policy hash from everything that affects scoring identity.
 * Any change invalidates cached behavioral signatures.
 *
 * Inputs we hash:
 *   - suite.id + suite.version + the prompts array (id + axes + prompt text + rubric only — descriptive fields ignored)
 *   - weights (α, β, γ, δ — extend when ε/ζ/η are added)
 *   - tareTableId (semver-like string from tare.ts)
 *   - embedderId (R1.7 — string like "local:bge-m3:Q8" or "openai:text-embedding-3-large")
 */
export function computePolicyHash(args: {
  suite: DiagnosticSuite;
  weights: RoutingWeights;
  tareTableId: string;
  embedderId: string;
}): string {
  const promptsCore = args.suite.prompts.map((p) => ({
    id: p.id,
    axes: [...p.axes].sort(),
    prompt: p.prompt,
    rubric: p.rubric.map((r) => ({ c: r.criterion, w: r.weight })),
    runtime_inject: p.runtime_inject ?? null,
    skip_if: p.skip_if ?? null,
  }));
  const payload = {
    suite: {
      id: args.suite.id,
      version: args.suite.version,
      prompts: promptsCore,
    },
    weights: args.weights,
    tareTableId: args.tareTableId,
    embedderId: args.embedderId,
  };
  return 'sha256:' + sha256Hex(canonicalize(payload));
}

/**
 * Build a complete Policy object with its hash populated.
 */
export function buildPolicy(args: {
  id: string;
  name: string;
  suite: DiagnosticSuite;
  weights: RoutingWeights;
  tareTableId: string;
  embedderId: string;
}): Policy {
  return {
    id: args.id,
    name: args.name,
    suiteVersion: args.suite.id,
    weights: args.weights,
    tareTableId: args.tareTableId,
    policyHash: computePolicyHash({
      suite: args.suite,
      weights: args.weights,
      tareTableId: args.tareTableId,
      embedderId: args.embedderId,
    }),
  };
}
