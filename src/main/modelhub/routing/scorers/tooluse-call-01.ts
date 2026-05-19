// Scorer for tooluse-call-01 (slice 6e, axis `tooluse`).
// The model must emit ONLY a JSON tool call get_weather(city, unit) for
// "weather in Paris, in Celsius". Fully deterministic (D3, no judge):
// parse the JSON, check name + args + that no prose leaked around it.

import type { DiagnosticPrompt } from '../../../../shared/RoutingTypes';
import {
  type ScoringResult,
  type DeterministicScorer,
  aggregateScore,
  describeMatched,
} from './_types';

/** Strip <think>…</think> (D11) and ```json fences. */
function clean(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
}

/** First balanced top-level {...} object substring, or null. */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export const score: DeterministicScorer = (
  response: string,
  prompt: DiagnosticPrompt,
): ScoringResult => {
  const c = clean(response);
  const jsonStr = firstJsonObject(c);
  const partialCriteria: Record<string, boolean> = {};

  let parsed: { name?: unknown; arguments?: Record<string, unknown> } | null =
    null;
  if (jsonStr) {
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = null;
    }
  }

  partialCriteria.valid_json = parsed !== null && typeof parsed === 'object';

  const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  partialCriteria.correct_tool_name = /^get_weather$/i.test(name);

  const args =
    parsed && typeof parsed.arguments === 'object' && parsed.arguments
      ? (parsed.arguments as Record<string, unknown>)
      : {};
  const city = typeof args.city === 'string' ? args.city : '';
  const unit = typeof args.unit === 'string' ? args.unit : '';
  partialCriteria.correct_args =
    /paris/i.test(city) && /^c(elsius)?$/i.test(unit.trim());

  // no_prose: nothing of substance outside the JSON object.
  const outside = jsonStr ? c.replace(jsonStr, '').trim() : c;
  partialCriteria.no_prose = jsonStr !== null && outside.length === 0;

  const aggregate = aggregateScore(partialCriteria, prompt);
  const pass =
    partialCriteria.valid_json &&
    partialCriteria.correct_tool_name &&
    aggregate >= 0.7;

  return {
    pass,
    score: aggregate,
    partialCriteria,
    detail: `score=${aggregate.toFixed(2)} name="${name}" city="${city}" unit="${unit}" [${describeMatched(partialCriteria)}]`,
  };
};
