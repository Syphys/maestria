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
import { ChatClient } from './chat';
import { EmbedClient } from './embed';
import { getRoutingConfig, effectiveRoutingParams } from '../routingConfig';
import { ensureEmbedderReady } from '../embedderLifecycle';
import type { EmbedFn } from './embedProject';
import type { CharacterizationProgress } from '../../../shared/RoutingTypes';

/**
 * Architectures llama-server can't run as a chat/completions model:
 * ASR, vision/segmentation encoders, seq2seq and embedding-only nets.
 * Characterizing them is impossible — quarantine instead of launching.
 */
const NON_GENERATIVE_ARCH = new Set([
  'whisper',
  'clip',
  'sam',
  't5',
  't5encoder',
  'bert',
  'nomic-bert',
  'jina-bert-v2',
  'xlm-roberta',
]);

/** Thrown when a model can't be characterized at all (skip, don't retry). */
export class UnsupportedModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedModelError';
  }
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

  // Every status also lands in `currentRun` so a re-mounted panel can
  // re-attach its progress bar (queried via getCurrentRun / IPC snapshot).
  const emit = opts.onStatus ?? (() => undefined);
  const status = (s: CharacterizeRunStatus) => {
    currentRun = { filePath: canonical, status: s };
    emit(s);
  };
  let ephemeralPid: number | undefined;

  try {
    // Architecture pre-filter: don't even try to launch a model
    // llama-server can't run as a chat model (ASR/vision/embedding/…).
    const archOf =
      d.archOf ??
      (async (p: string) => {
        const h = await readModelHeader(p);
        return h.ok ? h.meta?.architecture : undefined;
      });
    const arch = (await archOf(canonical).catch(() => undefined))
      ?.toString()
      .toLowerCase();
    if (arch && NON_GENERATIVE_ARCH.has(arch)) {
      throw new UnsupportedModelError(`unsupported architecture: ${arch}`);
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

    const characterizeFn = d.characterizeFn ?? characterize;
    const result = await characterizeFn({
      baseUrl,
      modelFilePath: canonical,
      skipWrite: opts.skipWrite,
      onProgress: (p) => status({ stage: 'running', progress: p }),
    });

    // Slice 6a-2 — chain the tree-v0 vector pass on the SAME, still-up
    // server. It builds ADDITIVELY on the R5 signature we just computed
    // (injected via `loadExisting` so it works even when `skipWrite`
    // suppressed the on-disk write) and is R5-gated: only R5-maximal
    // branches deepen, so the extra model calls stay bounded (Dββ). A
    // tree failure is ISOLATED — R5 is a valid result on its own, so we
    // keep it and only log; the tree must never sink the whole run.
    // Covers both the single-model and the bulk path (characterizeAll
    // delegates here). Fine-grained tree progress is deferred to 6c.
    // Slice 7d/7e — Free-gen probe wiring. Resolve the embedder per
    // routing config: `managed` ⇒ maestria launches the GGUF itself
    // (slice 7e, recommended UX); `external` ⇒ user-provided URL.
    // Absent ⇒ probe skipped silently (Decision DCC §4 preserves the
    // absent path).
    let embed: EmbedFn | undefined;
    try {
      const cfg = await getRoutingConfig();
      const params = effectiveRoutingParams(cfg);
      if (params.embedder?.kind === 'managed') {
        const ready = await ensureEmbedderReady(params.embedder.filePath, {
          model: params.embedder.model,
        });
        if (ready) {
          const client = new EmbedClient({
            baseUrl: ready.baseUrl,
            model: ready.model,
          });
          embed = (texts) => client.embed(texts);
        }
      } else if (params.embedder?.kind === 'external') {
        const client = new EmbedClient({
          baseUrl: params.embedder.baseUrl,
          model: params.embedder.model,
        });
        embed = (texts) => client.embed(texts);
      }
    } catch {
      // never fatal — probe just doesn't run
    }

    const characterizeTreeFn = d.characterizeTreeFn ?? characterizeTree;
    let finalResult = result;
    try {
      const treeRes = await characterizeTreeFn({
        modelFilePath: canonical,
        ask: new ChatClient({ baseUrl }),
        skipWrite: opts.skipWrite,
        embed,
        loadExisting: async () => result.signature,
        computeHash: async () => result.signature.modelHash,
      });
      finalResult = {
        ...result,
        signature: treeRes.signature,
        written: treeRes.written,
        sidecarPath: treeRes.sidecarPath,
      };
    } catch (e) {
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
