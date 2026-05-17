// Scorer for prompt meta-classify-01: classify a Python Fibonacci prompt as JSON.
// Expected: valid JSON, mentions code/python domain, lang=fr, constraints count = 3 or 4.

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

function extractJson(text: string): { json: any | null; raw: string | null } {
  // Try code-fenced block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      return { json: JSON.parse(fenced[1]), raw: fenced[1] };
    } catch {
      /* fall through */
    }
  }
  // Try the largest {...} block
  const direct = text.match(/(\{[\s\S]*\})/);
  if (direct) {
    try {
      return { json: JSON.parse(direct[1]), raw: direct[1] };
    } catch {
      /* fall through */
    }
  }
  return { json: null, raw: null };
}

function findValueAnyCase(obj: any, predicate: (val: any) => boolean): boolean {
  if (obj === null || obj === undefined) return false;
  if (predicate(obj)) return true;
  if (Array.isArray(obj))
    return obj.some((x) => findValueAnyCase(x, predicate));
  if (typeof obj === 'object') {
    return Object.values(obj).some((v) => findValueAnyCase(v, predicate));
  }
  return false;
}

export const score: DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
): ScoringResult => {
  const partialCriteria: Record<string, boolean> = {};
  const { json: parsed, raw } = extractJson(response);

  partialCriteria.output_is_valid_json = parsed !== null;

  if (parsed) {
    // correct_domain_classification: somewhere a value mentions code/python/programmation
    partialCriteria.correct_domain_classification = findValueAnyCase(
      parsed,
      (v) => typeof v === 'string' && /code|python|programm/i.test(v),
    );

    // counts_constraints_correctly_3_or_4: somewhere a numeric 3 or 4
    partialCriteria.counts_constraints_correctly_3_or_4 = findValueAnyCase(
      parsed,
      (v) => v === 3 || v === 4 || v === '3' || v === '4',
    );

    // language_correctly_fr: lang/language/langue field = fr/french
    partialCriteria.language_correctly_fr = findValueAnyCase(
      parsed,
      (v) => typeof v === 'string' && /^(fr|fra|french|français)$/i.test(v),
    );
  } else {
    partialCriteria.correct_domain_classification = false;
    partialCriteria.counts_constraints_correctly_3_or_4 = false;
    partialCriteria.language_correctly_fr = false;
  }

  // no_extra_text_outside_json
  if (raw) {
    const responseTrimmed = response.trim();
    const idx = responseTrimmed.indexOf(raw);
    if (idx >= 0) {
      const before = responseTrimmed.substring(0, idx);
      const after = responseTrimmed.substring(idx + raw.length);
      const cleanBefore = before.replace(/```(?:json)?\s*$/, '').trim();
      const cleanAfter = after.replace(/^\s*```\s*$/, '').trim();
      partialCriteria.no_extra_text_outside_json =
        cleanBefore.length === 0 && cleanAfter.length === 0;
    } else {
      partialCriteria.no_extra_text_outside_json = false;
    }
  } else {
    partialCriteria.no_extra_text_outside_json = false;
  }

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass = partialCriteria.output_is_valid_json && aggregate >= 0.6;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} valid=${partialCriteria.output_is_valid_json} [${describeMatched(partialCriteria)}]`,
  };
};
