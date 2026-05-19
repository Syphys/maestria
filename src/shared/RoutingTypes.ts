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
  | 'meta'
  // slice 6e — deterministic gap-filling axes (no judge, D3):
  | 'tooluse' // function/tool-call emission (critical for MCP/agents)
  | 'robustness' // prompt-injection / adversarial resistance
  | 'calibration' // honest abstention ("I don't know") vs hallucination
  // slice 6f — deterministic via curated-source coverage, no embedder
  // on the characterization path (SPEC §4) and no judge (D3):
  | 'summarization';

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

/**
 * Reusable deterministic checker descriptor (SPEC-vector-routing-v0 §3).
 * Keyed by `kind`, NOT by promptId — one dispatcher serves the whole
 * unbounded ladder. Each item is scored pass/fail (0|1); the leaf score
 * is the breaking rung of the staircase (aggregated at store time).
 * `code-tests` is executed by the slice-2d sandbox; here it is schema
 * only. No judge, no embedder — characterization stays deterministic.
 */
export type CheckSpec =
  | {
      /** Normalised exact match. `math` normaliser = D10 (LaTeX→canon). */
      kind: 'exact-norm';
      expected: string;
      normalizer?: 'math' | 'plain';
    }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'json-schema'; schema: Record<string, unknown> }
  | {
      kind: 'length';
      unit: 'words' | 'chars' | 'lines';
      equals?: number;
      min?: number;
      max?: number;
    }
  | {
      /** safety: pass iff the model COMPLIES (`true`) / REFUSES (`false`)
       *  — binary, no quality judgement. */
      kind: 'refusal';
      mustComply: boolean;
    }
  | {
      /** Executed by the slice-2d sandbox. Schema only at 2a. */
      kind: 'code-tests';
      codeLang: 'python' | 'cpp';
      tests: string;
    }
  | {
      /** MCQ: gold letter + option map. Reused for competence MCQ AND
       *  (with runtime permutation, slice 4) the qcm_reliability probe. */
      kind: 'mcq';
      answer: string;
      options: Record<string, string>;
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
  /**
   * SPEC v0 tree id `${branch}.${leaf}` this item characterizes (e.g.
   * "code.python"). Absent ⇒ legacy R5-only prompt (v1-30 back-compat).
   */
  leaf?: CompetenceLeafId;
  /**
   * Ladder rung, 1 = easiest. The staircase climbs until the first
   * failed level; the leaf score = the breaking rung. Unbounded by
   * design; v0 authors 3 rungs/leaf, extensible with no schema change.
   */
  level?: number;
  /**
   * Reusable deterministic checker. Preferred over per-id scorer lookup
   * for tree items. Absent ⇒ legacy scorer path (`getScorer(id)`).
   */
  check?: CheckSpec;
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
  modality: 'text' | 'multimodal' | 'embedding' | 'image-gen' | 'audio';
  context_max: number;
  /**
   * Model-intrinsic loaded-weights footprint estimate (bytes), summed
   * across shards. This belongs in the signature because it's a property
   * of the *model*. Whether it FITS is NOT stored: that depends on the
   * machine, and signatures are portable across machines (D6/R7) — a
   * persisted "fits" boolean from one box is a lie on another (and stale
   * here the moment the GPU/override changes). Compute fit at the point of
   * use with `memoryFits()` — against TOTAL memory for the static "could it
   * ever run" question, against FREE memory for R5's dynamic decision
   * (DECISIONS.md D8.1). Never persist the boolean.
   */
  est_footprint_bytes: number;
  supported_langs?: string[]; // best-effort, derived from training data signals or HF card
};

export type DiagnosticRunEntry = {
  promptId: string;
  startedAt: string;
  finishedAt?: string;
  response?: string;
  responseEmbedding?: number[]; // R1.3 (embedding track — unused in MVP)
  judgeScores?: Record<string, number>; // criterion -> 0..1 (judge track — unused, D3)
  judgeAggregate?: number; // judge track — unused, D3
  // Deterministic scoring (R2.6 / D3 / D3.2):
  score?: number; // 0..1 weighted (rubric) or 0|1 (MCQ)
  pass?: boolean;
  detail?: string;
  axes?: DiagnosticAxis[]; // axes this item exercised (for aggregation/UI)
  error?: string;
  judge_pending?: boolean;
};

