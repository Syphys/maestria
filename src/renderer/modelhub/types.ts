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

/** What a configured runner can do — drives which buttons appear. */
export interface RunnerCapabilities {
  /** Supports GGUF model files. */
  gguf: boolean;
  /** Supports raw safetensors. */
  safetensors: boolean;
}

/**
 * A llama.cpp binary the user has configured (or that we detected on disk).
 * Models Hub only supports the llama.cpp family — `llama.cpp` proper and
 * forks like `ik_llama.cpp` that ship the same `llama-server` CLI surface.
 */
export interface RunnerConfig {
  /** Stable id (uuid). */
  id: string;
  /** User-friendly label, defaults to `llama-server (${basename})`. */
  label: string;
  /** Absolute path to the binary. */
  path: string;
  /** Reported version when known. */
  version?: string;
  capabilities: RunnerCapabilities;
  /** True if discovered automatically (vs manually added). */
  autoDetected: boolean;
  /** Sort key — first runner that supports the model file format is the default. */
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
   * Opens the llama-server's built-in web UI in the user's default browser
   * (`shell.openExternal`).
   */
  runnersOpenChat: 'modelhub:runnersOpenChat',
} as const;
