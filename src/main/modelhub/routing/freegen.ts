// Slice 7c — Free-gen probe (« sonder la teuté du modèle »).
//
// Mechanism: ask the model to write 300-400 words on a topic IT chooses
// from a list it generates itself — no meta-statement ("what are you
// good at"), no leading topic, just an invitation to talk. Embed the
// response, project onto the same shared anchors used by the routing
// path, and store the 32 cosines (one per leaf) as
// `topic_coverage_per_leaf`. This is what surface conceptual content
// the model's training distribution made accessible (a med-LLM will
// naturally talk about cardio; a code-LLM about types and patterns; a
// generic LLM produces vague text and its vector is centred on lang.*).
//
// Decision DCC (§4 carve-out, see DECISIONS.md): the embedder is the
// ONLY non-trivial dependency this slice introduces on the
// characterization path. Justification: the result we persist is NOT a
// 768-d opaque vector but the 32 cosines against the SAME anchors the
// routing path uses — they live on the same `scores_per_leaf` index
// space, are interpretable, and behave as additional EVIDENCE alongside
// the deterministic competence scores (never a replacement). The
// embedder_id is already journalled in the signature.
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
 * Length: 600-800 words (~900-1100 tokens, fits the default
 * max_tokens=1024 ChatClient cap with margin). User asked for closer
 * to 1000, but the chat client caps responses; aiming for 600-800
 * keeps the model from being truncated mid-thought (which would skew
 * the embedding toward the lang.* generic-prose direction).
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

/** What we get back from `runFreeGenProbe`. */
export type FreeGenProbeResult = {
  /** Cosine projection onto each LEAF anchor (the persisted signal). */
  topic_coverage_per_leaf: Record<string, number>;
  /** Projection onto each BRANCH anchor (audit + fast UI summary). */
  topic_coverage_per_branch: Record<string, number>;
  /** Length of the response in words (low → noisy probe). */
  response_words: number;
  /** Raw response truncated for audit (first ~600 chars). */
  response_excerpt: string;
};

/** Excerpt cap for audit storage (full text never persisted). */
const EXCERPT_CHARS = 600;

/**
 * Run the probe end-to-end. Resolves with the projection; throws only
 * if the model returned an empty string OR the embedder returned the
 * wrong number of vectors (real misconfiguration). Caller decides
 * whether to swallow the throw (see characterizeRunner: probe failure
 * never sinks the run).
 */
export async function runFreeGenProbe(
  ask: ChatLike,
  embed: EmbedFn,
  anchors: ProbeAnchorBank,
): Promise<FreeGenProbeResult> {
  // ChatLike.complete only accepts `{ id }` — max tokens are configured
  // on the ChatClient itself. The probe relies on the default cap
  // (2048 tokens since the multistep fix 2026-05-21, plenty for the
  // 600–800 words the FREEGEN_PROMPT requests).
  const response = await ask.complete(FREEGEN_PROMPT, {
    id: 'freegen-probe',
  });
  const trimmed = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!trimmed) {
    throw new Error('freegen: empty response');
  }
  // Embed the entire response (post-<think> trimming) so the cosine
  // projection onto the leaf anchors reflects the model's actual
  // distributional fingerprint over the topics it chose to engage.
  const [responseVec] = await embed([trimmed]);
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
    response_words: trimmed.split(/\s+/).filter(Boolean).length,
    response_excerpt: trimmed.slice(0, EXCERPT_CHARS),
  };
}
