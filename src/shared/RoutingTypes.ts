// Shared types for the semantic routing system (Phase R).
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.5.
// Used by the main process, the renderer, and the MCP tools — no I/O, no deps.

// -----------------------------------------------------------------------------
// Diagnostic suite (R2.1)
// -----------------------------------------------------------------------------

export type DiagnosticAxis =
  | 'code'
  | 'math'
  | 'reasoning'
  | 'creative'
  | 'fr'
  | 'en'
  | 'zh'
  | 'vision'
  | 'refusal'
  | 'fim'
  | 'instruction'
  | 'longctx'
  | 'factual'
  | 'multistep'
  | 'meta';

export type RubricCriterion = {
  /** Stable, snake_case key the judge LLM will see in its scoring rubric. */
  criterion: string;
  /** Weight in [0, 1]. Sum across all criteria of a prompt SHOULD equal 1.0
   *  (validator allows ±0.001 for float dust). */
  weight: number;
};

/**
 * Some prompts inject content at runtime (long text, image attachment).
 * The suite runner reads this and prepares the actual model input.
 */
export type RuntimeInject =
  | {
      kind: 'long_text_filler';
      target_tokens: number;
      pool: string[]; // logical IDs resolved by runner to actual filler files
    }
  | {
      kind: 'needle_in_haystack';
      target_tokens: number;
      needle: string;
      needle_position_fraction: number; // 0..1
    }
  | {
      kind: 'image_attach';
      pool: string[]; // image asset IDs
    };

/**
 * How the runner should score model responses to this prompt:
 *   - 'deterministic' : pure-function regex/parser/exec sandbox check (R2.6)
 *   - 'semantic'      : cosine similarity between response embedding and
 *                       pre-computed gold-response anchors (R2.6.5)
 *   - 'judge'         : LLM-as-judge with the rubric (R3)
 *   - 'ensemble'      : weighted combination — typically deterministic gates
 *                       the result, semantic provides a continuous score,
 *                       judge resolves ambiguity. Pondération définie par
 *                       prompt.
 */
export type ScoringMethod = 'deterministic' | 'semantic' | 'judge' | 'ensemble';

/**
 * Reference texts used by the semantic scorer (R2.6.5).
 *  - `idiomatic` : 1–N exemplar gold responses. Score = max cosine.
 *  - `literal_or_wrong` : 0–N anti-examples. A high cosine to one of these
 *    indicates the model fell into the trap (e.g. literal translation,
 *    common misconception). Penalises the score.
 */
export type GoldAnchors = {
  idiomatic?: string[];
  literal_or_wrong?: string[];
};

export type DiagnosticPrompt = {
  /** Stable ID across versions; never reused for a different prompt. */
  id: string;
  /** ISO 639-1 code (or 'multi'). The language the user is expected to reply in.
   *  Note: a 'fr' prompt may have axes including 'fr' for cross-validation. */
  lang: 'fr' | 'en' | 'zh' | 'multi';
  /** Orthogonal axes this prompt targets. At least one. */
  axes: DiagnosticAxis[];
  /** The actual prompt sent to the model under test. */
  prompt: string;
  /** One-paragraph note describing the gold response. The judge sees this. */
  expected_behavior: string;
  /** Scoring rubric, weights summing to ~1.0. */
  rubric: RubricCriterion[];
  /**
   * Which scoring track applies to this prompt. Default is 'judge' if absent
   * (back-compat with existing v1-30.json prompts).
   */
  scoring_method?: ScoringMethod;
  /**
   * Reference texts for the semantic scorer. Required iff
   * `scoring_method === 'semantic' | 'ensemble'`. Embeddings are pre-computed
   * once and cached in `<suiteId>.gold-embeddings.json` next to the suite.
   */
  gold_anchors?: GoldAnchors;
  /**
   * Optional: prompt is skipped if this CEL-ish expression evaluates true.
   * Currently the runner supports a tiny eval: `model.signature.structural.<key> <op> <literal>`.
   * Used for vision prompts to skip non-multimodal models.
   */
  skip_if?: string;
  /** Optional runtime content injection. */
  runtime_inject?: RuntimeInject;
};

export type DiagnosticSuite = {
  id: string; // e.g. "v1-30"
  version: number;
  name: string;
  description: string;
  createdAt: string; // YYYY-MM-DD
  axes_distribution: Partial<Record<DiagnosticAxis, number>>;
  prompts: DiagnosticPrompt[];
};

// -----------------------------------------------------------------------------
// Signatures (R0.3, R0.4)
// -----------------------------------------------------------------------------

export type StructuralSignature = {
  architecture: string; // 'qwen3moe', 'llama', 'sdxl', ...
  params: { total_b: number; active_b: number | null }; // active = total for dense
  quantization: string;
  tare: number; // 0..1 — quality degradation score
  modality: 'text' | 'multimodal' | 'embedding' | 'image-gen' | 'audio';
  context_max: number;
  fits_in_vram: boolean;
  fits_in_ram: boolean;
  supported_langs?: string[]; // best-effort, derived from training data signals or HF card
};

