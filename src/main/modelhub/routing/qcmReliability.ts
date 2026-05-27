// Slice 4b — QCM judge-candidacy reliability + dual-purpose leaf prior.
// Spec: SEMANTIC_ROUTING_FEATURES/SPEC-vector-routing-v0.md §6bis + Dyy.
//
// qcm_reliability is a META-property of the model's QCM channel (NOT a
// competence, NOT routing): can a future IA-validatrice/judge be picked
// from it.  Two deterministic signals, no judge:
//   • format_adherence — fraction of items yielding ONE parsable choice
//     (`<think>` stripped, D11) — "respects the QCM exercise".
//   • consistency      — same item, options permuted → same SEMANTIC
//     option (free of position/letter bias).
//   • overall          — composite judge-worthiness in [0,1].
// Dual-purpose (Dyy, owner 2026-05-18): the identity-permutation MCQ
// pass also yields a low-confidence per-leaf prior the orchestrator
// (4c) folds via priorDiscount (D12) BESIDE the tree-v0 staircase,
// never replacing it.
//
// Pure + injected `ChatLike`; scoring reuses the existing extractChoice.

import type {
  DiagnosticPrompt,
  QcmReliability,
} from '../../../shared/RoutingTypes';
import type { ChatLike } from './chat';
import { extractChoice } from './scorers/mcq';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

export type QcmReliabilityResult = {
  qcm_reliability: QcmReliability;
  /** Dyy/D12: leaf → mean MCQ pass (identity render). Folded by 4c. */
  leaf_priors: Record<string, number>;
};

/** Deterministic display orderings of `n` options: identity, reverse,
 *  rotate-left-1 (deduped — covers position/letter-bias for ≥3 options). */
function orderings(n: number): number[][] {
  const id = Array.from({ length: n }, (_, i) => i);
  const rev = [...id].reverse();
  const rot = [...id.slice(1), id[0]];
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const p of [id, rev, rot]) {
    const k = p.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/** Render the item with options shown in `order` under fresh letters.
 *  Returns the prompt, the displayed→text map, and where the gold went. */
function render(
  item: DiagnosticPrompt,
  order: number[],
): { prompt: string; map: Record<string, string>; goldLetter: string } {
  const check = item.check as {
    kind: 'mcq';
    answer: string;
    options: Record<string, string>;
  };
  const origLetters = Object.keys(check.options).sort();
  // Stem = prompt text before the first inlined "X)" option line.
  const stem = item.prompt.split(/\n\s*[A-Z]\)/)[0].trimEnd();
  const map: Record<string, string> = {};
  const lines: string[] = [];
  let goldLetter = '';
  order.forEach((origIdx, dispIdx) => {
    const ol = origLetters[origIdx];
    const dl = LETTERS[dispIdx];
    map[dl] = check.options[ol];
    lines.push(`${dl}) ${check.options[ol]}`);
    if (ol === check.answer.toUpperCase()) goldLetter = dl;
  });
  return { prompt: `${stem}\n${lines.join('\n')}`, map, goldLetter };
}

/**
 * Measure qcm_reliability over a QCM suite (qcm-v0). Each item is asked
 * under every deterministic permutation; format_adherence uses the
 * identity render, consistency requires the SAME underlying option text
 * across all permutations. Never throws (model error ⇒ unparsable).
 */
export async function measureQcmReliability(
  prompts: DiagnosticPrompt[],
  ask: ChatLike,
  opts: { signal?: AbortSignal } = {},
): Promise<QcmReliabilityResult> {
  const items = prompts.filter(
    (p) => (p.check as { kind?: string } | undefined)?.kind === 'mcq',
  );
  let formatOk = 0;
  let consistentOk = 0;
  const leafHits: Record<string, { pass: number; n: number }> = {};

  for (const item of items) {
    const check = item.check as {
      answer: string;
      options: Record<string, string>;
    };
    const perms = orderings(Object.keys(check.options).length);
    const chosenTexts: (string | null)[] = [];
    for (let pi = 0; pi < perms.length; pi++) {
      const { prompt, map, goldLetter } = render(item, perms[pi]);
      let resp = '';
      try {
        resp = await ask.complete(prompt, {
          id: `${item.id}#${pi}`,
          signal: opts.signal,
        });
      } catch (e) {
        if (opts.signal?.aborted) throw e; // let cancel propagate
        resp = '';
      }
      const letter = extractChoice(resp, map);
      chosenTexts.push(letter ? map[letter] : null);
      if (pi === 0) {
        // identity render drives format_adherence + the leaf prior
        if (letter) formatOk++;
        if (item.leaf) {
          const e = (leafHits[item.leaf] ??= { pass: 0, n: 0 });
          e.n++;
          if (letter === goldLetter) e.pass++;
        }
      }
    }
    const first = chosenTexts[0];
    if (first !== null && chosenTexts.every((t) => t === first)) consistentOk++;
  }

  const n = items.length;
  const format_adherence = n ? formatOk / n : 0;
  const consistency = n ? consistentOk / n : 0;
  const leaf_priors: Record<string, number> = {};
  for (const [leaf, e] of Object.entries(leafHits))
    leaf_priors[leaf] = e.n ? e.pass / e.n : 0;

  return {
    qcm_reliability: {
      format_adherence,
      consistency,
      overall: 0.5 * format_adherence + 0.5 * consistency,
      n,
    },
    leaf_priors,
  };
}
