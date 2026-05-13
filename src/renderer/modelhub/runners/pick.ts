/**
 * Pure helpers for runner selection. Lives in its own file so the main
 * process can import `pickRunnerFor` without dragging the React hooks
 * from `useRunners.ts` into the main bundle.
 */

import { RunnerConfig } from '../types';

/** Subset of `ModelMeta` consulted here. Loose typing to avoid pulling
 * the whole sidecar shape into this dependency-light module. */
export interface RunnerPickHints {
  preferredRunnerId?: string;
}

/**
 * Pick the best runner for a given model file:
 *  1. honour `meta.preferredRunnerId` when it points at an installed runner
 *     that can handle the file format
 *  2. filter by file-format compatibility (capabilities.gguf vs safetensors)
 *  3. sort by `priority` ascending (lowest priority value wins; undefined → 99)
 *  4. return the first match, or undefined when no candidate qualifies
 *
 * Stale `preferredRunnerId` (runner since removed) silently falls through
 * to the priority sort so the user can still launch.
 *
 * No side effects, no IPC. Safe to call from anywhere.
 */
export function pickRunnerFor(
  runners: RunnerConfig[],
  filePath: string,
  meta?: RunnerPickHints,
): RunnerConfig | undefined {
  const lower = filePath.toLowerCase();
  const wantGguf = lower.endsWith('.gguf');
  const wantSafetensors = lower.endsWith('.safetensors');

  if (meta?.preferredRunnerId) {
    const preferred = runners.find((r) => r.id === meta.preferredRunnerId);
    if (preferred) {
      const fits =
        (wantGguf && preferred.capabilities.gguf) ||
        (wantSafetensors && preferred.capabilities.safetensors);
      if (fits) return preferred;
    }
  }

  const candidates = runners.filter((r) => {
    if (wantGguf) return r.capabilities.gguf;
    if (wantSafetensors) return r.capabilities.safetensors;
    return false;
  });
  candidates.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  return candidates[0];
}
