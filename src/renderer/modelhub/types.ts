/**
 * Models Hub — shared type definitions.
 * See MODELS_HUB.md for the project context.
 */

export type ModelFormat =
  | 'gguf'
  | 'safetensors'
  | 'pytorch-bin'
  | 'pytorch-ckpt'
  | 'unknown';

export type ModelArchitecture =
  | 'llama'
  | 'mistral'
  | 'qwen'
  | 'phi'
  | 'gemma'
  | 'falcon'
  | 'mpt'
  | 'gpt2'
  | 'gptj'
  | 'gptneox'
  | 'bloom'
  | 'baichuan'
  | 'starcoder'
  | 'rwkv'
  | 'mamba'
  | 'sd'
  | 'sdxl'
  | 'flux'
  | 'whisper'
  | 'clip'
  | 't5'
  | 'bert'
  | 'lora'
  | 'embedding'
  | 'unknown';

export type Modality =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'multimodal'
  | 'embedding';

/** Parsed file-header metadata (pure, no network) */
export interface HeaderMeta {
  format: ModelFormat;
  /** File size in bytes — set by the main-process loader, not the parser. */
  fileSize?: number;
  architecture?: ModelArchitecture | string;
  /** Canonical name from the file header (e.g. GGUF general.name). */
  name?: string;
  /** Short basename (e.g. GGUF general.basename: "Llama-3-8B-Instruct"). */
  basename?: string;
  /** Author / org if exposed by the file header. */
  author?: string;
  /** Human-readable size label, e.g. "8B", "70B" — when the header gives it directly. */
  sizeLabel?: string;
  /** Estimated parameter count derived from tensor shapes. */
  paramCount?: number;
  /** Quantization label when applicable, e.g. "Q4_K_M", "Q8_0", "FP16". */
  quantization?: string;
  /** Trained / max context length if exposed. */
  contextMax?: number;
  /** Embedding / hidden dimension. */
  embeddingDim?: number;
  /** Number of transformer blocks. */
  blockCount?: number;
  /** Number of attention heads. */
  headCount?: number;
  /** Detected modality (heuristic based on architecture). */
  modality?: Modality;
  /** True for LoRA / adapter files. */
  isLora?: boolean;
  /**
   * Set when the file is one of multiple shards (e.g. `model-00001-of-00003.gguf`).
   * Only shard 1 typically holds the full metadata; later shards are mostly tensor blobs.
   */
  shardInfo?: {
    current: number;
    total: number;
  };
  /**
   * Sum of bytes across all sibling shards on disk. Set only on the
   * canonical entry (shard 1 or non-sharded files) — the other shards
   * are effectively invisible to the rest of the app. Used by the size
   * bucket auto-tag and the GB-range filter so a Llama-70B split across
   * 12×5 GB shards still reads as ~60 GB / `size:30-70B`.
   */
  totalBytes?: number;
  /** Number of sibling shard files actually present on disk. */
  shardCount?: number;
  /** Free-form bag of additional KV pairs from the header — useful for debug & advanced UI. */
  rawMetadata?: Record<string, unknown>;
  /** When parsing only partly succeeded, list of soft warnings. */
  warnings?: string[];
}

/** Hugging Face enrichment (Phase 1.3) */
export interface HfMeta {
  repo: string;
  pipelineTag?: string;
  license?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  lastModified?: string;
  descriptionEN?: string;
  descriptionFR?: string;
  cachedAt?: string;
}

/** Integrity verification result (Phase 1.5) */
export interface IntegrityHashResult {
  status: 'match' | 'mismatch' | 'repo-not-found' | 'error';
  verifiedAt: string;
  expectedOid?: string;
  actualSha256?: string;
  errorMessage?: string;
}

export interface IntegrityFunctionalResult {
  status: 'pass' | 'fail' | 'skipped';
  verifiedAt: string;
  runtimeUsed?: string;
  sampleOutput?: string;
  errorMessage?: string;
}

export interface IntegrityMeta {
  hash?: IntegrityHashResult;
  functional?: IntegrityFunctionalResult;
}

/** Hardware-aware run preset (Phase 3.3) */
export interface RunPreset {
  name: string;
  runtime: string;
  params: Record<string, string | number | boolean>;
  createdAt: string;
}

/** Identifier for a known runner integration. Open-ended for future kinds. */
export type RunnerKind = 'llama.cpp' | 'ik_llama.cpp' | 'koboldcpp' | 'custom';

