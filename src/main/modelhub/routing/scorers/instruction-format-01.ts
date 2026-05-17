// Scorer for prompt instruction-format-01: list 7 European capitals in strict format.
// Expected: exactly 7 lines, format `<rank>. <city> | <country> | <ISO-3166-alpha-2>`,
// ranks 1..7 sequential, plausible decreasing-population order, no extras.

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

const KNOWN_CAPITAL_ISO: Record<string, string> = {
  moscow: 'RU',
  moscou: 'RU',
  london: 'GB',
  londres: 'GB',
  berlin: 'DE',
  madrid: 'ES',
  rome: 'IT',
  paris: 'FR',
  bucharest: 'RO',
  bucarest: 'RO',
  warsaw: 'PL',
  varsovie: 'PL',
  amsterdam: 'NL',
  brussels: 'BE',
  bruxelles: 'BE',
  vienna: 'AT',
  vienne: 'AT',
  prague: 'CZ',
  athens: 'GR',
  athènes: 'GR',
  lisbon: 'PT',
  lisbonne: 'PT',
  kyiv: 'UA',
  kiev: 'UA',
  budapest: 'HU',
  stockholm: 'SE',
  copenhagen: 'DK',
  copenhague: 'DK',
  helsinki: 'FI',
  dublin: 'IE',
  oslo: 'NO',
  zagreb: 'HR',
};

const LINE_REGEX =
  /^(\d+)\.\s+([A-Za-zÀ-ÿ' -]+?)\s*\|\s*([A-Za-zÀ-ÿ' -]+?)\s*\|\s*([A-Z]{2})\s*$/;

export const score: DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
): ScoringResult => {
  const partialCriteria: Record<string, boolean> = {};

  const rawLines = response
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  partialCriteria.exactly_7_lines = rawLines.length === 7;

  const parsed: Array<{
    rank: number;
    city: string;
    country: string;
    iso: string;
  }> = [];
  let allMatch = true;
  for (const line of rawLines) {
    const m = line.match(LINE_REGEX);
    if (!m) {
      allMatch = false;
      continue;
    }
    parsed.push({
      rank: parseInt(m[1], 10),
      city: m[2].trim(),
      country: m[3].trim(),
      iso: m[4],
    });
  }
  partialCriteria.format_strict_respected =
    allMatch && parsed.length === rawLines.length;

  // iso_codes_correct: at least 70% of cities have a known matching ISO code
  let isoCorrect = 0;
  for (const p of parsed) {
    const known = KNOWN_CAPITAL_ISO[p.city.toLowerCase()];
    if (known && known === p.iso) isoCorrect++;
  }
  partialCriteria.iso_codes_correct =
    parsed.length > 0 && isoCorrect / parsed.length >= 0.7;

  // ordering_plausible: ranks 1..7 sequential
  partialCriteria.ordering_plausible =
    parsed.length === 7 && parsed.every((p, i) => p.rank === i + 1);

  // no_extra_text: response should ONLY be these lines, no header/footer
  // We've already filtered empty lines; if total response lines = 7, no extras.
  partialCriteria.no_extra_text = rawLines.length === 7 && allMatch;

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass =
    partialCriteria.exactly_7_lines &&
    partialCriteria.format_strict_respected &&
    aggregate >= 0.7;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} parsed=${parsed.length}/${rawLines.length} iso_ok=${isoCorrect}/${parsed.length} [${describeMatched(partialCriteria)}]`,
  };
};
