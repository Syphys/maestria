/**
 * Slice 7e — Maestria-managed embedder lifecycle.
 *
 * The routing path needs an embedding model. Two options at config time
 * (see `routingConfig.ts` and `effectiveRoutingParams`):
 *   - `external` ⇒ user runs llama-server themselves, provides a URL
 *   - `managed`  ⇒ user just picks a GGUF file, MAESTRIA launches it
 *
 * This module handles the second case. It exposes a single
 * `ensureEmbedderReady()` entry point — idempotent: returns the live
 * URL of an already-running maestria-managed embedder, or launches one
 * (with `--embedding`, `launchedBy: 'embedder'`) and waits for it to
 * answer before returning.
 *
 * On failure (file missing, port stuck, server boot-crash) it returns
 * null and logs — the caller (characterize / route) silently falls back
 * to the R5-only path. Never throws to the caller.
 *
 * The embedder process is registered with the regular runner
 * infrastructure (`runners/launch.ts`), so it shows up in
 * `RunningModelsPanel` with `launchedBy: 'embedder'` and can be
 * stopped/inspected like any other model.
 */

import { listRunning, getActiveEntry, stopProcess } from './runners/launch';
import { launchModelByPath } from './launchModel';
import { resolveCanonicalShardPath } from './shardFs';

/** Default port the managed embedder binds to (different from chat 8080). */
export const DEFAULT_EMBEDDER_PORT = 8081;
/** Provenance tag — RunningModelsPanel filters / groups by this. */
export const EMBEDDER_LAUNCHED_BY = 'embedder';
/** How long to wait for `/v1/models` to answer before giving up. */
const READY_TIMEOUT_MS = 60_000;
/** Polling interval while waiting for ready. */
const READY_POLL_MS = 1_000;

export interface EnsureEmbedderReadyResult {
  baseUrl: string;
  pid: number;
  model?: string;
  source: 'reused' | 'launched';
}

/**
 * In-flight guard: if two callers ask for the embedder at the same time
 * (a model being characterized + a routing query firing concurrently),
 * both wait on the same promise instead of trying to launch twice.
 */
let inFlightLaunch: Promise<EnsureEmbedderReadyResult | null> | null = null;

/** Find an already-running managed embedder matching `filePath`. */
function findRunning(canonical: string): { pid: number; url: string } | null {
  for (const r of listRunning()) {
    if (
      r.launchedBy === EMBEDDER_LAUNCHED_BY &&
      r.filePath === canonical &&
      !r.exited &&
      r.url
    ) {
      return { pid: r.pid, url: r.url };
    }
  }
  return null;
}

/** Stop ALL maestria-managed embedders (cleanup helper). */
export function stopManagedEmbedders(): void {
  for (const r of listRunning()) {
    if (r.launchedBy === EMBEDDER_LAUNCHED_BY && !r.exited) {
      try {
        stopProcess(r.pid);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Wait until the embedder's `/v1/models` endpoint answers, OR the
 * process exits (boot-crash fast-fail), OR the timeout expires.
 */
async function waitForReady(url: string, pid: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const probe = `${url.replace(/\/+$/, '')}/v1/models`;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const entry = getActiveEntry(pid);
    if (entry?.exited) {
      const tail = (entry.log ?? []).slice(-6).join(' ').slice(-300);
      throw new Error(`embedder exited during boot${tail ? ` — ${tail}` : ''}`);
    }
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(probe, { signal: ac.signal });
      clearTimeout(t);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(
        `embedder did not become ready in ${READY_TIMEOUT_MS} ms`,
      );
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/**
 * Idempotent: returns a ready embedder's URL, launching it if needed.
 * Concurrency-safe — concurrent calls share the same launch promise.
 * Failure ⇒ null (caller falls back, never crashes).
 */
export async function ensureEmbedderReady(
  filePath: string,
  opts: { model?: string; port?: number } = {},
): Promise<EnsureEmbedderReadyResult | null> {
  if (inFlightLaunch) return inFlightLaunch;
  const work = (async (): Promise<EnsureEmbedderReadyResult | null> => {
    try {
      const canonical = await resolveCanonicalShardPath(filePath);
      const reused = findRunning(canonical);
      if (reused) {
        return {
          baseUrl: reused.url,
          pid: reused.pid,
          model: opts.model,
          source: 'reused',
        };
      }
      // Launch via the standard pipeline. `customArgs: '--embedding'`
      // flips llama-server into embedding mode; the runner picks a port.
      const result = await launchModelByPath(canonical, {
        launchedBy: EMBEDDER_LAUNCHED_BY,
        port: opts.port ?? DEFAULT_EMBEDDER_PORT,
        paramsOverride: {
          customArgs: '--embedding',
        },
      });
      if (!result.ok || !result.url || result.pid == null) {
        // eslint-disable-next-line no-console
        console.warn(`[embedder] launch failed: ${result.error ?? 'unknown'}`);
        return null;
      }
      try {
        await waitForReady(result.url, result.pid);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[embedder] not ready: ${(e as Error).message}`);
        try {
          stopProcess(result.pid);
        } catch {
          /* already gone */
        }
        return null;
      }
      return {
        baseUrl: result.url,
        pid: result.pid,
        model: opts.model,
        source: 'launched',
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[embedder] ensure failed: ${(e as Error).message}`);
      return null;
    }
  })();
  inFlightLaunch = work;
  try {
    return await work;
  } finally {
    inFlightLaunch = null;
  }
}
