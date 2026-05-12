/**
 * Mock source of currently-running agent instances.
 *
 * Returns a fixed sample that exercises the visualisation:
 *   - 3-level deep parent/child chain (recursive `agents.run`)
 *   - Multiple statuses (running, error, done)
 *   - Standalone (top-level) agents alongside parented ones
 *
 * To be replaced (Phase 4.3) by:
 *   - IPC poll of `~/.tagspaces/agents/active-pids.json` reconciled with
 *     live PID liveness checks
 *   - Push events from the main-process agent launcher
 *
 * Shape matches the final `AgentRunningState` so the panel doesn't need
 * to change when the real data lands.
 */

import { useMemo } from 'react';
import { AgentRunningState } from '../types';

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

// Mock scenario : a deer-flow lead agent running a multi-hour
// codebase-improvement task (model = GLM-5.1), spawning its own
// sub-agents through `agents.run`. The shape is what TagSpaces will
// actually see when deer-flow drives our MCP server in anger.
const MOCK_AGENTS: AgentRunningState[] = [
  {
    agentInstanceId: 'agt-001',
    agentConfigId: 'agent-deer-flow',
    name: 'deer-flow',
    pid: 99001,
    uiUrl: 'http://127.0.0.1:8001',
    task: 'Audit src/ for refactor opportunities, benchmark before/after, document changes',
    startedAt: ago(42 * 60),
    status: 'running',
  },
  {
    agentInstanceId: 'agt-002',
    agentConfigId: 'agent-aider',
    name: 'aider',
    pid: 99002,
    task: 'Extract pure helpers from src/utils — split io.ts',
    startedAt: ago(18 * 60),
    parentAgentInstanceId: 'agt-001',
    status: 'running',
  },
  {
    agentInstanceId: 'agt-003',
    agentConfigId: 'agent-docs',
    name: 'docs-agent',
    pid: 99003,
    task: 'Write JSDoc for the new helpers',
    startedAt: ago(90),
    parentAgentInstanceId: 'agt-002',
    status: 'running',
  },
  {
    agentInstanceId: 'agt-004',
    agentConfigId: 'agent-bench',
    name: 'bench-runner',
    task: 'Run vitest --bench against main and the refactor branch',
    startedAt: ago(6 * 60),
    parentAgentInstanceId: 'agt-001',
    status: 'error',
  },
  {
    agentInstanceId: 'agt-005',
    agentConfigId: 'agent-open-webui',
    name: 'Open WebUI session',
    uiUrl: 'http://127.0.0.1:3000',
    startedAt: ago(2 * 60 * 60),
    status: 'running',
  },
  {
    agentInstanceId: 'agt-006',
    agentConfigId: 'agent-tests',
    name: 'tests-runner',
    task: 'jest --watch (finished after 12 retries)',
    startedAt: ago(35 * 60),
    status: 'done',
  },
];

export interface UseRunningAgentsResult {
  agents: AgentRunningState[];
  loading: boolean;
  /** Stub — would refetch the IPC source in the real version. */
  refresh: () => void;
}

export function useRunningAgents(): UseRunningAgentsResult {
  return useMemo(
    () => ({
      agents: MOCK_AGENTS,
      loading: false,
      refresh: () => {
        // mock no-op
      },
    }),
    [],
  );
}
