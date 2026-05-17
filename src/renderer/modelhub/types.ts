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
 * Three-state interpretation of a llama-server flag — derived from the
 * binary's `--help` output. `bare` means the flag is a no-arg boolean
 * (older builds); `on-off` and `on-off-auto` require an explicit value
 * after the flag. `absent` means the runner doesn't know this flag at
 * all and emitting it would crash the process at boot.
 */
export type FlagSyntax = 'absent' | 'bare' | 'on-off' | 'on-off-auto';

/**
 * Result of running `<binary> --help` and parsing the output. Lets
 * `buildCommand` emit the right syntax per runner (a 2025 ik_llama
 * build wants `--fit on` but an early-2024 vanilla build crashes on
 * the same flag), and lets the editor hide knobs the runner can't
 * honour (e.g. Auto-fit checkbox when `--fit` is absent).
 */
export interface RunnerProbe {
  /** ISO timestamp of when the probe ran. */
  probedAt: string;
  /**
   * Version string when parseable — usually the first line of `--help`
   * or the `--version` output ("build: 4567 (abc1234)"). Display-only.
   */
  version?: string;
  /**
   * Full raw `--help` stdout/stderr from the probe. Kept verbatim so
   * the "Advanced parameters" dialog can show the user every flag the
   * runner accepts (the parsed `flagsKnown` set is convenient for
   * lookups but strips the descriptions). ~30-80 KB per runner,
   * negligible in the registry JSON. Truncated to 200 KB as a safety
   * cap against runaway output.
   */
  helpText: string;
  /**
   * Every long flag the binary advertises in its help output
   * (e.g. `--n-gpu-layers`, `--flash-attn`, `--fit`). Lowercased.
   * Used as a cheap "does the runner know this flag" check before
   * emitting it.
   */
  flagsKnown: string[];
  /**
   * Per-flag syntax quirks. Only set for flags whose syntax changed
   * across recent llama.cpp builds — others can be looked up in
   * `flagsKnown`.
   */
  quirks: {
    /**
     * `--flash-attn`. Late-2025 builds: `[on|off|auto]`. Pre-late-2025:
     * bare. Older: absent entirely.
     */
    flashAttn: FlagSyntax;
    /**
     * `--fit`. Introduced mid-2025 in llama.cpp upstream. `[on|off]`
     * everywhere except ik_llama.cpp older builds which take it bare.
     */
    fit: FlagSyntax;
  };
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
  /**
   * Snapshot of `<binary> --help` parsing — drives buildCommand flag
   * syntax + UI flag-availability checks. Filled lazily by the registry
   * (probed on first save / first list when missing). User can manually
   * refresh via the "Re-probe" button in RunnerSetupDialog.
   */
  probed?: RunnerProbe;
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
  /**
   * When true, delegates ngl / ctx / batchSize sizing to llama.cpp's
   * built-in `--fit on` pass — llama-server inspects free VRAM at boot
   * and fills in those args itself. More accurate for MoE / tied-weight /
   * exotic-quant models where our cost-per-layer heuristic underestimates,
   * at the cost of 1-3 s of extra boot time. When false (or undefined on
   * legacy sidecars) the explicit ngl / ctx / batchSize above are sent
   * verbatim — and the editor's manual rows become active.
   */
  fit?: boolean;
  /**
   * Free-form extra CLI args the user wants appended to the launch
   * command. One flag per line; the parser splits on the FIRST
   * whitespace so `--system "You are X"` works without quote handling.
   * Lines starting with `#` are ignored as comments. Persists raw text
   * (not a parsed array) so reopening the dialog shows exactly what
   * the user typed — round-trips losslessly.
   *
   * Example:
   *   # Disable mmap so the model lives entirely in RAM
   *   --no-mmap
   *   --cache-type-k f16
   *   --repeat-penalty 1.1
   */
  customArgs?: string;
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
  integrity?: IntegrityMeta;
  sha256?: string;
  runPresets?: RunPreset[];
  lastEnrichedAt?: string;
  /**
   * Tags derived deterministically from the GGUF header metadata.
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
  /**
   * Per-file runner override: id of the `RunnerConfig` to use when
   * launching this model. Set via the dropdown in `RunParamsEditor`.
   * Undefined → fall back to the global priority ordering (lowest
   * priority value wins). Stale ids (referenced runner since removed)
   * are treated as undefined so the launch path can still pick something
   * sensible without the user having to re-edit the sidecar.
   */
  preferredRunnerId?: string;
  /**
   * Cached result of the last `llama-fit-params` probe for this model.
   * Surfaced in the Estimated column when the user toggles Auto-fit off
   * — gives the actual VRAM/RAM cost predicted by llama.cpp itself (way
   * more accurate than our heuristic on MoE / GLM-style architectures).
   * Stored in the sidecar so reopening the editor shows the last numbers
   * without re-running the probe (which costs ~5 s and reads the whole
   * weights file).
   */
  fitProbe?: FitProbeResult;
}