/** What a configured runner can do — drives which buttons appear. */
export interface RunnerCapabilities {
  /** Can serve an OpenAI-compatible HTTP API (used for in-app chat). */
  chat: boolean;
  /** Can be launched as a long-running server process. */
  server: boolean;
  /** Supports GGUF model files. */
  gguf: boolean;
  /** Supports raw safetensors. */
  safetensors: boolean;
}

/** A runner the user has configured (or that we detected on disk). */
export interface RunnerConfig {
  /** Stable id (uuid). */
  id: string;
  kind: RunnerKind;
  /** User-friendly label, defaults to `${kind} (${path basename})`. */
  label: string;
  /** Absolute path to the binary, or the URL for HTTP-only runners. */
  path: string;
  /** Reported version when known. */
  version?: string;
  capabilities: RunnerCapabilities;
  /** True if discovered automatically (vs manually added). */
  autoDetected: boolean;
  /** Sort key — first runner that supports the model file kind is the default. */
  priority?: number;
}

/**
 * Auto-tuned launch parameters derived from hardware + model metadata.
 * Currently targets llama.cpp's `llama-server`; other runners get a
 * best-effort mapping.
 */
export interface RunParams {
  /** Number of model layers to offload to GPU. 0 = pure CPU. */
  ngl?: number;
  /** Context window size (tokens). */
  ctx?: number;
  /** CPU threads to use. */
  threads?: number;
  /** Logical batch size for prompt processing. */
  batchSize?: number;
  /** Locks model in RAM to prevent swap. */
  mlock?: boolean;
  /** Enables flash attention if compiled in. */
  flashAttn?: boolean;
  /** Server bind port. */
  port?: number;
  /** Free-form notes the auto-tune attached for the user (why these values). */
  rationale?: string[];
}

/** Result of asking the main process to spawn a runner. */
export interface LaunchResult {
  ok: boolean;
  /** Process id of the spawned child, when successful. */
  pid?: number;
  /** Server URL the user can hit, for runners that expose one. */
  url?: string;
  /** Full command that was executed (or would be — for dry runs). */
  command?: string[];
  error?: string;
}

/** Full sidecar payload under `.ts/{file}.json` → `modelMeta` key. */
export interface ModelMeta {
  header?: HeaderMeta;
  huggingface?: HfMeta;
  integrity?: IntegrityMeta;
  sha256?: string;
  runPresets?: RunPreset[];
  lastEnrichedAt?: string;
  /**
   * Tags derived deterministically from header + huggingface metadata.
   * Distinct from TagSpaces' user-set sidecar `tags` array.
   * Format: namespace:value (e.g. "arch:llama", "quant:q4_k_m", "size:7-13B").
   */
  autoTags?: string[];
  /**
   * Free-form user notes attached to this model. Markdown is supported in
   * the preview tab. Persisted in the sidecar so notes follow the file
   * even when moved across folders.
   */
  userNotes?: string;
  /** ISO timestamp of the most recent note edit. */
  userNotesUpdatedAt?: string;
  /**
   * User-overridden runtime parameters. Take precedence over the values
   * `autotune()` returns at launch time. Stored as a full `RunParams`
   * (not a sparse delta) so the UI can show "what will be used" without
   * recomputing the estimate every render.
   */
  userRunParams?: RunParams;
}

/**
 * Universal agent launch spec. No `kind` enum — agents are heterogeneous
 * (deer-flow, aider, open-webui, custom Python script, Docker container…)
 * and we adopt the industry pattern (MCP servers in Claude Desktop,
 * GitHub Copilot custom agents, Bedrock prompt templates): a generic
 * launch spec with placeholder substitution at run time.
 *
 * See MODELS_HUB_MCP.md for the design rationale.
 */
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  /** Spawn-mode: binary to launch. Empty/undefined when `external` is true. */
  command?: string;
  /**
   * CLI args. Supports placeholders substituted at `agents.run` time:
   * `${MODEL_URL}`, `${MCP_URL}`, `${MCP_TOKEN}`, `${TASK}`, `${PORT}`,
   * `${AGENT_ID}`. Anything else passes through unchanged.
   */
  args?: string[];
  /** Env vars. Same placeholder substitution in values. */
  env?: Record<string, string>;
  cwd?: string;
  /** External-mode: service already running, no spawn — just open `uiUrl`. */
  external?: boolean;
  externalUrl?: string;
  /** URL to open in the user's default browser once ready. Supports `${PORT}`. */
  uiUrl?: string;
  /** Optional readiness probe before opening the UI. */
  readiness?:
    | { type: 'httpGet'; url: string; timeoutSec?: number }
    | { type: 'logPattern'; pattern: string; timeoutSec?: number }
    | { type: 'delay'; delayMs: number };
}

