/**
 * MCP HTTP+SSE server.
 *
 * Binds `127.0.0.1:41541` (configurable via `MODELHUB_MCP_PORT` env var
 * for dev). Exposes two endpoints per the MCP spec:
 *   - GET  /sse          opens the event stream (caller → us)
 *   - POST /messages     JSON-RPC messages with `?sessionId=...`
 *
 * All requests require `Authorization: Bearer <token>` — 401 otherwise.
 * Bind address is hard-pinned to loopback; we never serve `0.0.0.0`.
 *
 * The MCP `Server` instance is wired to our Tools Registry: `tools/list`
 * iterates registry, `tools/call` dispatches by name with the caller
 * context (carrying `callerLabel` for `launchedBy` annotation).
 *
 * Lifecycle: `start()` is idempotent; calling it twice on the same port
 * is a no-op. `stop()` closes the HTTP listener and tears down active
 * SSE sessions.
 */

import express, { Request, Response, NextFunction } from 'express';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server as HttpServer } from 'http';
import { appendCallLog } from './logger';
import { getTool, listTools, type McpCallContext } from './registry';
import { getOrCreateToken } from './token';

const DEFAULT_PORT = 41541;
const HOST = '127.0.0.1';

interface ServerState {
  http: HttpServer;
  port: number;
  sessions: Map<string, SSEServerTransport>;
}

let state: ServerState | undefined;

function getPort(): number {
  const envPort = process.env.MODELHUB_MCP_PORT;
  if (envPort) {
    const n = parseInt(envPort, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

/**
 * Derive a short caller label from the request. Falls back to a short
 * hash of the session id when we have nothing better. Used as
 * `launchedBy` when a `models.run` call originates from this caller.
 */
function callerLabelFor(req: Request, sessionId?: string): string {
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) {
    // Trim aggressively — UAs like "deer-flow/2.0 (Python/3.12 …)" become
    // just "deer-flow/2.0".
    const head = ua.split(/[\s(]/)[0];
    if (head) return `via MCP — ${head}`;
  }
  if (sessionId) return `via MCP — session ${sessionId.slice(0, 6)}`;
  return 'via MCP';
}

function buildMcpServer(): McpServer {
  const srv = new McpServer(
    { name: 'maestria-modelhub', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Caller context for handlers — see `register` for the contract. We
  // build it per-request inside the Express handler below (it has
  // access to req/sessionId) and stash it on the McpServer via a
  // request-scoped variable; the call handler reads it back.
  // Simpler: capture via closure in the dispatcher.

  srv.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const tool = getTool(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      };
    }
    // `extra.signal` is an AbortSignal we could thread to handlers; for
    // the v1 surface (sync-ish JSON-returning handlers) we don't pipe it.
    const ctx: McpCallContext = (extra as any)?._ctx ?? {
      callerLabel: 'via MCP',
    };
    const args = req.params.arguments ?? {};
    const startedAt = Date.now();
    try {
      const result = await tool.handler(args, ctx);
      void appendCallLog({
        caller: ctx.callerLabel,
        tool: name,
        args,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      const error = (e as Error).message ?? 'tool error';
      void appendCallLog({
        caller: ctx.callerLabel,
        tool: name,
        args,
        durationMs: Date.now() - startedAt,
        ok: false,
        error,
      });
      return {
        isError: true,
        content: [{ type: 'text', text: error }],
      };
    }
  });

  return srv;
}

export async function start(): Promise<{ url: string; token: string }> {
  if (state) {
    const token = await getOrCreateToken();
    return { url: `http://${HOST}:${state.port}/sse`, token };
  }

  const port = getPort();
  const token = await getOrCreateToken();
  const sessions = new Map<string, SSEServerTransport>();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Auth middleware — runs before any handler. SSE clients send the
  // Authorization header on the GET /sse upgrade; POST /messages
  // requires it too.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (header !== expected) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/sse', async (req: Request, res: Response) => {
    // SSEServerTransport opens the response stream + tracks the session.
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, transport);
    res.on('close', () => {
      sessions.delete(transport.sessionId);
    });
    const mcp = buildMcpServer();
    await mcp.connect(transport);
  });

  app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== 'string') {
      res.status(400).json({ error: 'missing sessionId' });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'unknown sessionId' });
      return;
    }
    // Attach the caller context for this request so the CallTool handler
    // can pick it up. The SDK doesn't surface request metadata to
    // handlers directly, so we monkey-patch onto the transport.
    const ctx: McpCallContext = {
      callerLabel: callerLabelFor(req, sessionId),
    };
    (transport as any)._ctx = ctx;
    await transport.handlePostMessage(req, res, req.body);
  });

  return new Promise((resolve, reject) => {
    const http = app.listen(port, HOST, () => {
      state = { http, port, sessions };
      console.log(
        `[modelhub-mcp] listening on http://${HOST}:${port}/sse (Bearer auth)`,
      );
      resolve({ url: `http://${HOST}:${port}/sse`, token });
    });
    http.on('error', (e) => {
      reject(e);
    });
  });
}

export async function stop(): Promise<void> {
  if (!state) return;
  const { http, sessions } = state;
  state = undefined;
  for (const t of sessions.values()) {
    try {
      await t.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
  await new Promise<void>((resolve) => {
    http.close(() => resolve());
  });
  console.log('[modelhub-mcp] stopped');
}

export function isRunning(): boolean {
  return !!state;
}

export function getStatus():
  | { running: false }
  | { running: true; url: string; port: number; sessions: number } {
  if (!state) return { running: false };
  return {
    running: true,
    url: `http://${HOST}:${state.port}/sse`,
    port: state.port,
    sessions: state.sessions.size,
  };
}