/** Per-device memory cost predicted by `llama-fit-params --fit-print on`. */
export interface FitProbeDevice {
  /** e.g. "ROCm0 (RX 7900 XTX)", "Host", "CUDA0". */
  name: string;
  /** Weights footprint in MiB. */
  modelMiB: number;
  /** KV cache + activations footprint in MiB. */
  contextMiB: number;
  /** Compute / scratch buffer in MiB. */
  computeMiB: number;
}

export interface FitProbeResult {
  /** ISO timestamp the probe ran. */
  ranAt: string;
  /** Runner binary used (to invalidate if the user repoints the runner). */
  runnerPath: string;
  /** Params the probe was run with — invalidate cache when these change. */
  params: {
    ngl?: number;
    ctx?: number;
    batchSize?: number;
    flashAttn?: boolean;
    fit?: boolean;
  };
  /**
   * Values llama-fit-params resolved during the load pass — these are the
   * "what llama-server would actually pick" numbers, regardless of what we
   * asked for. Parsed from verbose stderr lines (`offloaded N/M layers`,
   * `n_ctx = X`, `n_batch = Y`). Used by the editor to override our
   * cost-per-layer heuristic in the Estimated column.
   */
  resolved?: {
    ngl?: number;
    ctx?: number;
    batchSize?: number;
  };
  /** Per-device cost breakdown, all values in MiB. */
  devices: FitProbeDevice[];
  /** Best-effort total VRAM (sum of non-Host devices), MiB. */
  totalVramMiB?: number;
  /** Host RAM cost, MiB. */
  hostMiB?: number;
}

