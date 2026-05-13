/**
 * Pure helpers for runner selection. Lives in its own file so the main
 * process can import `pickRunnerFor` without dragging the React hooks
 * from `useRunners.ts` into the main bundle.
 */

import { RunnerConfig } from '../types';

/**
 * Pick the best runner for a given model file:
 *  1. filter by file-format compatibility (capabilities.gguf vs safetensors)
 *  2. sort by `priority` ascending (lowest priority value wins; undefined → 99)
 *  3. return the first match, or undefined when no candidate qualifies
 *
 * No side effects, no IPC. Safe to call from anywhere.
 */
export function pickRunnerFor(
  runners: RunnerConfig[],
  filePath: string,
): RunnerConfig | undefined {
  const lower = filePath.toLowerCase();
  const wantGguf = lower.endsWith('.gguf');
  const wantSafetensors = lower.endsWith('.safetensors');
  const candidates = runners.filter((r) => {
    if (wantGguf) return r.capabilities.gguf;
    if (wantSafetensors) return r.capabilities.safetensors;
    return false;
  });
  candidates.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return candidates[0];
}
