/**
 * Renderer hook for the routing config (Settings ▸ AI ▸ Routing).
 *
 * Backs the two memory-reserve fields the deterministic router's live
 * free-memory probe (D8.2) subtracts before deciding what fits. Mirrors
 * the minimal `useHardware` shape — single fetch on mount, explicit
 * save (no polling: the value only changes when the user edits it).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODELHUB_IPC, RoutingConfig } from './types';

/** Defaults mirrored from `src/main/modelhub/routingConfig.ts`. */
export const DEFAULT_VRAM_RESERVE_BYTES = 1 * 1024 ** 3;
export const DEFAULT_RAM_RESERVE_BYTES = 2 * 1024 ** 3;

function ipcInvoke<T = unknown>(
  channel: string,
  ...args: unknown[]
): Promise<T | undefined> {
  const r = window?.electronIO?.ipcRenderer as
    | { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
    | undefined;
  if (!r) return Promise.resolve(undefined);
  return r.invoke(channel, ...args) as Promise<T>;
}

export async function getRoutingConfig(): Promise<RoutingConfig> {
  try {
    const r = await ipcInvoke<{ ok: boolean; config?: RoutingConfig }>(
      MODELHUB_IPC.getRoutingConfig,
    );
    return r?.config ?? {};
  } catch {
    return {};
  }
}

export async function setRoutingConfig(config: RoutingConfig): Promise<void> {
  const r = await ipcInvoke<{ ok: boolean; error?: string }>(
    MODELHUB_IPC.setRoutingConfig,
    config,
  );
  if (r && !r.ok) throw new Error(r.error ?? 'set failed');
}

export interface UseRoutingConfigState {
  config: RoutingConfig;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  /** Persist (empty object resets every field to its default). */
  save: (next: RoutingConfig) => Promise<void>;
}

export function useRoutingConfig(): UseRoutingConfigState {
  const [config, setConfig] = useState<RoutingConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const c = await getRoutingConfig();
      if (aliveRef.current) setConfig(c);
    } catch (e) {
      if (aliveRef.current) setError((e as Error).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  const save = useCallback(
    async (next: RoutingConfig) => {
      setError(undefined);
      try {
        await setRoutingConfig(next);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  return { config, loading, error, refresh, save };
}
