/**
 * Renderer hook: load a model's behavioral `signature` block via IPC.
 *
 * Mirrors `useModelHeader` / `useModelMeta`: an in-memory cache keyed by
 * absolute path + an inflight-promise map so the same file requested by
 * many grid cells (tile mini-radar) hits the disk once. The signature is
 * a separate top-level sidecar key (not part of `modelMeta`), so it needs
 * its own accessor — see DECISIONS.md D7 / spec R9.8.
 *
 * `signature` is `null` (not an error) until the model is characterized.
 */

import { useEffect, useRef, useState } from 'react';
import { MODELHUB_IPC } from './types';
import { isSupportedModelFile } from './parsers';
import type { Signature } from '../../shared/RoutingTypes';

export interface UseSignatureState {
  loading: boolean;
  /** `null` when the model has no signature yet; `undefined` while loading. */
  signature?: Signature | null;
  error?: string;
}

interface LoadSignatureResult {
  ok: boolean;
  signature?: Signature | null;
  error?: string;
}

type CacheVal = { sig: Signature | null } | { _error: string };
const cache = new Map<string, CacheVal>();
const inflight = new Map<string, Promise<LoadSignatureResult>>();

type IpcLite = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

async function callLoadSignature(
  filePath: string,
): Promise<LoadSignatureResult> {
  const ipc = window.electronIO?.ipcRenderer as unknown as IpcLite | undefined;
  if (!ipc?.invoke) {
    return { ok: false, error: 'IPC not available (web build?)' };
  }
  return (await ipc.invoke(
    MODELHUB_IPC.loadSignature,
    filePath,
  )) as LoadSignatureResult;
}

function stateFromCache(v: CacheVal): UseSignatureState {
  return '_error' in v
    ? { loading: false, error: v._error }
    : { loading: false, signature: v.sig };
}

/**
 * Imperative API: get the model's signature. Cached. Returns `null` when the
 * model exists but isn't characterized; `undefined` on error/unsupported.
 */
export async function fetchSignature(
  filePath: string,
): Promise<Signature | null | undefined> {
  const cached = cache.get(filePath);
  if (cached) return '_error' in cached ? undefined : cached.sig;
  if (!isSupportedModelFile(filePath)) {
    cache.set(filePath, { _error: 'unsupported format' });
    return undefined;
  }
  let promise = inflight.get(filePath);
  if (!promise) {
    promise = callLoadSignature(filePath);
    inflight.set(filePath, promise);
  }
  try {
    const result = await promise;
    if (result.ok) {
      const sig = result.signature ?? null;
      cache.set(filePath, { sig });
      return sig;
    }
    cache.set(filePath, { _error: result.error || 'unknown error' });
    return undefined;
  } finally {
    inflight.delete(filePath);
  }
}

/**
 * React hook: the model's signature for `filePath`, reactive on path change.
 * `enabled === false` short-circuits the fetch (e.g. tile not yet visible /
 * not a model file) so grid scrolling never floods IPC.
 */
export function useSignature(
  filePath?: string,
  enabled = true,
): UseSignatureState {
  const [state, setState] = useState<UseSignatureState>(() => {
    if (!filePath || !enabled) return { loading: false };
    const cached = cache.get(filePath);
    return cached ? stateFromCache(cached) : { loading: true };
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const done = () => {
      aliveRef.current = false;
    };

    if (!filePath || !enabled) {
      setState({ loading: false });
      return done;
    }

    const cached = cache.get(filePath);
    if (cached) {
      setState(stateFromCache(cached));
      return done;
    }

    if (!isSupportedModelFile(filePath)) {
      cache.set(filePath, { _error: 'unsupported format' });
      setState({ loading: false, error: 'unsupported format' });
      return done;
    }

    setState({ loading: true });
    let promise = inflight.get(filePath);
    if (!promise) {
      promise = callLoadSignature(filePath);
      inflight.set(filePath, promise);
    }
    promise
      .then((result) => {
        inflight.delete(filePath);
        if (!aliveRef.current) return;
        if (result.ok) {
          const sig = result.signature ?? null;
          cache.set(filePath, { sig });
          setState({ loading: false, signature: sig });
        } else {
          const err = result.error || 'load failed';
          cache.set(filePath, { _error: err });
          setState({ loading: false, error: err });
        }
      })
      .catch((e: unknown) => {
        inflight.delete(filePath);
        if (!aliveRef.current) return;
        const err = (e as Error).message || 'IPC failed';
        cache.set(filePath, { _error: err });
        setState({ loading: false, error: err });
      });

    return done;
  }, [filePath, enabled]);

  return state;
}

/** Test-only: clear the in-memory cache. */
export function _clearSignatureCache(): void {
  cache.clear();
  inflight.clear();
}
