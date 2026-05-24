/**
 * Models Hub MCP Tools Registry.
 *
 * Single source of truth for the tools the MCP server exposes. Each
 * domain module (models, characterize, logs, meta, discovery, runners,
 * configs, tags, description, hardware, route) self-registers its tools
 * at module load via `register(ToolDefinition)`. The server iterates
 * the registry to answer `tools/list` and dispatches `tools/call` by
 * name.
 *
 * The handler receives an `McpCallContext` carrying:
 *  - `callerLabel`: short string derived from the caller's session, used
 *    as `launchedBy` when a handler launches a model. Lets the UI group
 *    `RunningModelsPanel` entries by provenance ("Direct" vs "via MCP —
 *    deer-flow session 7f3a").
 *  - `isAdmin`: true when the caller authenticated with the admin
 *    Bearer token (a separate token from the default one). Destructive
 *    or configuration-changing tools set `requiresAdmin: true` and the
 *    server short-circuits with 403 when this is false.
 *
 * Validation is intentionally light: we trust handlers to type-check
 * their own inputs. The `inputSchema` is published verbatim to the MCP
 * client so the LLM caller knows what shape to send.
 */

import type { JSONSchema7 } from 'json-schema';

export interface McpCallContext {
  /** Short label derived from the caller's MCP session (token / User-Agent). */
  callerLabel: string;
  /**
   * True when the caller authenticated with the admin Bearer token. The
   * default (user) token sets this to false. Tools that opt into
   * `requiresAdmin: true` are rejected with 403 when this is false.
   */
  isAdmin: boolean;
}

export interface ToolDefinition {
  /** Namespaced name, e.g. `models.search`. */
  name: string;
  /** One-paragraph description aimed at the LLM caller. */
  description: string;
  /** JSON-Schema for the tool arguments. */
  inputSchema: JSONSchema7;
  /**
   * When true, the server requires the admin Bearer token to dispatch
   * this tool. Defaults to false. Use for destructive operations
   * (`meta.clear_folder`, `runners.save`, …) or configuration mutators
   * (`hardware.set_override`, `routing.set_config`). Read-only and
   * non-destructive tools should leave this unset.
   */
  requiresAdmin?: boolean;
  /** Handler — gets args verbatim from the client, returns arbitrary JSON. */
  handler: (args: unknown, ctx: McpCallContext) => Promise<unknown>;
}

const tools = new Map<string, ToolDefinition>();

export function register(def: ToolDefinition): void {
  if (tools.has(def.name)) {
    // Two modules registering the same name is a bug — surface it loudly.
    throw new Error(`MCP tool already registered: ${def.name}`);
  }
  tools.set(def.name, def);
}

export function listTools(): ToolDefinition[] {
  return Array.from(tools.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

/** Test-only: wipe the registry. Never call from production code. */
export function _resetForTests(): void {
  tools.clear();
}
