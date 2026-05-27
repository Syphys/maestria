// Slice 2 — Deterministic characterization runner.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R2.6 ; arbitration: DECISIONS.md
// D3 / D3.2 / D8.A / D8.B.
//
// Takes a launched `llama-server` (OpenAI-compatible API), runs the
// embedding-free / judge-free scorable questions against it, scores each
// deterministically, aggregates a per-axis competence vector, and persists
// it into the model's sidecar `signature.behavioral`.
//
// Scope (Slice 2): the callable engine + its validation only. NOT in scope:
// UI/trigger, MCP tool (R8.2), queue manager (R3.5 — single run here),
// embeddings/behavior_centroid, judge, code-exec sandbox (D5.1).

import type {
  DiagnosticSuite,
  DiagnosticPrompt,
  DiagnosticAxis,
  DiagnosticRunEntry,
  BehavioralSignature,
  Signature,
  StructuralSignature,
  CharacterizationProgress,
} from '../../../shared/RoutingTypes';
import { getScorer } from './scorers/index';
import { scoreMcq, type McqItem, type McqPack } from './scorers/mcq';
import { aggregateCompetence, type ScoredItem } from './competence';
import { computeModelHash } from './modelHash';
import { computeCharacterizationHash } from './policy';
import {
  loadSignature,
  saveSignature,
  makePendingSignature,
} from './signatureStore';
import { ChatClient, type ChatLike } from './chat';
import { sumShardBytes } from '../shardFs';
// Static imports so webpack inlines the question packs into the main
// bundle. Reading them from `__dirname/questions` broke in the packaged /
// dev app: the bundled main lives in `.erb/dll` (or the asar), where the
// JSON files don't exist (ENOENT). The smoke worked only because ts-node
// runs from source. Same pattern the smoke already uses for mcq-v1.json.
import suiteV1_30 from './questions/v1-30.json';
import mcqV1 from './questions/mcq-v1.json';

/**
 * Adaptive quarantine signal — true when the response is non-empty BUT
 * consists ENTIRELY of special-token sequences (`<|stop_1|>`,
 * `<|audio_0|>`, etc.). That output shape is the universal fingerprint
 * of a TTS / audio-codec GGUF that wraps an LLM backbone (Cosyvoice
 * et al.) and slipped past the name/arch pre-filters.
 *
 * Conservative: returns false on empty responses (could be a transient
 * server cancel) and on responses with any printable letter — those
 * are real chat outputs we must keep scoring.
 */
/**
 * Quintuplon detector: returns true when `text` exhibits 5+ consecutive
 * identical fragments (line-level or block-level). Used to flag
 * runaway-generation responses where the model loops on its own output
 * (Unsloth Qwen3.5 / DeepSeek-Prover « Okay, I will stop. The prompt
 * is: 3x² + Nx + N » pattern). Conservative: only fires on real
 * repetition, not on creative writing that happens to reuse short
 * phrases. Single-pass O(n).
 *
 * Two checks:
 *   1. line-level (≥ 20 chars, ≥ 5 in a row, exactly equal) — catches
 *      the « repeated paragraph » failure mode.
 *   2. block-level (200-char windows stepping 50, 5 identical in a
 *      row) — catches the « repeated structural template » failure
 *      mode where line splits don't align with the loop boundary.
 *
 * Exported for tests.
 */
export function detectQuintuplon(text: string, k: number = 5): boolean {
  if (!text) return false;
  // 1. Line-level
  const lines = text.split('\n').map((l) => l.trim());
  let prev: string | undefined;
  let streak = 0;
  for (const line of lines) {
    if (line.length < 20) {
      streak = 0;
      prev = undefined;
      continue;
    }
    if (line === prev) {
      streak += 1;
      if (streak >= k - 1) return true;
    } else {
      streak = 0;
      prev = line;
    }
  }
  // 2. Block-level: 200-char windows, step 50
  const winLen = 200;
  if (text.length >= winLen * k) {
    for (let start = 0; start + winLen * k <= text.length; start += 50) {
      const ref = text.slice(start, start + winLen);
      let allSame = true;
      for (let j = 1; j < k; j += 1) {
        const slice = text.slice(start + j * winLen, start + (j + 1) * winLen);
        if (slice !== ref) {
          allSame = false;
          break;
        }
      }
      if (allSame) return true;
    }
  }
  return false;
}

function looksLikeNonTextResponse(response?: string): boolean {
  if (!response) return false;
  const trimmed = response.trim();
  if (trimmed.length === 0) return false;
  // Only `<|…|>` tokens with whitespace between → audio codebook stream.
  if (/^(<\|[^|>]+\|>\s*)+$/.test(trimmed)) return true;
  return false;
}

