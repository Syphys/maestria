// Dette E — shared bedrock for the two routing implementations
// (`router.ts` R5 path + `routeByVectors.ts` SPEC §5 vector path). Both
// gate candidates the SAME way and weight `competence/fit/hot` the SAME
// way — extracted here so a future weight tweak or D9-rule refinement
// happens in ONE place. Pure & dependency-free.
//
// Slice 5b switched the active router from R5-only to vector-first +
// R5 fallback (decision D-…), but the projector swap left two parallel
// copies of these helpers. Keeping them in sync by hand was already a
// known footgun (e.g. the new `scoring_scheme` carries a normalisation
// that's only relevant here); centralise it.

import type { Signature } from '../../../shared/RoutingTypes';

/**
 * Default weights for the final ranking score
 * `competence·C + fit·F + hot·H`. Tuned at v0: competence dominates, a
 * tight memory fit nudges, hot is a small tie-breaker. Anyone overriding
 * a single weight inherits the others via `{ ...ROUTING_DEFAULTS, ...w }`
 * — that's why the object is frozen, to catch accidental mutation.
 */
export const ROUTING_DEFAULTS = Object.freeze({
  competence: 1.0,
  fit: 0.5,
  hot: 0.1,
  priorDiscount: 0.5,
});

/**
 * D9 gate: a candidate can route iff its signature is complete and
 * carries a behavioral block. Returns the human-readable reason it
 * CAN'T route, or `null` when it can. The string is surfaced verbatim
 * in the UI (`ineligibleReason`), so changes here are user-visible.
 */
export function eligibility(sig?: Signature | null): string | null {
  if (!sig) return 'not characterized';
  if (sig.characterization_state === 'failed') return 'quarantined (failed)';
  if (sig.characterization_state !== 'complete') {
    return `not complete (${sig.characterization_state})`;
  }
  if (!sig.behavioral) return 'no behavioral block';
  return null;
}

/**
 * Bring a raw competence score into [0,1] by dividing by the scoring
 * scheme's natural ceiling, then clamping. With `'beta-laplace-v1'`
 * (étape 1) `maxRung` is 1 and this is just `Math.min(1, raw)`. With
 * `'breaking-rung-v0'` legacy `maxRung` is 3 and this divides first.
 * Never returns a negative value — clamps the bottom at 0 too — so
 * callers can dot-product safely without sprinkling `Math.max(0, …)`.
 */
export function normaliseScore(raw: number, maxRung: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw / maxRung);
}
