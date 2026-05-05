/**
 * Renderer hook to load a parsed model header via IPC.
 * Cached in-memory per filePath for the lifetime of the app session.
 */

import { useEffect, useRef, useState } from 'react';
import { HeaderMeta, MODELHUB_IPC } from './types';
import { isSupportedModelFile } from './parsers';

export interface UseModelHeaderState {
  loading: boolean;
  meta?: HeaderMeta;
  error?: string;
}

interface ParseHeaderResult {
  ok: boolean;
  meta?: HeaderMeta;
  error?: string;
}

const cache = new Map<string, HeaderMeta | { _error: string }>();
const inflight = new Map<string, Promise<ParseHeaderResult>>();

// `window.electronIO` is declared globally in `src/renderer/preload.d.ts`
// with the canonical ElectronHandler type. We narrow it locally for
// IPC invokes via a structural cast to keep the channel signature loose.
type IpcLite = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

async function callParseHeader(filePath: string): Promise<ParseHeaderResult> {
  const ipc = window.electronIO?.ipcRenderer as unknown as IpcLite | undefined;
  if (!ipc?.invoke) {
    return { ok: false, error: 'IPC not available (web build?)' };
  }
  const result = (await ipc.invoke(
    MODELHUB_IPC.parseHeader,
    filePath,
  )) as ParseHeaderResult;
  return result;
}

/**
 * Imperative API: parse a single file. Cached.
 * Useful from non-component code (e.g. bulk operations).
 */
export async function fetchModelHeader(
  filePath: string,
): Promise<HeaderMeta | undefined> {
  const cached = cache.get(filePath);
  if (cached) return '_error' in cached ? undefined : cached;
  if (!isSupportedModelFile(filePath)) {
    cache.set(filePath, { _error: 'unsupported format' });
    return undefined;
  }
  let promise = inflight.get(filePath);
  if (!promise) {
    promise = callParseHeader(filePath);
    inflight.set(filePath, promise);
  }
  try {
    const result = await promise;
    if (result.ok && result.meta) {
      cache.set(filePath, result.meta);
      return result.meta;
    }
    cache.set(filePath, { _error: result.error || 'unknown error' });
    return undefined;
  } finally {
    inflight.delete(filePath);
  }
}

/**
 * React hook: returns the parsed header for a file path. Re-fetches when path changes.
 * Reads from the in-memory cache when available.
 */
export function useModelHeader(filePath?: string): UseModelHeaderState {
  const [state, setState] = useState<UseModelHeaderState>(() => {
    if (!filePath) return { loading: false };
    const cached = cache.get(filePath);
    if (cached) {
      return '_error' in cached
        ? { loading: false, error: cached._error }
        : { loading: false, meta: cached };
    }
    return { loading: true };
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!filePath) {
      setState({ loading: false });
      return () => {
        aliveRef.current = false;
      };
    }

    const cached = cache.get(filePath);
    if (cached) {
      setState(
        '_error' in cached
          ? { loading: false, error: cached._error }
          : { loading: false, meta: cached },
      );
      return () => {
        aliveRef.current = false;
      };
    }

    if (!isSupportedModelFile(filePath)) {
      cache.set(filePath, { _error: 'unsupported format' });
      setState({ loading: false, error: 'unsupported format' });
      return () => {
        aliveRef.current = false;
      };
    }

    setState({ loading: true });
    let promise = inflight.get(filePath);
    if (!promise) {
      promise = callParseHeader(filePath);
      inflight.set(filePath, promise);
    }
    promise
      .then((result) => {
        inflight.delete(filePath);
        if (!aliveRef.current) return;
        if (result.ok && result.meta) {
          cache.set(filePath, result.meta);
          setState({ loading: false, meta: result.meta });
        } else {
          const err = result.error || 'parse failed';
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

    return () => {
      aliveRef.current = false;
    };
  }, [filePath]);

  return state;
}

/** Test-only: clear in-memory cache. */
export function _clearModelHeaderCache(): void {
  cache.clear();
  inflight.clear();
}
