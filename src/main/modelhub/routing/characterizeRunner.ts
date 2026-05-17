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

import { listRunning, stopProcess } from '../runners/launch';
import { launchModelByPath } from '../launchModel';
import { resolveCanonicalShardPath } from '../shardFs';
import { characterize, type CharacterizeResult } from './characterize';
import type { CharacterizationProgress } from '../../../shared/RoutingTypes';

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
  waitReady?: (url: string) => Promise<void>;
  resolveCanonical?: (filePath: string) => Promise<string>;
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

/** Poll the llama-server OpenAI endpoint until it answers or times out. */
async function waitForServerReady(
  url: string,
  timeoutMs = 600_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probe = `${url.replace(/\/$/, '')}/v1/models`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
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
      await (
        d.waitReady ??
        ((u: string) => waitForServerReady(u, opts.readyTimeoutMs))
      )(baseUrl);
    }

    const characterizeFn = d.characterizeFn ?? characterize;
    const result = await characterizeFn({
      baseUrl,
      modelFilePath: canonical,
      skipWrite: opts.skipWrite,
      onProgress: (p) => status({ stage: 'running', progress: p }),
    });

    status({ stage: 'done', result });
    return result;
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
