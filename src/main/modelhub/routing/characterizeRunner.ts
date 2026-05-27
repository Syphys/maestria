// Slice 4 — Characterization trigger orchestrator.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R2.6 / R3 ; arbitration: DECISIONS.md
// D3 / D8 ; Slice-4 decisions (hybrid execution, single in-flight).
//
// `characterize` (Slice 2) needs a reachable OpenAI-compatible llama-server.
// This wrapper supplies one:
//   - if THIS model is already running → reuse that instance's URL;
//   - else launch a dedicated autotuned server, wait until it answers,
//     run the suite, then stop it (ephemeral).
// One characterization at a time (no queue — R3.5 out of scope). Every
// external effect is injectable so the orchestration is unit-testable
// offline (no fs / no spawn / no network).

import { listRunning, stopProcess, getActiveEntry } from '../runners/launch';
import { launchModelByPath } from '../launchModel';
import { readModelHeader } from '../parseHeader';
import { resolveCanonicalShardPath } from '../shardFs';
import { characterize, type CharacterizeResult } from './characterize';
import { characterizeTree } from './characterizeTree';
import { ChatClient, type ChatLike } from './chat';
import { EmbedClient } from './embed';
import { getRoutingConfig, effectiveRoutingParams } from '../routingConfig';
import { ensureEmbedderReady } from '../embedderLifecycle';
import { getSandbox, SandboxUnavailable } from './sandbox';
import { loadSignature, saveSignature } from './signatureStore';
import { archiveServerLog } from '../modelLogStore';
import { generateFreeGenText, projectFreeGenText } from './freegen';
import probeAnchors from './questions/probe-anchors.json';
import type { EmbedFn } from './embedProject';
import type {
  BehavioralSignature,
  CharacterizationProgress,
  ProbeAnchorBank,
  Signature,
} from '../../../shared/RoutingTypes';

/**
 * Architectures llama-server can't run as a chat/completions model.
 * Three sub-families:
 *   - **ASR / vision / segmentation encoders** — `whisper`, `clip`,
 *     `sam`: input is a non-text modality; no chat head.
 *   - **Seq2seq / embedding-only nets** — `t5`, `bert` & friends:
 *     encoder-decoder or pooled, no autoregressive chat.
 *   - **TTS / audio-codec wrappers** — dedicated arch names that
 *     reuse an LLM backbone but emit AUDIO codebook tokens, not
 *     text (Cosyvoice, OuteTTS, Parler-TTS, Kokoro, MOSS-TTS,
 *     Qwen{2,3}-TTS — see https://huggingface.co/cstr/qwen3-tts-1.7b-
 *     customvoice-GGUF for the convention). Some TTS GGUFs DON'T
 *     declare a tts-flavoured arch (e.g. Cosyvoice = `qwen2`); those
 *     fall through to the `general.name` regex below or the adaptive
 *     non-text-response quarantine after the first prompt.
 */
const NON_GENERATIVE_ARCH = new Set([
  // ASR / vision / segmentation
  'whisper',
  'clip',
  'sam',
  // Seq2seq / embedding-only
  't5',
  't5encoder',
  'bert',
  'nomic-bert',
  'jina-bert-v2',
  'xlm-roberta',
  // TTS / audio codec — dedicated arch names
  'qwen3tts',
  'qwen2tts',
  'outetts',
  'parlertts',
  'kokoro',
  'mossttts',
  'snactts',
]);

/**
 * `general.name` regex catching repackaged TTS / audio-codec GGUFs that
 * declare an LLM-backbone architecture (e.g. Cosyvoice =
 * `general.architecture: qwen2` with `general.name: Llamacpp_Tokenizer`).
 *
 * The boundary class `[\W_]` (non-word OR underscore) instead of `\b`:
 * JS `\b` treats `_` as part of the word, so `\btokenizer\b` does NOT
 * match `Llamacpp_Tokenizer`. We need underscores to act as separators
 * because that's the canonical Hugging Face naming convention.
 * Tested 2026-05-24 against the real Cosyvoice3 GGUF.
 */
