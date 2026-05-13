/**
 * MCP smoke test — connects to the running TagSpaces MCP server, lists
 * tools, and optionally calls `models.list_running` to verify end-to-end.
 *
 * Usage:
 *   # With the server already running (TagSpaces launched + Settings ▸
 *   # AI ▸ MCP Server toggled on):
 *   npx tsx scripts/mcp-smoke.ts
 *
 *   # Or with explicit URL + token:
 *   MCP_URL=http://127.0.0.1:41541/sse MCP_TOKEN=... npx tsx scripts/mcp-smoke.ts
 *
 * The script reads the persisted token from the platform's Electron
 * userData dir (`modelhub-mcp.json`). If you ran TagSpaces but the file
 * isn't where this script expects (custom userData dir, different OS),
 * pass MCP_TOKEN as an env var.
 *
 * Exit code 0 on success, non-zero on any failure.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

interface TokenFile {
  version: 1;
  token: string;
  autoStart?: boolean;
}

function defaultUserDataDir(): string {
  // Electron stores app data under a platform-specific folder. We
  // mirror the default `app.getPath('userData')` lookup so the script
  // works without a running app.
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(
        process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
        'TagSpaces',
      );
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'TagSpaces');
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
        'TagSpaces',
      );
  }
}

function loadTokenFromDisk(): string | undefined {
  try {
    const raw = readFileSync(
      join(defaultUserDataDir(), 'modelhub-mcp.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as TokenFile;
    return parsed.token;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const url = process.env.MCP_URL ?? 'http://127.0.0.1:41541/sse';
  const token = process.env.MCP_TOKEN ?? loadTokenFromDisk();
  if (!token) {
    throw new Error(
      'No token. Set MCP_TOKEN env var or run TagSpaces once so the ' +
        'token file is created.',
    );
  }

  // The MCP SDK's SSEClientTransport doesn't expose a "set header"
  // method directly — we patch fetch options on the transport via the
  // `requestInit` and `eventSourceInit` options.
  const headers = { Authorization: `Bearer ${token}` };
  const transport = new SSEClientTransport(new URL(url), {
    requestInit: { headers },
    eventSourceInit: {
      // Polyfill needs to be passed through if not natively available;
      // recent Node has fetch built-in, so this just forwards headers.
      fetch: (input: any, init?: any) =>
        fetch(input, { ...(init ?? {}), headers }),
    },
  });

  const client = new Client(
    { name: 'modelhub-smoke', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  console.log(`✓ connected to ${url}`);

  const tools = await client.listTools();
  console.log(`✓ ${tools.tools.length} tool(s) exposed:`);
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}`);
  }

  console.log('\n› calling models.list_running …');
  const result = await client.callTool({
    name: 'models.list_running',
    arguments: {},
  });
  const content =
    (result.content as Array<{ type: string; text?: string }>) ?? [];
  for (const chunk of content) {
    if (chunk.type === 'text' && chunk.text) {
      console.log(chunk.text);
    }
  }

  await client.close();
  console.log('\n✓ smoke test passed');
}

main().catch((e) => {
  console.error('✗ smoke test failed:', (e as Error).message ?? e);
  process.exit(1);
});
