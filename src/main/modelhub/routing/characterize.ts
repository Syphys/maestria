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
// Static imports so webpack inlines the question packs into the main
// bundle. Reading them from `__dirname/questions` broke in the packaged /
// dev app: the bundled main lives in `.erb/dll` (or the asar), where the
// JSON files don't exist (ENOENT). The smoke worked only because ts-node
// runs from source. Same pattern the smoke already uses for mcq-v1.json.
import suiteV1_30 from './questions/v1-30.json';
import mcqV1 from './questions/mcq-v1.json';

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
  /** Clock seam (tests). */
  now?: () => string;
  onProgress?: (p: CharacterizationProgress) => void;
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

  const diagnostic_run: Record<string, DiagnosticRunEntry> = {};
  const scored: ScoredItem[] = [];
  let errors = 0;

  for (let i = 0; i < work.length; i++) {
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

    let entry: DiagnosticRunEntry;
    try {
      const response = await chat.complete(input, { id: w.id });
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
    } catch (e) {
      errors += 1;
      entry = {
        promptId: w.id,
        startedAt,
        finishedAt: now(),
        error: (e as Error).message,
        score: 0,
        pass: false,
        axes: w.axes,
      };
      scored.push({ id: w.id, axes: w.axes, score: 0, pass: false });
    }
    diagnostic_run[w.id] = entry;
    opts.onProgress?.({
      kind: 'prompt_done',
      modelHash,
      promptId: w.id,
      ok: !entry.error,
      error: entry.error,
    });
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
    behavioral,
    signature_hash: computeCharacterizationHash({
      suite,
      usedPromptIds,
      mcqPack,
    }),
    embedder_id: null, // no embedder in the deterministic pass (D8.A)
    policy_hash: null, // audit value is set at routing time, not here (D8)
    characterized_at: now(),
    characterization_state: 'complete',
    characterization_error: null,
    suite_version: suite.id,
  };

  const { written, sidecarPath } = await saveSignature(
    opts.modelFilePath,
    signature,
    { skipWrite: opts.skipWrite },
  );

  opts.onProgress?.({ kind: 'complete', modelHash });
  return { signature, written, sidecarPath, itemsRun: work.length, errors };
}
