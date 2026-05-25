/**
 * MCP HTTP+SSE server.
 *
 * Binds `127.0.0.1:41541` (configurable via `MODELHUB_MCP_PORT` env var
 * for dev). Exposes two endpoints per the MCP spec:
 *   - GET  /sse          opens the event stream (caller → us)
 *   - POST /messages     JSON-RPC messages with `?sessionId=...`
 *
 * All requests require `Authorization: Bearer <token>`. The server
 * accepts TWO distinct tokens:
 *
 *  - the default ("user") token (always present, lazy created)
 *  - the admin token (present only if the user opted in by generating
 *    one from Settings)
 *
 * Both authenticate equally for non-privileged tools; the admin token
 * additionally unlocks tools marked `requiresAdmin: true` (destructive
 * or configuration-changing). When neither matches, the request is
 * rejected with HTTP 401. When the user token matches but the called
 * tool requires admin, the tool dispatcher returns an `isError: true`
 * MCP response with a short explanation (NOT HTTP 401 — the connection
 * itself is valid, only the specific tool is forbidden).
 *
 * Bind address is hard-pinned to loopback; we never serve `0.0.0.0`.
 *
 * Lifecycle: `start()` is idempotent; calling it twice on the same
 * port is a no-op. `stop()` closes the HTTP listener and tears down
 * active SSE sessions.
 */

import { timingSafeEqual } from 'crypto';
import { URL } from 'url';
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
import { getAdminToken, getOrCreateToken } from './token';

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
        description: t.requiresAdmin
          ? `[admin] ${t.description}`
          : t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Caller context for handlers — see `register` for the contract. We
  // build it per-request inside the Express handler below (it has
  // access to req/sessionId) and stash it on the transport; the call
  // handler reads it back via the `extra._ctx` shim.

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
      isAdmin: false,
    };
    // Admin-gate enforcement. We surface as a tool-level error (not
    // HTTP 401) so the caller's session stays alive — only the
    // privileged call is rejected.
    if (tool.requiresAdmin && !ctx.isAdmin) {
      const err = `forbidden: tool "${name}" requires the admin Bearer token`;
      void appendCallLog({
        caller: ctx.callerLabel,
        tool: name,
        args: req.params.arguments ?? {},
        durationMs: 0,
        ok: false,
        error: err,
      });
      return {
        isError: true,
        content: [{ type: 'text', text: err }],
      };
    }
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
  const userToken = await getOrCreateToken();
  const sessions = new Map<string, SSEServerTransport>();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Origin/Host guard — runs before auth. The server binds 127.0.0.1
  // so it can't be reached from the network, but a browser the user
  // visits in any tab can still POST to http://127.0.0.1:41541/messages
  // (CORS doesn't block writes from a regular form/fetch). Without an
  // Origin/Host check, a malicious page could brute-force tokens at
  // localhost speed. We:
  //   - accept requests with NO Origin header (CLI tools, curl, MCP
  //     clients that don't set one) — they aren't a browser.
  //   - accept Origin === null (file:// pages).
  //   - accept Origin from loopback hosts only.
  //   - reject the Host header if it doesn't match 127.0.0.1/localhost
  //     (defense against DNS rebinding attacks where the attacker
  //     points evil.com → 127.0.0.1 to bypass same-origin).
  const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        const hostname = new URL(origin).hostname;
        if (!ALLOWED_HOSTS.has(hostname)) {
          res.status(403).json({ error: 'forbidden origin' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'malformed origin' });
        return;
      }
    }
    const host = (req.headers.host ?? '').split(':')[0];
    if (host && !ALLOWED_HOSTS.has(host)) {
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    next();
  });

  // Rate-limit failed auth attempts to prevent brute-force from any
  // local process. Sliding window: 20 failed requests / 60s per remote
  // IP. The userToken has ~122 bits of entropy so brute force is
  // infeasible anyway, but this caps the noise + IO on a misconfigured
  // client and surfaces obvious attacks via the rejection log.
  const failedAttempts = new Map<string, number[]>(); // ip → timestamps
  const RATE_WINDOW_MS = 60_000;
  const RATE_LIMIT = 20;
  const recordFailure = (ip: string) => {
    const now = Date.now();
    const window = (failedAttempts.get(ip) ?? []).filter(
      (t) => now - t < RATE_WINDOW_MS,
    );
    window.push(now);
    failedAttempts.set(ip, window);
    return window.length;
  };
  const isThrottled = (ip: string) => {
    const window = failedAttempts.get(ip) ?? [];
    const now = Date.now();
    const fresh = window.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length !== window.length) failedAttempts.set(ip, fresh);
    return fresh.length >= RATE_LIMIT;
  };
  // Constant-time compare to remove the early-byte timing oracle. Falls
  // back to a length check first (timingSafeEqual requires equal-length
  // inputs). Uint8Array cast keeps TS happy across @types/node majors
  // where Buffer vs Uint8Array<ArrayBufferLike> drifted.
  const safeEqual = (a: string, b: string | undefined): boolean => {
    if (!b || a.length !== b.length) return false;
    const ab = new Uint8Array(Buffer.from(a, 'utf8'));
    const bb = new Uint8Array(Buffer.from(b, 'utf8'));
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  };

  // Auth middleware — runs after origin guard. SSE clients send the
  // Authorization header on the GET /sse upgrade; POST /messages
  // requires it too. The admin token is read on EVERY request (not
  // cached) so revoking it from Settings takes effect immediately
  // without a server restart.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (isThrottled(ip)) {
      res
        .status(429)
        .json({ error: 'too many failed auth attempts; back off' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
      recordFailure(ip);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const provided = match[1];
    const adminToken = await getAdminToken();
    if (safeEqual(provided, userToken)) {
      (req as any)._isAdmin = false;
      next();
      return;
    }
    if (adminToken && safeEqual(provided, adminToken)) {
      (req as any)._isAdmin = true;
      next();
      return;
    }
    recordFailure(ip);
    res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/sse', async (req: Request, res: Response) => {
    // SSEServerTransport opens the response stream + tracks the session.
    const transport = new SSEServerTransport('/messages', res);
    // Remember which tier this session authenticated as. Subsequent
    // POSTs validate the Bearer again (so revocation works) — this
    // field just lets us default the ctx.isAdmin when /messages is
    // dispatched before its own middleware finishes (race-free).
    (transport as any)._defaultIsAdmin = (req as any)._isAdmin === true;
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
    // handlers directly, so we stash on the transport.
    const isAdmin =
      (req as any)._isAdmin === true ||
      (transport as any)._defaultIsAdmin === true;
    const ctx: McpCallContext = {
      callerLabel: callerLabelFor(req, sessionId),
      isAdmin,
    };
    (transport as any)._ctx = ctx;
    await transport.handlePostMessage(req, res, req.body);
  });

  return new Promise((resolve, reject) => {
    const http = app.listen(port, HOST, () => {
      state = { http, port, sessions };
      console.log(
        `[modelhub-mcp] listening on http://${HOST}:${port}/sse (Bearer auth, two-tier)`,
      );
      resolve({ url: `http://${HOST}:${port}/sse`, token: userToken });
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