/** IPC channel names exposed by the modelhub main process. */
export const MODELHUB_IPC = {
  parseHeader: 'modelhub:parseHeader',
  enrichLocal: 'modelhub:enrichLocal',
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
  /**
   * Returns the *effective* HardwareProfile (manual override applied on
   * top of platform detection). Used by `autotune` + the in-app size
   * filter "Safe" preset + the MCP `hardware.detect` tool.
   */
  detectHardware: 'modelhub:detectHardware',
  /**
   * Returns the raw HardwareProfile from platform detection only, no
   * override applied. Settings UI uses this to show "Detected: …" next
   * to the editable override fields.
   */
  detectHardwareRaw: 'modelhub:detectHardwareRaw',
  /** Returns the persisted manual override fields (any subset). */
  getHardwareOverride: 'modelhub:getHardwareOverride',
  /** Persists the override; pass an empty object to clear every field. */
  setHardwareOverride: 'modelhub:setHardwareOverride',
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
  /**
   * Spawns `<runner.path> --help`, parses the output, and overwrites
   * the runner's `probed` field with the fresh result. Returns the
   * updated `RunnerConfig`. Triggered by the "Re-probe" button in the
   * setup dialog or whenever buildCommand discovers an outdated probe.
   */
  runnersReprobe: 'modelhub:runnersReprobe',
  /** Computes auto-tuned launch params for a given model. */
  runnersAutotune: 'modelhub:runnersAutotune',
  /** Spawns a runner with the given params. Returns pid/url. */
  runnersLaunch: 'modelhub:runnersLaunch',
  /** Stops a previously launched runner by pid. */
  runnersStop: 'modelhub:runnersStop',
  /**
   * Runs `llama-fit-params --fit-print on` against a model and parses the
   * per-device memory breakdown. Slow (~5 s on a 16 GB model, loads
   * weights into VRAM/RAM). Renderer caches the result in
   * `modelMeta.fitProbe`.
   */
  runnersFitProbe: 'modelhub:runnersFitProbe',
  /**
   * Lists currently tracked llama-server entries — both alive AND
   * recently-exited (the latter carry an `exited: { code, signal,
   * exitedAt }` field). The renderer keeps showing exited entries
   * until the user dismisses them, so a crash is visible instead of
   * "the row just disappeared".
   */
  runnersRunning: 'modelhub:runnersRunning',
  /** Returns the captured stdout/stderr ring buffer of an entry. */
  runnersGetLog: 'modelhub:runnersGetLog',
  /**
   * Push event (main → renderer): a launched child produced new stdout/
   * stderr lines. Payload: `{ pid: number, lines: string[] }`. Lines
   * are pre-split (no trailing CR/LF) and never empty. Renderer uses
   * this to live-tail the open log dialog without polling.
   */
  runnersLogChunk: 'modelhub:runnersLogChunk',
  /**
   * Push event (main → renderer): a launched child exited. Payload:
   * `{ pid: number, exited: ExitInfo, crashedEarly: boolean }`.
   * `crashedEarly` is true when the exit happened within the first
   * 5 s of the process — the renderer auto-opens the log dialog so the
   * user sees the diagnostic without having to click "view log".
   */
  runnersExit: 'modelhub:runnersExit',
  /** Removes a dead entry from the registry. No-op on live entries. */
  runnersDismiss: 'modelhub:runnersDismiss',
  /** Builds the shell command without launching (for the "copy" button). */
  runnersBuildCommand: 'modelhub:runnersBuildCommand',
  /**
   * Opens the llama-server's built-in web UI in the user's default browser
   * (`shell.openExternal`).
   */
  runnersOpenChat: 'modelhub:runnersOpenChat',

  // ---- MCP server (Phase 4.1) ------------------------------------------
  /** Starts the MCP HTTP+SSE server. Returns `{ url, token }`. */
  mcpStart: 'modelhub:mcpStart',
  /** Stops the MCP server. */
  mcpStop: 'modelhub:mcpStop',
  /** Returns running state + URL + session count. */
  mcpStatus: 'modelhub:mcpStatus',
  /** Returns the current Bearer token (creates one if missing). */
  mcpGetToken: 'modelhub:mcpGetToken',
  /** Generates a fresh token, invalidating the previous one. */
  mcpRegenerateToken: 'modelhub:mcpRegenerateToken',
  /** Lists registered tool names + descriptions (for the Settings UI). */
  mcpListTools: 'modelhub:mcpListTools',
  /** Reads the persisted "start at app boot" flag. */
  mcpGetAutoStart: 'modelhub:mcpGetAutoStart',
  /** Persists the flag; if turning on while server is idle, starts it. */
  mcpSetAutoStart: 'modelhub:mcpSetAutoStart',
  /**
   * Reads the model's behavioral `signature` block from the sidecar
   * (resolves the canonical shard internally — same convention as
   * loadModelMeta). Read-only; returns `undefined` when not characterized
   * yet. Drives the competence radar (R9.8 / D7).
   */
  loadSignature: 'modelhub:loadSignature',
  /**
   * Invoke channel: run the deterministic characterization for a model
   * (Slice 4). Hybrid execution — reuse the running instance or launch a
   * dedicated ephemeral server, then persist the signature (unless the
   * location is read-only). Resolves with the result; progress arrives
   * on `characterizeProgress`. One run at a time.
   */
  characterizeStart: 'modelhub:characterizeStart',
  /**
   * Event channel: main → renderer `{ filePath, status }` updates so any
   * mounted panel for that model can re-attach its progress bar.
   */
  characterizeProgress: 'modelhub:characterizeProgress',
  /**
   * Invoke channel: snapshot of the active run (`{ filePath, status }`) or
   * null. Lets a freshly-mounted panel re-attach after navigating away.
   */
  characterizeStatus: 'modelhub:characterizeStatus',
  /**
   * Invoke channel: bulk-characterize every model under a root, smallest
   * first, skipping already-characterized ones (Slice 5). Resolves with
   * the final progress; updates arrive on `characterizeAllProgress`.
   */
  characterizeAllStart: 'modelhub:characterizeAllStart',
  /** Event channel: main → renderer `CharacterizeAllProgress` updates. */
  characterizeAllProgress: 'modelhub:characterizeAllProgress',
  /** Invoke channel: request cancel — honoured after the current model. */
  characterizeAllCancel: 'modelhub:characterizeAllCancel',
} as const;

/** Manual hardware override fields surfaced by Settings UI. */
export interface HardwareOverride {
  vendor?: string;
  name?: string;
  vramBytes?: number;
  ramBytes?: number;
}

/** Snapshot of the MCP server state for the renderer. */
export type McpStatus =
  | { running: false }
  | { running: true; url: string; port: number; sessions: number };

/** Single tool exposure as visible from the renderer (no handler ref). */
export interface McpToolInfo {
  name: string;
  description: string;
}