/** Used when no prior signature exists (ParseAll wiring not yet hooked).
 *  Real structural is filled by R0.4 at ParseAll; behavioral is our job. */
const STUB_STRUCTURAL: StructuralSignature = {
  architecture: 'unknown',
  params: { total_b: 0, active_b: null },
  quantization: 'unknown',
  modality: 'text',
  context_max: 0,
  est_footprint_bytes: 0,
};

export type CharacterizeOptions = {
  /** Running llama-server base URL. Required unless `chat` is injected. */
  baseUrl?: string;
  /** Model id sent to the chat API (local llama-server ignores it). */
  model?: string;
  /**
   * Optional per-model cap on `max_tokens` (= the model's context size,
   * derived from its effective RunParams.ctx). When set, each chat call
   * advertises `max_tokens = <thisModel'sCtx>` so each model gets its
   * own natural ceiling instead of a hardcoded global value. Unset ⇒
   * no cap (llama-server uses its loaded context window by default).
   */
  maxTokens?: number;
  /** Path to the model file — keys the modelHash + locates the sidecar. */
  modelFilePath: string;
  /** Pass `loc.isReadOnly` — when true the result is computed but not written. */
  skipWrite?: boolean;
  /** Defaults loaded from routing/questions/. Injectable for tests. */
  suite?: DiagnosticSuite;
  mcqPack?: McqPack;
  /** Defaults to a real ChatClient on `baseUrl`. Injectable for tests. */
  chat?: ChatLike;
  /** Defaults to the streamed R0.2 model hash. Injectable for tests. */
  computeHash?: (modelFilePath: string) => Promise<string>;
  /**
   * Real on-disk footprint probe (summed shard bytes). Used to backfill
   * `structural.est_footprint_bytes` when the prior signature carries a
   * STUB (R0.4/ParseAll not wired yet) so the persisted signature is
   * self-sufficient. Defaults to `sumShardBytes`; injectable for tests.
   */
  shardBytes?: (modelFilePath: string) => Promise<number>;
  /** Clock seam (tests). */
  now?: () => string;
  onProgress?: (p: CharacterizationProgress) => void;
  /**
   * Fires when the user clicks Cancel on the bulk-characterise panel.
   * Plumbed through to each chat.complete() so an in-flight HTTP
   * request gets killed immediately AND the per-prompt loop bails out
   * at its next iteration without firing the remaining work.
   */
  signal?: AbortSignal;
};

export type CharacterizeResult = {
  signature: Signature;
  written: boolean;
  sidecarPath: string;
  itemsRun: number;
  errors: number;
};

/** Render an MCQ item as a single deterministic prompt. */
function renderMcq(item: McqItem): string {
  const opts = Object.keys(item.options)
    .sort()
    .map((k) => `${k}) ${item.options[k]}`)
    .join('\n');
  const instr =
    item.lang === 'fr'
      ? 'Répondez uniquement par la lettre de la bonne réponse.'
      : 'Answer with the letter of the correct option only.';
  return `${item.question}\n\n${opts}\n\n${instr}`;
}

type Work =
  | {
      kind: 'prompt';
      id: string;
      axes: DiagnosticAxis[];
      prompt: DiagnosticPrompt;
    }
  | { kind: 'mcq'; id: string; axes: DiagnosticAxis[]; item: McqItem };

/**
 * Run the deterministic characterization. Per-item failures are recorded
 * (score 0) and do not abort the run. The behavioral block is persisted
 * via signatureStore (read-only honoured through `skipWrite`).
 */
