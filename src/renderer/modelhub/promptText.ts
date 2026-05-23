/**
 * Renderer-side lookup: diagnostic prompt id → human-readable question.
 *
 * A signature's `diagnostic_run` only stores the `promptId` — the actual
 * question text lives in the suite packs. This module imports those packs
 * (pure JSON data, no main-process code) and builds a flat id → text map
 * so the Inférence-tab axis drill-down can show WHAT was asked, not just
 * the id and the model's answer.
 *
 * Covers both packs that feed `diagnostic_run` (see characterize.ts):
 *  - `v1-30.json`  — open prompts (`prompt`)
 *  - `mcq-v1.json` — multiple-choice items (`question` + `options`)
 */

import suiteV1_30 from '../../main/modelhub/routing/questions/v1-30.json';
import mcqV1 from '../../main/modelhub/routing/questions/mcq-v1.json';

type OpenPrompt = { id?: string; prompt?: string };
type McqItem = {
  id?: string;
  question?: string;
  options?: Record<string, string>;
  answer?: string;
};

const byId = new Map<string, string>();

const openPrompts =
  (suiteV1_30 as unknown as { prompts?: OpenPrompt[] }).prompts ?? [];
for (const p of openPrompts) {
  if (p?.id && typeof p.prompt === 'string') {
    byId.set(p.id, p.prompt.trim());
  }
}

const mcqItems = (mcqV1 as unknown as { items?: McqItem[] }).items ?? [];
for (const it of mcqItems) {
  if (!it?.id || typeof it.question !== 'string') continue;
  const opts = it.options
    ? '\n' +
      Object.entries(it.options)
        .map(([k, v]) => `${k}) ${v}`)
        .join('\n')
    : '';
  byId.set(it.id, it.question.trim() + opts);
}

/**
 * Question text for a diagnostic prompt id, or `undefined` when the id
 * isn't in the current packs (e.g. a signature from an older suite
 * version) — callers just omit the question line in that case.
 */
export function promptTextById(id: string): string | undefined {
  return byId.get(id);
}
