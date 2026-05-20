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
 * The two-step probe. We ask for a LIST of topics first (model has
 * agency, won't talk about something it doesn't know), then for a
 * deep-dive on its FIRST choice. The first-step list isn't used for
 * embedding (too short, gameable to one-line lies) — the second-step
 * essay is what we embed. The user explicitly asked for « le plus
 * possible librement » — that's the second step's role. The list step
 * is a focusing prime, not a measurement.
 *
 * Why ONE 400-word essay, not several 150-word ones: at <200 words,
 * a model has been observed to mirror the prompt's wording rather
 * than emit its own distribution; longer free-gen drifts INTO the
 * model's training neighbourhood. The 8k context Nomic-style embedder
 * handles 400 words comfortably.
 */
export const FREEGEN_PROMPT = [
  'Step 1 — In ONE line, list 5 topics or domains you know in depth, technical enough that you could write at expert level about them. Use precise terms, not vague labels (e.g. "ribosomal RNA transcription" not "biology"). Format: comma-separated, one line, no numbering.',
  '',
  'Step 2 — Now PICK the topic from your list that you find most fascinating, the one where you have the most precise vocabulary and concrete examples ready. Write 300-400 words on it as if you were composing the opening of a technical blog post for an expert reader.',
  '',
  'Constraints for Step 2:',
  "- Go directly into content — no introduction, no meta-discourse ('In this post we will…').",
  '- Use specialised vocabulary and concrete examples natural to the topic.',
  "- Don't apologise, don't disclaim — assume the reader knows the field and wants depth.",
  '- Write in whichever language feels most natural for the topic.',
  '',
  'Output BOTH steps as plain text, separated by a blank line. No markdown headers, no bullet points.',
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
  // (~1024 tokens, plenty for 400 words).
  const response = await ask.complete(FREEGEN_PROMPT, {
    id: 'freegen-probe',
  });
  const trimmed = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!trimmed) {
    throw new Error('freegen: empty response');
  }
  // We embed the WHOLE response (step 1 list + step 2 essay). Step 1
  // adds keyword density toward declared topics; step 2 adds the
  // distributional fingerprint. Sum > parts.
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