// -----------------------------------------------------------------------------
// Competence tree (SPEC-vector-routing-v0). FROZEN v0 taxonomy — the routing
// vector space basis. Adding/removing a leaf is a deliberate spec change.
// -----------------------------------------------------------------------------

export type CompetenceBranch =
  | 'code'
  | 'math'
  | 'reasoning'
  | 'lang'
  | 'format'
  | 'longctx'
  | 'safety';

/**
 * Frozen v0 tree: branch → leaves. Leaf id convention = `${branch}.${leaf}`
 * (e.g. "code.python", "math.geometrie"). `safety` is binary, not laddered.
 */
export const COMPETENCE_TREE: Record<CompetenceBranch, readonly string[]> = {
  code: ['python', 'cpp', 'sql', 'web', 'algo-dur', 'generic'],
  math: ['algebre', 'geometrie', 'analyse', 'proba', 'generic'],
  reasoning: ['deductif', 'multi-step', 'generic'],
  lang: ['fr', 'zh', 'en'],
  format: ['json-strict', 'longueur-exacte', 'generic'],
  longctx: ['needle-8k', 'needle-32k'],
  safety: ['non-censure'],
} as const;

/** `${CompetenceBranch}.${leaf}`. Kept as string (authoring flexibility);
 *  `COMPETENCE_TREE` is the source of truth for the valid set. */
export type CompetenceLeafId = string;

/**
 * Shared routing-embedding basis (SPEC §4). The anchor of a dimension is
 * its SHORT competence DESCRIPTION (not a hard item — far more stable to
 * embed). Embedded once and cached; the query is projected onto these
 * anchors (`q[i] = cos(embed(query), embed(anchor_i))`, L2-normalised).
 * The ONLY place the embedder touches routing — never the
 * characterization path. Keys MUST cover every `CompetenceBranch` and
 * every `${branch}.${leaf}` in `COMPETENCE_TREE`.
 */
export type ProbeAnchorBank = {
  id: string;
  version: number;
  createdAt: string; // YYYY-MM-DD
  description: string;
  /** branch → short competence description (coarse projection level). */
  branches: Record<CompetenceBranch, string>;
  /** `${branch}.${leaf}` → short competence description (fine level). */
  leaves: Record<CompetenceLeafId, string>;
};

/**
 * One mini-MTEB ordered triplet (SPEC §4). The embedder is reliable on
 * this item iff `cos(emb(anchor), emb(positive)) > cos(emb(anchor),
 * emb(negative))`. `positive` is a meaning-preserving paraphrase;
 * `negative` is an unrelated sentence of similar surface length so the
 * test probes semantics, not length.
 */
export type EmbeddingTriplet = {
  anchor: string;
  positive: string;
  negative: string;
};

/**
 * Bank of ordered triplets per language, used to MEASURE the routing
 * embedder (selected by score, not reputation — SPEC §4). Not tied to
 * the competence tree: this characterizes the embedder model class.
 */
export type EmbeddingTripletBank = {
  id: string;
  version: number;
  createdAt: string; // YYYY-MM-DD
  description: string;
  triplets: Record<'fr' | 'zh' | 'en', EmbeddingTriplet[]>;
};

/**
 * Per-model embedding-channel reliability (SPEC §4). Deterministic
 * mini-MTEB (ordered triplets) per language. Gates the routing projector:
 * below threshold ⇒ fall back to the deterministic R5 classifier.
 * Absent until measured.
 */
export type EmbeddingReliability = Partial<Record<'fr' | 'zh' | 'en', number>>;

/**
 * Per-model JUDGE-CANDIDACY signal (SPEC §6bis). NOT competence, NOT the
 * textual answer: a meta-property of the model's QCM channel, measured so
 * a future IA-validatrice / judge can be picked from the most QCM-reliable
 * models. NEVER enters the competence vector or the routing score.
 */
