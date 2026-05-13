/**
 * Models Hub MCP Tools Registry.
 *
 * Single source of truth for the tools the MCP server exposes. Each
 * domain module (models, tags, description, hf, hardware) self-registers
 * its tools at module load via `register(ToolDefinition)`. The server
 * iterates the registry to answer `tools/list` and dispatches
 * `tools/call` by name.
 *
 * The handler receives an `McpCallContext` carrying:
 *  - `callerLabel`: short string derived from the caller's session, used
 *    as `launchedBy` when a handler launches a model. Lets the UI group
 *    `RunningModelsPanel` entries by provenance ("Direct" vs "via MCP —
 *    deer-flow session 7f3a").
 *
 * Validation is intentionally light: we trust handlers to type-check
 * their own inputs. The `inputSchema` is published verbatim to the MCP
 * client so the LLM caller knows what shape to send.
 */

import type { JSONSchema7 } from 'json-schema';

export interface McpCallContext {
  /** Short label derived from the caller's MCP session (token / User-Agent). */
  callerLabel: string;
}

export interface ToolDefinition {
  /** Namespaced name, e.g. `models.search`. */
  name: string;
  /** One-paragraph description aimed at the LLM caller. */
  description: string;
  /** JSON-Schema for the tool arguments. */
  inputSchema: JSONSchema7;
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
