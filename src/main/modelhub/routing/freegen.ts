// Slice 7c — Free-gen probe (« sonder la teuté du modèle »).
//
// Mechanism: ask the model to write 600-800 words on a topic IT chooses
// — no meta-statement ("what are you good at"), no leading topic, just an
// invitation to talk. Embed the response, project onto the same shared
// anchors used by the routing path, and store the 32 cosines (one per
// leaf) as `topic_coverage_per_leaf`. This is what surface conceptual
// content the model's training distribution made accessible (a med-LLM
// will naturally talk about cardio; a code-LLM about types and patterns;
// a generic LLM produces vague text and its vector is centred on lang.*).
//
// TWO PHASES (split 2026-05-22). The probe used to run end-to-end and was
// gated on an embedder being configured — no embedder ⇒ the model never
// even talked. That coupled an offline-friendly step (making the model
// talk) to an online dependency (the embedder). Now:
//   1. `generateFreeGenText(ask)` — chat client ONLY. Always runnable,
//      even before a routing embedder is configured. Returns the FULL
//      monologue so the caller can persist it verbatim (`freegen_text`).
//   2. `projectFreeGenText(text, embed, anchors)` — needs the embedder.
//      Turns a free-gen text into the 32 leaf cosines. Can run right
//      after phase 1, OR much later: re-projecting a stored `freegen_text`
//      once an embedder is finally configured, WITHOUT re-running the
//      model. That's why phase 1 persists the whole text, not an excerpt.
// `runFreeGenProbe` keeps the one-call end-to-end path for the
// embedder-present case (and the unit tests).
//
// Decision DCC (§4 carve-out, see DECISIONS.md): the embedder is the
// ONLY non-trivial dependency this slice introduces on the
// characterization path — and now only phase 2 touches it. Justification:
// the result we persist is NOT a 768-d opaque vector but the 32 cosines
// against the SAME anchors the routing path uses — they live on the same
// `scores_per_leaf` index space, are interpretable, and behave as
// additional EVIDENCE alongside the deterministic competence scores
// (never a replacement). The embedder_id is journalled in the signature.
//
// Pure & dependency-free. The model I/O is `ChatLike`, the embedder is
// `EmbedFn`, the anchors are passed in. Network/I/O lives elsewhere.

import type { ChatLike } from './chat';
import type { EmbedFn } from './embedProject';
import type { ProbeAnchorBank } from '../../../shared/RoutingTypes';
import { anchorOrder, projectFromVectors } from './embedProject';

/**
 * Topic-neutral, open-ended seed prompt (per the « What LLMs Think
 * When You Don't Tell Them What to Think About » 2024 line of work,
 * arxiv 2602.01689). The earlier 2-step design — « first list 5
 * topics, then deep-dive on one » — was demonstrably worse: Step 1
 * introduced self-assessment bias (the model lists what RLHF tells it
 * to claim it knows, not what it actually knows), and Step 2 forced
 * commitment to that potentially-fabricated list. The simpler open
 * prompt lets the model's training distribution emerge directly: a
 * code-LLM naturally surfaces type-system / algorithm vocabulary, a
 * med-LLM surfaces cardio / pharmacology, a tiny model writes vague
 * generic text and its embedding centres on lang.* — exactly the
 * signal we want.
 *
 * Length: 600-800 words (~900-1100 tokens). There is NO max_tokens
 * cap (see chat.ts) — the model is free to finish; 600-800 is asked
 * only to keep the monologue focused, not because of a token ceiling.
 *
 * The ONLY constraint is « no meta-discourse » — without it, ~70% of
 * RLHF-tuned models burn 50-100 words on « As an AI, I find many
 * topics fascinating… » before any real content, which clusters them
 * all in the same useless region of embedding space.
 */
export const FREEGEN_PROMPT = [
  'Talk to me about whatever fascinates you most. Write 600-800 words.',
  '',
  'Go directly into the topic — no introduction, no meta-discourse, no "as an AI…" caveats, no disclaimers about your nature or limitations. Just the content.',
  '',
  'Use specialised vocabulary natural to your chosen topic and write in whichever language feels most fitting.',
].join('\n');

/** Phase-1 output — the raw monologue, before any projection. */
export type FreeGenText = {
  /**
   * Full response, post-<think> trim. Persisted verbatim as
   * `freegen_text` so phase 2 can re-project it later without
   * re-running the model.
   */
  text: string;
  /** Word count of the response (low ⇒ noisy probe signal). */
  words: number;
};

/** Phase-2 output — the cosine projection onto the shared anchors. */
export type FreeGenProjection = {
  /** Cosine projection onto each LEAF anchor (the routing signal). */
  topic_coverage_per_leaf: Record<string, number>;
  /** Projection onto each BRANCH anchor (audit + fast UI summary). */
  topic_coverage_per_branch: Record<string, number>;
};

/** End-to-end result — both phases, kept for the one-call path. */
export type FreeGenProbeResult = FreeGenText & FreeGenProjection;

/**
 * Phase 1 — make the model talk. Needs ONLY the chat client; no
 * embedder. Always runnable, even before a routing embedder is
 * configured. Throws on an empty response (the caller — see
 * characterizeTree — swallows the throw so the probe never sinks the
 * tree pass).
 */
export async function generateFreeGenText(ask: ChatLike): Promise<FreeGenText> {
  // ChatLike.complete only accepts `{ id }`. No max_tokens cap is sent
  // (see chat.ts) — the model writes its full monologue, bounded only
  // by its context window and the request timeout.
  const response = await ask.complete(FREEGEN_PROMPT, {
    id: 'freegen-probe',
  });
  const trimmed = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!trimmed) {
    throw new Error('freegen: empty response');
  }
  return {
    text: trimmed,
    words: trimmed.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Phase 2 — project a free-gen text onto the shared anchors. Needs the
 * embedder. Can run right after phase 1, or later on a stored
 * `freegen_text` once an embedder is configured. Throws if the embedder
 * returns the wrong number of vectors (real misconfiguration).
 */
export async function projectFreeGenText(
  text: string,
  embed: EmbedFn,
  anchors: ProbeAnchorBank,
): Promise<FreeGenProjection> {
  // Embed the entire response (post-<think> trimming) so the cosine
  // projection onto the leaf anchors reflects the model's actual
  // distributional fingerprint over the topics it chose to engage.
  const [responseVec] = await embed([text]);
  const { branchIds, leafIds, texts } = anchorOrder(anchors);
  const anchorVecs = await embed(texts);
  const projection = projectFromVectors(
    responseVec,
    anchorVecs,
    branchIds,
    leafIds,
  );
  return {
    topic_coverage_per_leaf: projection.leaves,
    topic_coverage_per_branch: projection.branches,
  };
}

/**
 * Run the probe end-to-end (phase 1 + phase 2). Convenience for the
 * embedder-present path and the unit tests. Resolves with the text and
 * its projection; throws on an empty response or an embedder
 * misconfiguration. Caller decides whether to swallow the throw.
 */
export async function runFreeGenProbe(
  ask: ChatLike,
  embed: EmbedFn,
  anchors: ProbeAnchorBank,
): Promise<FreeGenProbeResult> {
  const gen = await generateFreeGenText(ask);
  const proj = await projectFreeGenText(gen.text, embed, anchors);
  return { ...gen, ...proj };
}