/**
 * Live state of an agent instance launched by the orchestrator.
 * Persisted to `~/.tagspaces/agents/active-pids.json` so a restart can
 * reconcile and re-attach to survivors.
 */
export interface AgentRunningState {
  /** Stable id assigned at launch, distinct from `AgentConfig.id`. */
  agentInstanceId: string;
  /** Reference to the config that spawned it. */
  agentConfigId: string;
  /** User-visible label, copied from the config at launch. */
  name: string;
  /** OS pid — undefined for external agents (nothing was spawned). */
  pid?: number;
  /** URL to re-open in the browser to reach the agent's UI. */
  uiUrl?: string;
  /** Substituted task text, for display in the sidebar tree. */
  task?: string;
  /** ISO timestamp. */
  startedAt: string;
  /** Parent agent if spawned by another agent via `agents.run`. */
  parentAgentInstanceId?: string;
  status: 'starting' | 'running' | 'done' | 'error' | 'dead';
}

/** IPC channel names exposed by the modelhub main process. */
export const MODELHUB_IPC = {
  parseHeader: 'modelhub:parseHeader',
  enrichLocal: 'modelhub:enrichLocal',
  enrichHf: 'modelhub:enrichHf',
  loadModelMeta: 'modelhub:loadModelMeta',
  /** Invoke channel to start a bulk job. Returns a run id immediately. */
  enrichFolderStart: 'modelhub:enrichFolderStart',
  /** Invoke channel to cancel a bulk job by run id. */
  enrichFolderCancel: 'modelhub:enrichFolderCancel',
  /**
   * Bulk-clear every model-file sidecar under a root: remove the TagSpaces
   * `description` and every system / modelhub-origin / auto-namespaced tag.
   * Synchronous over IPC — returns a summary when done.
   */
  clearFolder: 'modelhub:clearFolder',
  /** Event channel: main → renderer progress updates. Payload includes runId. */
  enrichFolderProgress: 'modelhub:enrichFolderProgress',
  /** Event channel: main → renderer when the run finishes. Payload is the summary. */
  enrichFolderDone: 'modelhub:enrichFolderDone',
  /** Returns a HardwareProfile (Phase 3 — currently stub data). */
  detectHardware: 'modelhub:detectHardware',
  /**
   * Patch arbitrary fields on the sidecar's `modelMeta` (e.g. userNotes,
   * userRunParams). Resolves the canonical shard internally so the user
   * can call this on any sibling and the data lands on shard 1.
   */
  patchModelMeta: 'modelhub:patchModelMeta',
  /**
   * Sum the byte sizes of all sibling shards of a canonical model file
   * (or the file's own size when not sharded). Pure fs.stat — does NOT
   * touch sidecar / parse headers. Used by the size-filter cache so the
   * GB slider works regardless of enrichment state.
   */
  sumShardBytes: 'modelhub:sumShardBytes',
  /**
   * Walks a location root and returns the set of folder paths that
   * contain at least one model file (recursively). Drives the directory
   * listing filter that hides folders without models.
   */
  listModelHostingFolders: 'modelhub:listModelHostingFolders',
  /** Lists configured runners + auto-detected installs. */
  runnersList: 'modelhub:runnersList',
  /** Persists a new or updated runner. */
  runnersSave: 'modelhub:runnersSave',
  /** Removes a runner by id. */
  runnersRemove: 'modelhub:runnersRemove',
  /** Re-runs auto-detection (PATH + known install dirs). */
  runnersDetect: 'modelhub:runnersDetect',
  /** Computes auto-tuned launch params for a given model. */
  runnersAutotune: 'modelhub:runnersAutotune',
  /** Spawns a runner with the given params. Returns pid/url. */
  runnersLaunch: 'modelhub:runnersLaunch',
  /** Stops a previously launched runner by pid. */
  runnersStop: 'modelhub:runnersStop',
  /** Lists currently running child processes started via runnersLaunch. */
  runnersRunning: 'modelhub:runnersRunning',
  /** Builds the shell command without launching (for the "copy" button). */
  runnersBuildCommand: 'modelhub:runnersBuildCommand',
  /**
   * Opens the most useful chat surface for an active runner: browser for
   * runners with a built-in web UI (llama-server, koboldcpp, lm-studio);
   * a new terminal with `ollama run <model>` for Ollama (the API root is
   * not chat-friendly).
   */
  runnersOpenChat: 'modelhub:runnersOpenChat',
} as const;