export type DiagnosticRunEntry = {
  promptId: string;
  startedAt: string;
  finishedAt?: string;
  response?: string;
  responseEmbedding?: number[]; // R1.3
  judgeScores?: Record<string, number>; // criterion -> 0..1
  judgeAggregate?: number; // 0..1, weighted sum
  error?: string;
  judge_pending?: boolean;
};

export type BehavioralSignature = {
  diagnostic_run: Record<string, DiagnosticRunEntry>;
  scores_per_axis: Record<DiagnosticAxis, number>; // averaged judgeAggregate over prompts on that axis
  behavior_centroid: number[]; // mean of all responseEmbedding vectors
};

export type Signature = {
  modelHash: string; // 'sha256:...'
  structural: StructuralSignature;
  behavioral: BehavioralSignature | null;
  policy_hash: string; // 'sha256:...'
  characterized_at: string;
  characterization_state: 'pending' | 'running' | 'complete' | 'failed';
  characterization_error: string | null;
  suite_version: string; // 'v1-30' | 'v2-100' | 'v3-1000'
};

// -----------------------------------------------------------------------------
// Policy & routing (R0.6, R5)
// -----------------------------------------------------------------------------

export type RoutingWeights = {
  alpha: number; // rerank weight
  beta: number; // speed bonus weight
  gamma: number; // size penalty weight
  delta: number; // tare penalty weight
};

export type Policy = {
  id: string;
  name: string;
  suiteVersion: string;
  weights: RoutingWeights;
  // Tare table is referenced by name; the resolver loads ./tare.ts
  tareTableId: string;
  // Hash computed from (suite, weights, tareTable, embedder). See policy.ts (R0.6).
  policyHash: string;
};

export type EliminatedReason =
  | 'lang_unsupported'
  | 'vision_needed_not_available'
  | 'tare_too_high'
  | 'oversized_hw'
  | 'failed_characterization';

export type RoutingDecision = {
  query: string;
  embedded_query: number[];
  chosen: {
    modelHash: string;
    score: number;
    score_breakdown: Record<string, number>;
  };
  alternatives: {
    modelHash: string;
    score: number;
    score_breakdown: Record<string, number>;
  }[];
  eliminated_structural: { modelHash: string; reason: EliminatedReason }[];
  top_matching_prompts: { id: string; similarity: number }[];
  policy_hash: string;
  decided_at: string; // ISO
};

// -----------------------------------------------------------------------------
// Progress events (R3.5)
// -----------------------------------------------------------------------------

export type CharacterizationProgress =
  | { kind: 'queued'; modelHash: string }
  | { kind: 'started'; modelHash: string }
  | {
      kind: 'prompt_started';
      modelHash: string;
      promptId: string;
      index: number;
      total: number;
    }
  | {
      kind: 'prompt_done';
      modelHash: string;
      promptId: string;
      ok: boolean;
      error?: string;
    }
  | { kind: 'complete'; modelHash: string }
  | { kind: 'failed'; modelHash: string; error: string }
  | { kind: 'cancelled'; modelHash: string };

// -----------------------------------------------------------------------------
// Judge config (R3.6) — kept typed for forward-compat; the MVP is judge-free
// (see DECISIONS.md D3). Not on the critical path.
// -----------------------------------------------------------------------------

export type JudgeConfig =
  | { kind: 'local-llama'; modelPath: string; port?: number }
  | { kind: 'external-api'; baseUrl: string; model: string; apiKey?: string };

// -----------------------------------------------------------------------------
// Semantic scoring (R2.6.5)
// -----------------------------------------------------------------------------

/**
 * Pre-computed embeddings for a prompt's `gold_anchors`.
 * Lives next to the suite file at `<suiteId>.gold-embeddings.json`.
 *
 * Indexed by promptId. The embedder is identified so the runner can detect
 * staleness when the embedder config changes (R1.7) and trigger a recompute.
 */
export type GoldEmbeddingsCache = {
  suite_id: string; // 'v1-30'
  embedder_id: string; // 'bge-m3' | 'text-embedding-3-small' | ...
  embedding_dim: number;
  computed_at: string; // ISO
  entries: Record<
    string,
    {
      idiomatic?: number[][]; // one vector per anchor
      literal_or_wrong?: number[][];
    }
  >;
};

/**
 * Inputs for a semantic scorer. The runner is responsible for embedding the
 * model response (it already does so for `behavior_centroid`, so this is free)
 * and for loading the gold cache. The scorer itself is a pure function on
 * already-computed vectors + the raw response (for cheap heuristics like
 * character-class checks).
 */
export type SemanticScorerInput = {
  response: string;
  responseEmbedding: number[];
  goldEmbeddings: {
    idiomatic?: number[][];
    literal_or_wrong?: number[][];
  };
  prompt: DiagnosticPrompt;
};