const NON_CHAT_NAME_RE =
  /(?:^|[\W_])(tokenizer|codec|vocoder|vq|cfm|tts)(?:[\W_]|$)/i;

/** Thrown when a model can't be characterized at all (skip, don't retry). */
export class UnsupportedModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedModelError';
  }
}

/**
 * True when GGUF metadata describes an EMBEDDING model — it carries a
 * `<arch>.pooling_type` ≥ 1 (MEAN / CLS / LAST). A generative chat model
 * has no pooling key at all.
 *
 * This catches embedding models built on a generative architecture
 * (e.g. Qwen3-Embedding → arch `qwen3`, BGE-Gemma → `gemma`) that the
 * `NON_GENERATIVE_ARCH` NAME list cannot — they share an arch id with a
 * real chat model. Such a model has no chat/completion head: launched as
 * a chat server it scores ~0 on every diagnostic prompt.
 */
export function isEmbeddingKv(kv: unknown): boolean {
  if (!kv || typeof kv !== 'object') return false;
  return Object.entries(kv as Record<string, unknown>).some(
    ([k, v]) => k.endsWith('.pooling_type') && typeof v === 'number' && v >= 1,
  );
}

/** Default embedding-model probe — reads the GGUF header, checks pooling. */
async function defaultIsEmbeddingModel(filePath: string): Promise<boolean> {
  const h = await readModelHeader(filePath).catch(() => undefined);
  return h?.ok ? isEmbeddingKv(h.meta?.rawMetadata) : false;
}

export type CharacterizeRunStatus =
  | { stage: 'preparing'; detail: 'reuse' | 'launching' | 'waiting_ready' }
  | { stage: 'running'; progress: CharacterizationProgress }
  | { stage: 'done'; result: CharacterizeResult }
  | { stage: 'error'; error: string };

type LaunchLike = (
  filePath: string,
) => Promise<{ ok: boolean; pid?: number; url?: string; error?: string }>;

export interface RunCharacterizationDeps {
  listRunning?: typeof listRunning;
  launch?: LaunchLike;
  stop?: (pid: number) => void;
  characterizeFn?: typeof characterize;
  /** Slice 6a-2 — tree-v0 vector pass chained after R5 (test seam). */
  characterizeTreeFn?: typeof characterizeTree;
  waitReady?: (url: string) => Promise<void>;
  resolveCanonical?: (filePath: string) => Promise<string>;
  /** Resolve a model's architecture (deny-list pre-filter). */
  archOf?: (filePath: string) => Promise<string | undefined>;
  /** Detect an embedding-only GGUF (no chat head). Test seam. */
  isEmbeddingModel?: (filePath: string) => Promise<boolean>;
  /** Boot-crash probe for the launched pid (fail-fast). */
  getExit?: (pid: number) => { exited: boolean; log?: string[] };
}

export interface RunCharacterizationOptions {
  /** Pass `loc.isReadOnly` — true ⇒ computed but not persisted. */
  skipWrite?: boolean;
  onStatus?: (s: CharacterizeRunStatus) => void;
  /** Test seams. */
  deps?: RunCharacterizationDeps;
  /** Readiness ceiling for an ephemeral launch (default 10 min). */
  readyTimeoutMs?: number;
  /**
   * Free-gen probe master switch (« Parler libre » checkbox). Default
   * ON (`undefined` ⇒ true). `false` ⇒ skip the ~600-800-word
   * monologue; characterization is the QCM staircase only.
   */
  freegen?: boolean;
  /**
   * Bulk-cancel propagation. When the user clicks "Cancel" on the
   * bulk panel, characterizeAll aborts a shared AbortController and
   * the signal flows from here into characterize() and freegen(),
   * which forward it to each chat.complete() so the in-flight HTTP
   * request and the inner prompt loop both bail out immediately.
   */
  signal?: AbortSignal;
}

