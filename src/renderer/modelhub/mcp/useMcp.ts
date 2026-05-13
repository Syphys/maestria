/**
 * Renderer hook for the MCP server controls.
 *
 * Surfaces the same operations as the underlying IPC channels but with
 * React-friendly state (`status` / `token` / `autoStart` / `loading` /
 * `error`). Components that only need to render the URL or react to
 * server status can pull from here without re-implementing the IPC
 * round-trip.
 *
 * The server doesn't push events; this hook polls every 5s while
 * mounted so a server that died externally (port conflict, etc.) is
 * reflected within a few seconds. Cheap — the IPC handler just reads
 * an in-memory flag.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { McpStatus, McpToolInfo, MODELHUB_IPC } from '../types';

const POLL_INTERVAL_MS = 5000;

function ipc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const r = window.electronIO?.ipcRenderer as
    | { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
    | undefined;
  if (!r) return Promise.reject(new Error('ipcRenderer unavailable'));
  return r.invoke(channel, ...args) as Promise<T>;
}

export async function getStatus(): Promise<McpStatus> {
  const r = await ipc<{ ok: boolean; status: McpStatus }>(
    MODELHUB_IPC.mcpStatus,
  );
  return r.status ?? { running: false };
}

export async function startServer(): Promise<{ url: string; token: string }> {
  const r = await ipc<{
    ok: boolean;
    url?: string;
    token?: string;
    error?: string;
  }>(MODELHUB_IPC.mcpStart);
  if (!r.ok || !r.url || !r.token) throw new Error(r.error ?? 'start failed');
  return { url: r.url, token: r.token };
}

export async function stopServer(): Promise<void> {
  const r = await ipc<{ ok: boolean; error?: string }>(MODELHUB_IPC.mcpStop);
  if (!r.ok) throw new Error(r.error ?? 'stop failed');
}

export async function getToken(): Promise<string> {
  const r = await ipc<{ ok: boolean; token?: string; error?: string }>(
    MODELHUB_IPC.mcpGetToken,
  );
  if (!r.ok || !r.token) throw new Error(r.error ?? 'token fetch failed');
  return r.token;
}

export async function regenerateToken(): Promise<string> {
  const r = await ipc<{ ok: boolean; token?: string; error?: string }>(
    MODELHUB_IPC.mcpRegenerateToken,
  );
  if (!r.ok || !r.token) throw new Error(r.error ?? 'regenerate failed');
  return r.token;
}

export async function listTools(): Promise<McpToolInfo[]> {
  const r = await ipc<{ ok: boolean; tools?: McpToolInfo[] }>(
    MODELHUB_IPC.mcpListTools,
  );
  return r.tools ?? [];
}

export async function getAutoStart(): Promise<boolean> {
  const r = await ipc<{ ok: boolean; autoStart?: boolean }>(
    MODELHUB_IPC.mcpGetAutoStart,
  );
  return !!r.autoStart;
}

export async function setAutoStart(enabled: boolean): Promise<void> {
  const r = await ipc<{ ok: boolean; error?: string }>(
    MODELHUB_IPC.mcpSetAutoStart,
    enabled,
  );
  if (!r.ok) throw new Error(r.error ?? 'set failed');
}

export interface UseMcpState {
  status: McpStatus;
  token: string;
  autoStart: boolean;
  tools: McpToolInfo[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  regenerate: () => Promise<void>;
  setAutoStart: (enabled: boolean) => Promise<void>;
}

export function useMcp(): UseMcpState {
  const [status, setStatus] = useState<McpStatus>({ running: false });
  const [token, setToken] = useState<string>('');
  const [autoStart, setAutoStartState] = useState<boolean>(false);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>();
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [s, t, a, tl] = await Promise.all([
        getStatus(),
        getToken(),
        getAutoStart(),
        listTools(),
      ]);
      if (!aliveRef.current) return;
      setStatus(s);
      setToken(t);
      setAutoStartState(a);
      setTools(tl);
      setError(undefined);
    } catch (e) {
      if (!aliveRef.current) return;
      setError((e as Error).message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  const start = useCallback(async () => {
    setError(undefined);
    try {
      await startServer();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refresh]);

  const stop = useCallback(async () => {
    setError(undefined);
    try {
      await stopServer();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refresh]);

  const regenerate = useCallback(async () => {
    setError(undefined);
    try {
      const t = await regenerateToken();
      setToken(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const setAutoStartCb = useCallback(
    async (enabled: boolean) => {
      setError(undefined);
      try {
        await setAutoStart(enabled);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  return {
    status,
    token,
    autoStart,
    tools,
    loading,
    error,
    refresh,
    start,
    stop,
    regenerate,
    setAutoStart: setAutoStartCb,
  };
}

/**
 * Build the JSON config snippet for Claude Desktop's `mcpServers` block.
 * Returns the inner object only; the caller wraps it in
 * `{ "mcpServers": { "tagspaces": <this> } }` when displaying.
 */
export function buildClaudeDesktopConfig(
  url: string,
  tokenValue: string,
): string {
  const cfg = {
    mcpServers: {
      tagspaces: {
        // MCP spec canonical key is `type`, not `transport`. Clients
        // (Claude Desktop, Cursor, claude.json) silently skip the
        // entry when the key is wrong — server responds 200 but no
        // tools register.
        type: 'sse',
        url,
        headers: {
          Authorization: `Bearer ${tokenValue}`,
        },
      },
    },
  };
  return JSON.stringify(cfg, null, 2);
}
