// Tare lookup table for quantization-induced degradation.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.1.
//
// Values are tare in [0..1] where 0 = pristine fp16/bf16, 1 = unusable.
// Numbers are best-effort from: llama.cpp PPL benchmarks, Unsloth dynamic-quant
// publications, ik_llama.cpp recipe analyses, community benchmarks on common 7B-70B models.
// They are heuristic, intentionally rounded — used as a soft penalty, not as ground truth.
//
// Conventions on the input string `quant`:
//   - Case-insensitive matching, leading 'i1-' and 'UD-' prefixes recognized.
//   - Suffixes like '_XL', '_K_XL', '_R4', '_K_R4', '_K_S/M/L' affect the lookup.
//   - Unknown formats fall back to a structural guess by bits-per-weight when available.

export type TareModifier = {
  /** Filename substring (lowercased) that triggers this modifier. */
  fileNameContains: string;
  /** Additive bump applied to base tare. Capped at 1.0 overall. */
  delta: number;
  /** Short reason logged for auditability. */
  reason: string;
};

const BASE: Record<string, number> = {
  // Float reference
  f16: 0.0,
  bf16: 0.0,
  fp16: 0.0,
  fp8: 0.03,

  // Q8 family
  q8_0: 0.02,
  q8_k_xl: 0.02,
  'ud-q8_k_xl': 0.02,
  q8_k: 0.02,

  // Q6 family
  q6_k: 0.05,
  'i1-q6_k': 0.05,
  q6_k_xl: 0.05,
  q6_k_r4: 0.06,

  // Q5 family
  q5_k_m: 0.1,
  q5_k_s: 0.12,
  'i1-q5_k_m': 0.1,
  'i1-q5_k_s': 0.12,

  // Q4 family — workhorse range
  q4_k_m: 0.15,
  q4_k_s: 0.2,
  'i1-q4_k_m': 0.15,
  'i1-q4_k_s': 0.2,
  q4_0: 0.22,
  iq4_k_r4: 0.2,
  iq4_xs: 0.22,
  iq4_nl: 0.2,

  // Q3 — getting dicey
  q3_k_m: 0.32,
  q3_k_s: 0.38,
  iq3_k_r4: 0.4, // aggressive on experts, see GLM-5.1 session
  iq3_m: 0.38,
  iq3_s: 0.42,
  iq3_xs: 0.45,
  iq3_xxs: 0.5,

  // Q2 — usable mostly for very large models
  q2_k: 0.55,
  iq2_m: 0.55,
  iq2_s: 0.6,
  iq2_xs: 0.62,
  iq2_xxs: 0.65,

  // IQ1 — heroic
  iq1_m: 0.7,
  iq1_s: 0.72,
};

const MODIFIERS: TareModifier[] = [
  {
    fileNameContains: 'abliterated',
    delta: 0.1,
    reason:
      'abliteration may impair instruction-following and refusal calibration',
  },
  {
    fileNameContains: 'heretic',
    delta: 0.1,
    reason: 'heretic finetune (anti-refusal) often degrades reasoning',
  },
  {
    fileNameContains: 'uncensored',
    delta: 0.05,
    reason: 'uncensored variants generally diverge from base',
  },
  {
    fileNameContains: 'dpo',
    delta: -0.02,
    reason: 'DPO finetuning generally aligns better — small reduction',
  },
];

/**
 * Look up the tare for a quantization string. Falls back conservatively when unknown.
 * Filename is optional but recommended — enables modifier detection (abliterated/heretic/...).
 */
export function quantToTare(
  quant: string,
  fileName?: string,
): { tare: number; reasons: string[] } {
  const reasons: string[] = [];
  const key = quant.toLowerCase().trim();
  let tare = BASE[key];

  if (tare === undefined) {
    // Fallback heuristic: try to extract bits-per-weight or generic family
    const m = key.match(/q(\d)/);
    if (m) {
      const bits = parseInt(m[1], 10);
      // Linear-ish interpolation
      tare =
        bits >= 6
          ? 0.05
          : bits === 5
            ? 0.12
            : bits === 4
              ? 0.2
              : bits === 3
                ? 0.4
                : bits === 2
                  ? 0.55
                  : 0.7;
      reasons.push(`base: fallback by bits-per-weight ≈ ${bits}`);
    } else {
      tare = 0.5; // conservative middle value for unknown formats
      reasons.push('base: unknown quantization, conservative fallback 0.50');
    }
  } else {
    reasons.push(`base: ${key} → ${tare}`);
  }

  if (fileName) {
    const fnLower = fileName.toLowerCase();
    for (const mod of MODIFIERS) {
      if (fnLower.includes(mod.fileNameContains)) {
        tare += mod.delta;
        reasons.push(
          `${mod.delta >= 0 ? '+' : ''}${mod.delta} (${mod.reason})`,
        );
      }
    }
  }

  // Cap to [0, 1]
  tare = Math.max(0, Math.min(1, tare));
  return { tare, reasons };
}

/** Stable identifier for the table — used in policyHash computation (R0.6).
 *  Bump this string whenever BASE/MODIFIERS change: it invalidates every
 *  cached behavioral signature derived under the old table. */
export const TARE_TABLE_ID = 'tare-v1-2026-05';