/** Canonical path of the run in flight, or null. Guards against overlap. */
let inFlight: string | null = null;

/**
 * Snapshot of the active run so a freshly-mounted UI can re-attach its
 * progress bar after navigating away and back. Cleared when the run ends.
 */
let currentRun: { filePath: string; status: CharacterizeRunStatus } | null =
  null;

/** True while a characterization is running (any model). */
export function isCharacterizing(): boolean {
  return inFlight !== null;
}

/** The active run + its latest status, or null when idle. */
export function getCurrentRun(): {
  filePath: string;
  status: CharacterizeRunStatus;
} | null {
  return currentRun;
}

/**
 * Poll the llama-server OpenAI endpoint until it answers or times out.
 * `checkExit` lets us bail in ~2 s when the launched process boot-crashes
 * (e.g. `unknown model architecture`) instead of polling for 10 minutes.
 */
async function waitForServerReady(
  url: string,
  opts: {
    timeoutMs?: number;
    checkExit?: () => { exited: boolean; log?: string[] };
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  const probe = `${url.replace(/\/$/, '')}/v1/models`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ex = opts.checkExit?.();
    if (ex?.exited) {
      const tail = (ex.log ?? []).slice(-6).join(' ').slice(-300);
      throw new UnsupportedModelError(
        `server exited before becoming ready${tail ? ` — ${tail}` : ''}`,
      );
    }
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      const r = await fetch(probe, { signal: ac.signal });
      clearTimeout(t);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error('server did not become ready in time');
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/**
 * Run a characterization for `filePath`, supplying the llama-server per the
 * hybrid policy. Resolves with the persisted/computed signature result.
 * Rejects if a characterization is already running or the run fails.
 */
export async function runCharacterization(
  filePath: string,
  opts: RunCharacterizationOptions = {},
): Promise<CharacterizeResult> {
  const d = opts.deps ?? {};
  const resolveC = d.resolveCanonical ?? resolveCanonicalShardPath;
  const canonical = await resolveC(filePath);

  if (inFlight) {
    throw new Error('A characterization is already running');
  }
  inFlight = canonical;

  // Rotate the previous session's `.log` into a timestamped archive
  // so this run starts on a clean file. No-op when no prior log
  // exists or when called from `characterizeAll` (which has already
  // archived it for this model). Best effort.
  await archiveServerLog(canonical, { skipWrite: opts.skipWrite }).catch(
    () => undefined,
  );

  // Every status also lands in `currentRun` so a re-mounted panel can
  // re-attach its progress bar (queried via getCurrentRun / IPC snapshot).
  const emit = opts.onStatus ?? (() => undefined);
  const status = (s: CharacterizeRunStatus) => {
    currentRun = { filePath: canonical, status: s };
    emit(s);
  };
  let ephemeralPid: number | undefined;

  try {
    // Format pre-filter: llama.cpp launches GGUF (safetensors in
    // principle). A .pt / .pth / .bin / .ckpt PyTorch/TF checkpoint can
    // never be a chat model — quarantine it instead of failing later at
    // the launch step with a misleading "no runner configured" message.
    if (!/\.(gguf|safetensors)$/i.test(canonical)) {
      const ext = canonical.replace(/^.*(\.[^.\\/]+)$/, '$1') || '(none)';
      throw new UnsupportedModelError(`unsupported file format: ${ext}`);
    }
    // Pre-launch filters (three signals, ordered cheapest → most
    // structural). Each one alone is enough to quarantine. See
    // NON_GENERATIVE_ARCH / NON_CHAT_NAME_RE / `isEmbeddingKv` for the
    // rationale of each list.
    //
    // We read the header ONCE (one fs read) and reuse it for all three
    // checks; an embedded sub-arch like `qwen2` (Cosyvoice's backbone)
    // can pass the arch check but get caught by the name check.
    const header = await readModelHeader(canonical).catch(() => undefined);
    const arch = header?.ok
      ? header.meta?.architecture?.toString().toLowerCase()
      : undefined;
    const name = header?.ok ? header.meta?.name : undefined;

    if (arch && NON_GENERATIVE_ARCH.has(arch)) {
      throw new UnsupportedModelError(`unsupported architecture: ${arch}`);
    }
    // Repackaged TTS / audio-codec GGUFs that reuse an LLM-backbone
    // arch (Cosyvoice: arch=qwen2, name="Llamacpp_Tokenizer"). The arch
    // list above can't catch these. The name regex is narrow on
    // purpose — `\btts\b` won't match arbitrary marketing strings.
    if (name && NON_CHAT_NAME_RE.test(name)) {
      throw new UnsupportedModelError(
        `non-chat model — name "${name}" matches audio/codec/tokenizer pattern`,
      );
    }
    // Embedding-model pre-filter — catches embedding GGUFs whose arch id
    // is shared with a real chat model (Qwen3-Embedding → `qwen3`), so
    // the arch name list above can't. They have no chat head ⇒ score ~0
    // on every prompt. Quarantine instead of wasting a full suite on one.
    const isEmbedding =
      d.isEmbeddingModel ??
      (async (_p: string) =>
        header?.ok ? isEmbeddingKv(header.meta?.rawMetadata) : false);
    if (await isEmbedding(canonical).catch(() => false)) {
      throw new UnsupportedModelError(
        'embedding model — no chat/completion capability',
      );
    }
    // archOf is no longer needed inline (we read the header once above),
    // but we still expose it as a test seam — invoke it for shape parity
    // when an injected one was provided.
    const archOfSeam = d.archOf;
    if (archOfSeam) {
      await archOfSeam(canonical).catch(() => undefined);
    }

    const running = (d.listRunning ?? listRunning)();
    const hit = running.find(
      (r) => r.filePath === canonical && !r.exited && !!r.url,
    );

    let baseUrl: string;
    if (hit?.url) {
      status({ stage: 'preparing', detail: 'reuse' });
      baseUrl = hit.url;
    } else {
      status({ stage: 'preparing', detail: 'launching' });
      const launch: LaunchLike =
        d.launch ??
        ((p) => launchModelByPath(p, { launchedBy: 'characterize' }));
      const res = await launch(canonical);
      if (!res.ok || !res.url || res.pid == null) {
        throw new Error(res.error || 'failed to launch a server');
      }
      ephemeralPid = res.pid;
      baseUrl = res.url;
      status({ stage: 'preparing', detail: 'waiting_ready' });
      const pid = res.pid;
      const getExit =
        d.getExit ??
        ((p: number) => {
          const e = getActiveEntry(p);
          return { exited: !!e?.exited, log: e?.log };
        });
      await (
        d.waitReady ??
        ((u: string) =>
          waitForServerReady(u, {
            timeoutMs: opts.readyTimeoutMs,
            checkExit: () => getExit(pid),
          }))
      )(baseUrl);
    }

    // Resolve the model's effective `ctx` from whichever runner entry
    // backs this baseUrl — the freshly-launched ephemeral one OR the
    // reused user-launched one. Each model thus gets its OWN max_tokens
    // cap (= its loaded context window), instead of a hardcoded global
    // value that would either truncate thinking models or let runaways
    // burn way past their natural ceiling. Unknown ctx ⇒ undefined ⇒
    // ChatClient sends no max_tokens (llama-server uses its default).
    const launchedPid = ephemeralPid ?? hit?.pid;
    const maxTokens =
      typeof launchedPid === 'number'
        ? getActiveEntry(launchedPid)?.params?.ctx
        : undefined;

    const characterizeFn = d.characterizeFn ?? characterize;
    const result = await characterizeFn({
      baseUrl,
      modelFilePath: canonical,
      maxTokens,
      skipWrite: opts.skipWrite,
      onProgress: (p) => status({ stage: 'running', progress: p }),
      signal: opts.signal,
    });

    // Slice 6a-2 — chain the tree-v0 vector pass on the SAME, still-up
    // server. It builds ADDITIVELY on the R5 signature we just computed
    // (injected via `loadExisting` so it works even when `skipWrite`
    // suppressed the on-disk write) and is R5-gated: only R5-maximal
    // branches deepen, so the extra model calls stay bounded (Dββ). A
    // tree failure is ISOLATED — R5 is a valid result on its own, so we
    // keep it and only log; the tree must never sink the whole run.
    //
    // Two-pass protocol (2026-05-23): the embedder is NEVER resolved or
    // launched here, so the test model is the only thing in memory
    // during this run. Free-gen phase 1 still runs (capture
    // `freegen_text`), but phase 2 (project onto anchors) is deferred —
    // `characterizeAll` runs a single dedicated projection pass at the
    // end with the embedder loaded once, never concurrent with a test
    // model. Single-model standalone callers: the projection becomes a
    // separate `runFreeGenProject(filePath, embed)` step.
    let runSandbox:
      | ((req: {
          codeLang: 'python' | 'cpp';
          code: string;
          tests: string;
        }) => Promise<boolean>)
      | undefined;
    try {
      // Slice 2d — Sandbox seam. Always built (the dispatch picks the
      // right provider, including `UnsafeSandbox` when the opt-in is
      // off). The provider throws `SandboxUnavailable` when the OS
      // boundary cannot be established; we re-throw so the staircase
      // catches it and marks the item UNMEASURED (D12 prior).
      const cfg = await getRoutingConfig();
      const params = effectiveRoutingParams(cfg);
      const provider = getSandbox({ enabled: params.enableSandbox });
      runSandbox = async (req) => {
        if (req.codeLang !== 'python') {
          // v0: Python only. cpp tests stay UNMEASURED.
          throw new SandboxUnavailable(
            `language not supported in sandbox v0: ${req.codeLang}`,
          );
        }
        const r = await provider.runPythonTests(req.code, req.tests);
        return r.pass;
      };
    } catch {
      // never fatal — sandbox seam just doesn't run, code-test leaves
      // stay UNMEASURED (D12 prior).
    }

    const characterizeTreeFn = d.characterizeTreeFn ?? characterizeTree;
    let finalResult = result;
    try {
      const treeRes = await characterizeTreeFn({
        modelFilePath: canonical,
        ask: new ChatClient({ baseUrl, maxTokens }),
        skipWrite: opts.skipWrite,
        // No embedder during the test session — projection is deferred
        // to characterizeAll's pass 2. characterizeTree still captures
        // the free-gen text (phase 1, chat client only) when
        // `opts.freegen !== false`.
        embed: undefined,
        freegen: opts.freegen,
        seams: runSandbox ? { runSandbox } : undefined,
        loadExisting: async () => result.signature,
        computeHash: async () => result.signature.modelHash,
        signal: opts.signal,
      });
      finalResult = {
        ...result,
        signature: treeRes.signature,
        written: treeRes.written,
        sidecarPath: treeRes.sidecarPath,
      };
    } catch (e) {
      // Cancel takes precedence over the "tree failure is isolated"
      // policy — without this re-throw, a user clicking Cancel during
      // the tree pass would have the abort silently swallowed here,
      // the function would `return finalResult`, the outer finally
      // would still fire (so llama-server gets killed), but
      // characterizeAll's loop would NOT see a throw and so wouldn't
      // know to set its terminal `cancelled` phase — the UI would
      // stay on « Caractérisation en cours… ».
      if (opts.signal?.aborted) throw e;
      // eslint-disable-next-line no-console
      console.error(
        `tree characterization failed (R5 kept): ${(e as Error).message}`,
      );
    }

    status({ stage: 'done', result: finalResult });
    return finalResult;
  } catch (e) {
    status({ stage: 'error', error: (e as Error).message });
    throw e;
  } finally {
    if (ephemeralPid != null) {
      try {
        (d.stop ?? stopProcess)(ephemeralPid);
      } catch {
        /* already gone */
      }
    }
    inFlight = null;
    currentRun = null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Free-gen backfill — add ONLY the « Parler libre » monologue to a model
// that is already fully characterized (QCM staircase done) but predates
// the free-gen probe. NO staircase re-run. When the model still carries
// its stored `freegen_text` we just re-project it (embedder only, no
// model launch — user decision 2026-05-22); otherwise we launch it, make
// it talk once, project, and stop it. The « Tout caractériser » bulk
// path routes an already-`complete` signature that lacks the free-gen
// evidence here instead of skipping it.
// ──────────────────────────────────────────────────────────────────────

export interface FreeGenBackfillDeps {
  resolveCanonical?: (p: string) => Promise<string>;
  loadSignature?: typeof loadSignature;
  saveSignature?: typeof saveSignature;
  /** Resolve an embedder fn — MUST throw when none is configured. */
  resolveEmbed?: () => Promise<EmbedFn>;
  /**
   * Launch (or reuse) a server for `canonical`, returning a chat client
   * and a `release` that stops the server iff this call launched it.
   * Only invoked when the model has to actually talk (no stored text).
   */
  acquireChat?: (
    canonical: string,
    status: (s: CharacterizeRunStatus) => void,
    readyTimeoutMs?: number,
  ) => Promise<{ ask: ChatLike; release: () => void }>;
}

export interface FreeGenBackfillOptions {
  /** Pass `loc.isReadOnly` — true ⇒ computed but not persisted. */
  skipWrite?: boolean;
  onStatus?: (s: CharacterizeRunStatus) => void;
  deps?: FreeGenBackfillDeps;
  readyTimeoutMs?: number;
  /** Bulk-cancel propagation — see RunCharacterizationOptions.signal. */
  signal?: AbortSignal;
}

/**
 * Resolve the configured embedder, or throw `no embedder configured`.
 * Exported so the bulk path (`characterizeAll`) can load the embedder
 * ONCE for its projection pass — never concurrent with a test model.
 */
export async function resolveEmbedderFn(): Promise<EmbedFn> {
  const cfg = await getRoutingConfig();
  const params = effectiveRoutingParams(cfg);
  if (params.embedder?.kind === 'managed') {
    const ready = await ensureEmbedderReady(params.embedder.filePath, {
      model: params.embedder.model,
    });
    if (!ready) throw new Error('embedder failed to start');
    const client = new EmbedClient({
      baseUrl: ready.baseUrl,
      model: ready.model,
    });
    return (texts) => client.embed(texts);
  }
  if (params.embedder?.kind === 'external') {
    const client = new EmbedClient({
      baseUrl: params.embedder.baseUrl,
      model: params.embedder.model,
    });
    return (texts) => client.embed(texts);
  }
  throw new Error('no embedder configured');
}

/** Default `acquireChat` — launch/reuse a llama-server, stop on release. */
async function defaultAcquireChat(
  canonical: string,
  status: (s: CharacterizeRunStatus) => void,
  readyTimeoutMs?: number,
): Promise<{ ask: ChatLike; release: () => void }> {
  const hit = listRunning().find(
    (r) => r.filePath === canonical && !r.exited && !!r.url,
  );
  if (hit?.url) {
    status({ stage: 'preparing', detail: 'reuse' });
    // Read this user-launched server's effective ctx so its max_tokens
    // matches the loaded context window — each model uses its OWN max.
    const maxTokens = hit.pid
      ? getActiveEntry(hit.pid)?.params?.ctx
      : undefined;
    return {
      ask: new ChatClient({ baseUrl: hit.url, maxTokens }),
      release: () => undefined, // user-launched — leave it running
    };
  }
  status({ stage: 'preparing', detail: 'launching' });
  const res = await launchModelByPath(canonical, {
    launchedBy: 'characterize',
  });
  if (!res.ok || !res.url || res.pid == null) {
    throw new Error(res.error || 'failed to launch a server');
  }
  const pid = res.pid;
  const baseUrl = res.url;
  status({ stage: 'preparing', detail: 'waiting_ready' });
  await waitForServerReady(baseUrl, {
    timeoutMs: readyTimeoutMs,
    checkExit: () => {
      const e = getActiveEntry(pid);
      return { exited: !!e?.exited, log: e?.log };
    },
  });
  // Same convention as above: per-model max_tokens = its loaded ctx.
  // Pulled from `res.params` first (launch returned it), with the
  // entry as a fallback in case res.params was not populated.
  const maxTokens = res.params?.ctx ?? getActiveEntry(pid)?.params?.ctx;
  return {
    ask: new ChatClient({ baseUrl, maxTokens }),
    release: () => {
      try {
        stopProcess(pid);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Options for the pure projection step (no chat client involved). */
export interface FreeGenProjectOptions {
  /** Pass `loc.isReadOnly` — true ⇒ computed but not persisted. */
  skipWrite?: boolean;
  onStatus?: (s: CharacterizeRunStatus) => void;
  deps?: {
    resolveCanonical?: (p: string) => Promise<string>;
    loadSignature?: typeof loadSignature;
    saveSignature?: typeof saveSignature;
  };
}

/**
 * Pass-1 primitive — ensure `freegen_text` exists for a model. Launches
 * the model only if no text is stored, generates it, and patches the
 * signature. Does NOT touch the embedder — that's pass 2's job.
 *
 * `inFlight`-guarded (one chat-server run at a time across the app).
 * Pre-existing text ⇒ no-op (returns immediately, no model launch).
 */
export async function runFreeGenGenerate(
  filePath: string,
  opts: FreeGenBackfillOptions = {},
): Promise<CharacterizeResult> {
  const d = opts.deps ?? {};
  const resolveC = d.resolveCanonical ?? resolveCanonicalShardPath;
  const ls = d.loadSignature ?? loadSignature;
  const ss = d.saveSignature ?? saveSignature;
  const acquireChat = d.acquireChat ?? defaultAcquireChat;
  const canonical = await resolveC(filePath);

  if (inFlight) {
    throw new Error('A characterization is already running');
  }
  inFlight = canonical;
  const emit = opts.onStatus ?? (() => undefined);
  const status = (s: CharacterizeRunStatus) => {
    currentRun = { filePath: canonical, status: s };
    emit(s);
  };

  try {
    const sig = await ls(canonical);
    if (!sig || !sig.behavioral || sig.characterization_state !== 'complete') {
      throw new Error('no complete signature to backfill free-gen');
    }
    // Text already there ⇒ nothing to do here. The projection step is
    // separate and idempotent against a present text — no need to make
    // the model talk again.
    if (sig.behavioral.freegen_text) {
      const result: CharacterizeResult = {
        signature: sig,
        written: false,
        sidecarPath: '',
        itemsRun: 0,
        errors: 0,
      };
      status({ stage: 'done', result });
      return result;
    }

    const { ask, release } = await acquireChat(
      canonical,
      status,
      opts.readyTimeoutMs,
    );
    let text: string;
    let words: number;
    try {
      const gen = await generateFreeGenText(ask, { signal: opts.signal });
      text = gen.text;
      words = gen.words;
    } finally {
      release();
    }

    const behavioral: BehavioralSignature = {
      ...sig.behavioral,
      freegen_text: text,
      freegen_words: words,
    };
    const patched: Signature = { ...sig, behavioral };
    const { written, sidecarPath } = await ss(canonical, patched, {
      skipWrite: opts.skipWrite,
    });
    const result: CharacterizeResult = {
      signature: patched,
      written,
      sidecarPath,
      itemsRun: 0,
      errors: 0,
    };
    status({ stage: 'done', result });
    return result;
  } catch (e) {
    status({ stage: 'error', error: (e as Error).message });
    throw e;
  } finally {
    inFlight = null;
    currentRun = null;
  }
}

/**
 * Pass-2 primitive — project a stored `freegen_text` onto the leaf
 * anchors and patch the signature with `topic_coverage_*`. NO model
 * launch, NO embedder resolution: the caller injects `embed` so the
 * bulk path can load the embedder ONCE and reuse it across every model.
 *
 * No `inFlight` guard — projection is offline (no chat server) and the
 * bulk path runs many of these back-to-back in its own loop.
 */
export async function runFreeGenProject(
  filePath: string,
  embed: EmbedFn,
  opts: FreeGenProjectOptions = {},
): Promise<CharacterizeResult> {
  const d = opts.deps ?? {};
  const resolveC = d.resolveCanonical ?? resolveCanonicalShardPath;
  const ls = d.loadSignature ?? loadSignature;
  const ss = d.saveSignature ?? saveSignature;
  const canonical = await resolveC(filePath);

  const emit = opts.onStatus ?? (() => undefined);
  const status = (s: CharacterizeRunStatus) => {
    currentRun = { filePath: canonical, status: s };
    emit(s);
  };

  try {
    const sig = await ls(canonical);
    if (!sig || !sig.behavioral || sig.characterization_state !== 'complete') {
      throw new Error('no complete signature to project');
    }
    const text = sig.behavioral.freegen_text;
    if (!text) {
      throw new Error('no freegen_text to project — generate it first');
    }
    status({ stage: 'preparing', detail: 'reuse' });
    const anchors = probeAnchors as unknown as ProbeAnchorBank;
    const proj = await projectFreeGenText(text, embed, anchors);
    const behavioral: BehavioralSignature = {
      ...sig.behavioral,
      topic_coverage_per_leaf: proj.topic_coverage_per_leaf,
      topic_coverage_per_branch: proj.topic_coverage_per_branch,
    };
    const patched: Signature = { ...sig, behavioral };
    const { written, sidecarPath } = await ss(canonical, patched, {
      skipWrite: opts.skipWrite,
    });
    const result: CharacterizeResult = {
      signature: patched,
      written,
      sidecarPath,
      itemsRun: 0,
      errors: 0,
    };
    status({ stage: 'done', result });
    return result;
  } catch (e) {
    status({ stage: 'error', error: (e as Error).message });
    throw e;
  } finally {
    currentRun = null;
  }
}

/**
 * One-call backfill — generate then project, in two phases. The bulk
 * path does NOT use this (it batches all projections at the end with
 * the embedder loaded once); kept for single-model standalone use and
 * for tests that exercise the compose.
 */
export async function runFreeGenBackfill(
  filePath: string,
  opts: FreeGenBackfillOptions = {},
): Promise<CharacterizeResult> {
  const d = opts.deps ?? {};
  const resolveEmbed = d.resolveEmbed ?? resolveEmbedderFn;
  // Phase 1: ensure the text exists (generates only if missing).
  await runFreeGenGenerate(filePath, opts);
  // Phase 2: resolve the embedder and project. Re-loading the sig
  // here is intentional — phase 1 may have just written a fresh text.
  const embed = await resolveEmbed();
  return runFreeGenProject(filePath, embed, {
    skipWrite: opts.skipWrite,
    onStatus: opts.onStatus,
    deps: {
      resolveCanonical: d.resolveCanonical,
      loadSignature: d.loadSignature,
      saveSignature: d.saveSignature,
    },
  });
}