export type QcmReliability = {
  /** Fraction of QCM items yielding a single parsable choice (`<think>`
   *  stripped, D11) — "does it respect the QCM exercise". */
  format_adherence: number;
  /** Agreement of the chosen option under option-permutation (free of
   *  position/letter bias). */
  consistency: number;
  /** Composite judge-worthiness in [0,1]. */
  overall: number;
  /** Sample size behind the estimate. */
  n: number;
};

export type BehavioralSignature = {
  diagnostic_run: Record<string, DiagnosticRunEntry>;
  // D8.B: only MEASURED axes appear — an absent axis means "no data", never
  // a misleading 0 (creative/refusal/vision/zh aren't auto-scorable).
  scores_per_axis: Partial<Record<DiagnosticAxis, number>>;
  /** Sample size behind each axis (small ⇒ noisy; surfaced by the radar). */
  n_per_axis?: Partial<Record<DiagnosticAxis, number>>;
  /** Mean score over every scored item (axis-agnostic). */
  overall?: number;
  behavior_centroid: number[]; // embedding track — [] in the MVP (no embeddings)
  /**
   * SPEC v0 vector-routing competence: leaf id → breaking-rung score
   * (real-valued, unsaturated — the staircase rung where the model first
   * failed). Absent leaf = not measured ⇒ use the branch prior
   * (`branch_scores`, D12 priorDiscount mechanism). Coexists with
   * `scores_per_axis` (R5 fallback path).
   */
  scores_per_leaf?: Record<CompetenceLeafId, number>;
  /**
   * Branch-level prior for unmeasured leaves (the adaptive gate did not
   * open that branch). Keyed by `CompetenceBranch`.
   */
  branch_scores?: Partial<Record<CompetenceBranch, number>>;
  /** Sample size behind each leaf score (noisy ⇒ surfaced by the radar). */
  n_per_leaf?: Record<CompetenceLeafId, number>;
};

export type Signature = {
  modelHash: string; // 'sha256:...' — D4 tensor-payload digest (R0.2)
  structural: StructuralSignature;
  behavioral: BehavioralSignature | null;
  /**
   * D8 invalidation key: `computeSignatureHash(suiteCore + embedderId)`.
   * The cached `behavioral` block is trusted iff this still matches the
   * active suite+embedder AND `modelHash` still matches the file on disk
   * AND `suite_version` matches. `null` until first characterization.
   */
  signature_hash: string | null;
  /** Embedder the behavioral block was produced with (UI/debug; the value
   *  is already folded into `signature_hash`). `null` until characterized. */
  embedder_id: string | null;
  /**
   * AUDIT only (D8): `computePolicyHash(...weights...)` snapshot at
   * characterization time, so a past ranking is reproducible. NEVER gates
   * validity — changing a weight must not invalidate this signature.
   * `null` until characterized.
   */
  policy_hash: string | null;
  characterized_at: string | null;
  characterization_state: 'pending' | 'running' | 'complete' | 'failed';
  characterization_error: string | null;
  suite_version: string; // 'v1-30' | 'v2-100' | 'v3-1000'
  /**
   * SPEC v0 §4 — embedding-channel reliability. Meaningful for
   * embedding-class models; drives routing-projector selection. `null`
   * until measured; absent on pre-v0 signatures (back-compat).
   */
  embedding_reliability?: EmbeddingReliability | null;
  /**
   * SPEC v0 §6bis — judge-candidacy signal. Diagnostic only: select a
   * future IA-validatrice from the most QCM-reliable models. NOT used in
   * routing. `null` until measured; absent on pre-v0 signatures.
   */
  qcm_reliability?: QcmReliability | null;
};

// -----------------------------------------------------------------------------
// Policy & routing (R0.6, R5)
// -----------------------------------------------------------------------------

export type RoutingWeights = {
  alpha: number; // rerank weight
  beta: number; // speed bonus weight
  gamma: number; // size penalty weight
};

export type Policy = {
  id: string;
  name: string;
  suiteVersion: string;
  weights: RoutingWeights;
  // Hash computed from (suite, weights, embedder). See policy.ts (R0.6).
  policyHash: string;
};

export type EliminatedReason =
  | 'lang_unsupported'
  | 'vision_needed_not_available'
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
