/**
 * Hook that returns the user's **single** configured main agent.
 *
 * The Models Hub fork settled on a single-agent model (no in-app
 * catalog of agent kinds): the user picks one runtime (deer-flow,
 * aider, custom…), configures it once, and TagSpaces spawns fresh
 * instances of it via `agents.run` with different models / tasks.
 * That's the MoE-on-local-models pattern.
 *
 * Currently a mock returning a deer-flow config so the UI prototype
 * shows a realistic state. To be replaced (Phase 4.4) by an IPC read
 * of the persisted settings — same shape, just real storage.
 */

import { useMemo } from 'react';
import { AgentConfig } from '../types';

const MOCK_MAIN_AGENT: AgentConfig = {
  id: 'agent-main',
  name: 'deer-flow',
  description:
    'ByteDance long-horizon SuperAgent: plans, spawns sub-agents, codes, researches, creates. Sandboxes + memory + skills. Pairs ideally with GLM-5.1 for 8h+ autonomous sessions.',
  command: 'D:/agents/deer-flow/venv/Scripts/python.exe',
  args: [
    'D:/agents/deer-flow/main.py',
    '--api-base',
    '${MODEL_URL}',
    '--mcp-url',
    '${MCP_URL}',
    '--mcp-token',
    '${MCP_TOKEN}',
    '--port',
    '${PORT}',
    '--task',
    '${TASK}',
  ],
  env: { OPENAI_API_KEY: 'sk-no-auth' },
  uiUrl: 'http://127.0.0.1:${PORT}',
  readiness: {
    type: 'httpGet',
    url: 'http://127.0.0.1:${PORT}/health',
    timeoutSec: 30,
  },
};

export interface UseMainAgentResult {
  /** The configured main agent, or undefined when the user hasn't set one up yet. */
  agent: AgentConfig | undefined;
  /** True while the (eventual) IPC fetch is in flight. Always false for mock. */
  loading: boolean;
}

export function useMainAgent(): UseMainAgentResult {
  return useMemo(() => ({ agent: MOCK_MAIN_AGENT, loading: false }), []);
}