export async function characterize(
  opts: CharacterizeOptions,
): Promise<CharacterizeResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const suite: DiagnosticSuite =
    opts.suite ?? (suiteV1_30 as unknown as DiagnosticSuite);
  const mcqPack: McqPack = opts.mcqPack ?? (mcqV1 as unknown as McqPack);
  const chat: ChatLike =
    opts.chat ??
    new ChatClient({
      baseUrl: opts.baseUrl ?? '',
      model: opts.model,
      maxTokens: opts.maxTokens,
    });
  const hashOf =
    opts.computeHash ??
    (async (p: string) => (await computeModelHash(p)).modelHash);

  const modelHash = await hashOf(opts.modelFilePath);
  opts.onProgress?.({ kind: 'started', modelHash });

  // Worklist: suite prompts that have a deterministic scorer AND no runtime
  // injection (longctx needs the asset pipeline — R2.2, out of Slice 2),
  // plus every MCQ item.
  const work: Work[] = [];
  for (const p of suite.prompts) {
    if (p.runtime_inject) continue;
    if (!getScorer(p.id)) continue;
    work.push({ kind: 'prompt', id: p.id, axes: p.axes, prompt: p });
  }
  for (const item of mcqPack.items) {
    work.push({ kind: 'mcq', id: item.id, axes: item.axes, item });
  }
  const usedPromptIds = work
    .filter((w) => w.kind === 'prompt')
    .map((w) => w.id);

  const existing = await loadSignature(opts.modelFilePath);
  const base: Signature =
    existing ??
    makePendingSignature({
      modelHash,
      structural: STUB_STRUCTURAL,
      suiteVersion: suite.id,
    });

  // R0.4 (structural at ParseAll) is not wired yet, so a model
  // characterized without a prior signature inherits STUB_STRUCTURAL
  // (est_footprint_bytes: 0). That makes the router's memory-fit
  // silently null and hides the model from VRAM accounting. Backfill
  // the real on-disk footprint — exactly what computeStructuralSignature
  // would use — so the persisted signature is self-sufficient and
  // portable (D6/R7).
  const shardBytes =
    opts.shardBytes ??
    (async (p: string) => (await sumShardBytes(p)).totalBytes);
  let structural = base.structural;
  if (!(structural.est_footprint_bytes > 0)) {
    const bytes = await shardBytes(opts.modelFilePath).catch(() => 0);
    if (bytes > 0) structural = { ...structural, est_footprint_bytes: bytes };
  }

  const diagnostic_run: Record<string, DiagnosticRunEntry> = {};
  const scored: ScoredItem[] = [];
  let errors = 0;
  // Adaptive quarantine — count consecutive empty responses so a model
  // that produces NOTHING for prompt after prompt (TTS / audio-codec
  // GGUFs whose name+arch slipped past the pre-launch filters) doesn't
  // burn the full suite before we admit it's not a chat model.
  let consecutiveEmpty = 0;
  // When set, the loop bails out and we still persist what we have
  // before re-throwing. Without this, the previous design threw mid-
  // loop and the in-memory entries were LOST — the sidecar's
  // diagnostic_run stayed at 0 entries and the user saw an empty
  // « Interactions » tab with no clue why the model was quarantined.
  let quarantineReason: string | undefined;

  for (let i = 0; i < work.length; i++) {
    // Honour the user's Cancel click between every prompt — combined
    // with the AbortSignal wired into chat.complete() below, this
    // bounds the cancel latency at roughly the time it takes the
    // in-flight HTTP fetch to unwind (≤ 1 s in practice).
    if (opts.signal?.aborted) {
      throw new Error('characterize: aborted by caller');
    }
    const w = work[i];
    const startedAt = now();
    opts.onProgress?.({
      kind: 'prompt_started',
      modelHash,
      promptId: w.id,
      index: i,
      total: work.length,
    });

    const input = w.kind === 'prompt' ? w.prompt.prompt : renderMcq(w.item);

    // Per-prompt 5-minute hard cap. Above this, the response is
    // almost certainly stuck in a generation loop (the SSE stream
    // would have already filled the « Interactions » tab with the
    // repeating output, but llama-server keeps generating until ctx
    // is full). The cap aborts the request, the entry is recorded as
    // a failure with score=0, and the loop moves to the next prompt.
    // 5 min is loose enough to let a 31B Q6 multistep prompt finish
    // (typical 3-4 min) and tight enough to bound the worst case.
    const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
    const timeoutCtl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtl.abort(), PROMPT_TIMEOUT_MS);
    const onUserAbort = () => timeoutCtl.abort();
    opts.signal?.addEventListener('abort', onUserAbort, { once: true });
    let entry: DiagnosticRunEntry;
    try {
      const response = await chat.complete(input, {
        id: w.id,
        signal: timeoutCtl.signal,
        onChunk: opts.onProgress
          ? (channel, accumulated) => {
              opts.onProgress?.({
                kind: 'prompt_streaming',
                modelHash,
                promptId: w.id,
                channel,
                accumulated,
              });
            }
          : undefined,
      });
      // Post-stream quintuplon check: a long generation that loops on
      // its own output (Qwen3.5 / DeepSeek-Prover Unsloth quants) can
      // still finish under the 5-min cap with thousands of tokens of
      // garbage. Mark such responses as failed (score 0) so they
      // don't pollute the competence vector with a fake « ✓ » when
      // the scorer happens to match the correct answer at the start
      // of the loop.
      if (detectQuintuplon(response)) {
        errors += 1;
        entry = {
          promptId: w.id,
          startedAt,
          finishedAt: now(),
          response,
          error: 'response contains 5+ repeated fragments (generation loop)',
          score: 0,
          pass: false,
          axes: w.axes,
        };
        scored.push({ id: w.id, axes: w.axes, score: 0, pass: false });
      } else {
        const result =
          w.kind === 'prompt'
            ? getScorer(w.id)!(response, w.prompt)
            : scoreMcq(response, w.item);
        entry = {
          promptId: w.id,
          startedAt,
          finishedAt: now(),
          response,
          score: result.score,
          pass: result.pass,
          detail: result.detail,
          axes: w.axes,
        };
        scored.push({
          id: w.id,
          axes: w.axes,
          score: result.score,
          pass: result.pass,
        });
      }
    } catch (e) {
      errors += 1;
      // Disambiguate user-cancel vs 5-min cap vs real chat error so
      // the « Interactions » tab can show a useful error message.
      let reason: string;
      if (opts.signal?.aborted) {
        // Re-throw so the outer loop's `signal.aborted` check picks
        // it up and stops the whole run (we don't want to score the
        // remaining prompts when the user clicked Cancel).
        throw e;
      } else if (timeoutCtl.signal.aborted) {
        reason = `5-min per-prompt cap reached — request aborted`;
      } else {
        reason = (e as Error).message;
      }
      entry = {
        promptId: w.id,
        startedAt,
        finishedAt: now(),
        error: reason,
        score: 0,
        pass: false,
        axes: w.axes,
      };
      scored.push({ id: w.id, axes: w.axes, score: 0, pass: false });
    } finally {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', onUserAbort);
    }
    diagnostic_run[w.id] = entry;
    opts.onProgress?.({
      kind: 'prompt_done',
      modelHash,
      promptId: w.id,
      ok: !entry.error,
      error: entry.error,
      // Ship the full entry so the « Interactions » tab can render the
      // prompt's response (and any <think> block) the moment it lands,
      // without waiting for the whole-model signature to be persisted.
      entry,
    });

    // Adaptive quarantine: detect a non-chat model the pre-launch
    // filters missed (Cosyvoice that ALSO renamed itself plausibly,
    // some future audio packaging, …). Two stop conditions:
    //   - the very first response is ONLY special tokens (e.g.
    //     `<|stop_1|><|stop_2|>…`) — clear audio-codec output;
    //   - the model produced strictly empty responses for the first
    //     5 prompts in a row — no chat capability, don't waste 23 more.
    // We BREAK out of the loop (not throw) so the partial
    // diagnostic_run + signature still gets persisted below — the
    // « Interactions » tab needs the entries to render an explanation
    // of WHY the model was quarantined.
    if (looksLikeNonTextResponse(entry.response)) {
      quarantineReason = `non-chat model — first response was only special tokens ("${(entry.response ?? '').slice(0, 80)}…"); quarantining`;
      break;
    }
    if (entry.response === undefined || entry.response.length === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 5) {
        quarantineReason = `non-chat model — 5 consecutive empty responses; quarantining`;
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }
  }

  const vector = aggregateCompetence(scored);
  const behavioral: BehavioralSignature = {
    diagnostic_run,
    scores_per_axis: vector.per_axis,
    n_per_axis: vector.n_per_axis,
    overall: vector.overall,
    behavior_centroid: [], // embedding track out of scope (D3)
  };

  const signature: Signature = {
    ...base,
    modelHash,
    structural,
    behavioral,
    signature_hash: computeCharacterizationHash({
      suite,
      usedPromptIds,
      mcqPack,
    }),
    embedder_id: null, // no embedder in the deterministic pass (D8.A)
    policy_hash: null, // audit value is set at routing time, not here (D8)
    characterized_at: now(),
    characterization_state: quarantineReason ? 'failed' : 'complete',
    characterization_error: quarantineReason ?? null,
    suite_version: suite.id,
  };

  // Persist whatever we have — even on quarantine, so the
  // « Interactions » tab shows the prompts that exposed the broken
  // model + the quarantine reason recorded in `characterization_error`.
  const { written, sidecarPath } = await saveSignature(
    opts.modelFilePath,
    signature,
    { skipWrite: opts.skipWrite },
  );

  if (quarantineReason) {
    // The throw signals to characterizeAll that this model failed the
    // suite (so it skips the tree pass + records the failure in the
    // bulk panel), but the sidecar above already holds the partial
    // diagnostic_run and the reason, so nothing is silently dropped.
    opts.onProgress?.({
      kind: 'failed',
      modelHash,
      error: quarantineReason,
    });
    throw new Error(quarantineReason);
  }

  opts.onProgress?.({ kind: 'complete', modelHash });
  return { signature, written, sidecarPath, itemsRun: work.length, errors };
}
