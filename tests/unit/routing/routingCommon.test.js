// Dette E — shared eligibility/DEFAULTS/normalise helpers used by both
// `router.ts` and `routeByVectors.ts`. These are user-visible strings
// (`ineligibleReason`) and the basis of every routing weight tweak, so
// they get their own unit suite — one cheap regression net guarding
// against accidental drift between the two routing paths.
import { describe, expect, test } from '@playwright/test';
import {
  ROUTING_DEFAULTS,
  eligibility,
  normaliseScore,
} from '../../../src/main/modelhub/routing/routingCommon';

const sig = (state, behavioral = { scores_per_axis: {} }) => ({
  modelHash: 'h',
  structural: {},
  behavioral,
  characterization_state: state,
  characterization_error: null,
  suite_version: 'tree-v0',
});

describe('ROUTING_DEFAULTS', () => {
  test('exact v0 weights (frozen)', () => {
    expect(ROUTING_DEFAULTS).toEqual({
      competence: 1.0,
      fit: 0.5,
      hot: 0.1,
      priorDiscount: 0.5,
    });
    // Frozen ⇒ accidental mutation throws in strict mode (modules are).
    expect(() => {
      ROUTING_DEFAULTS.competence = 999;
    }).toThrow();
  });
});

describe('eligibility (D9 gate)', () => {
  test('null / undefined signature ⇒ not characterized', () => {
    expect(eligibility(null)).toBe('not characterized');
    expect(eligibility(undefined)).toBe('not characterized');
  });
  test('quarantined failed', () => {
    expect(eligibility(sig('failed'))).toBe('quarantined (failed)');
  });
  test('pending / running / unknown ⇒ not complete (X)', () => {
    expect(eligibility(sig('pending'))).toBe('not complete (pending)');
    expect(eligibility(sig('running'))).toBe('not complete (running)');
  });
  test('complete but no behavioral block ⇒ no behavioral block', () => {
    expect(eligibility(sig('complete', null))).toBe('no behavioral block');
  });
  test('complete + behavioral ⇒ null (eligible)', () => {
    expect(eligibility(sig('complete'))).toBeNull();
  });
});

describe('normaliseScore', () => {
  test('beta-laplace-v1 path (maxRung=1) is a clamp', () => {
    expect(normaliseScore(0.8, 1)).toBe(0.8);
    expect(normaliseScore(1, 1)).toBe(1);
    expect(normaliseScore(1.5, 1)).toBe(1); // clamped at top
  });
  test('breaking-rung-v0 path (maxRung=3) divides then clamps', () => {
    expect(normaliseScore(3, 3)).toBe(1);
    expect(normaliseScore(2, 3)).toBeCloseTo(2 / 3, 6);
    expect(normaliseScore(4, 3)).toBe(1); // clamped at top
  });
  test('non-finite, negative, zero ⇒ 0 (defensive)', () => {
    expect(normaliseScore(0, 1)).toBe(0);
    expect(normaliseScore(-0.5, 1)).toBe(0);
    expect(normaliseScore(NaN, 1)).toBe(0);
    // Non-finite hits the guard BEFORE the divide ⇒ 0, never propagates a
    // poisoned `Infinity` into the dot-product downstream.
    expect(normaliseScore(Infinity, 1)).toBe(0);
  });
});
