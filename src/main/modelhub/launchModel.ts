/**
 * One-call launch pipeline used by both the IPC handler (renderer's
 * "Run" button) and the MCP `models.run` tool.
 *
 * Steps:
 *   1. Resolve to the canonical shard so a non-shard-1 path still works
 *   2. Load the sidecar (for `userRunParams` overrides) — best-effort
 *   3. Parse the header if it isn't cached yet
 *   4. Detect hardware
 *   5. Autotune launch params (user override merged on top)
 *   6. Pick the best installed llama.cpp binary for the file format
 *   7. Build the command
 *   8. Spawn it with `launchedBy` annotation
 *
 * The renderer used to do steps 1-7 in pieces across multiple IPC
 * round-trips. Both call sites now share this single function so the
 * MCP path matches the in-app path exactly.
 */

import { detectHardwareProfile } from './hardware';
import { readModelHeader } from './parseHeader';
import { autotune } from './runners/autotune';
import { buildCommand } from './runners/command';
import { launchProcess } from './runners/launch';
import { listRunners } from './runners/registry';
import { loadModelMeta } from './sidecar';
import { resolveCanonicalShardPath } from './shardFs';
import type {
  LaunchResult,
  RunParams,
  RunnerConfig,
} from '../../renderer/modelhub/types';
import { pickRunnerFor } from '../../renderer/modelhub/runners/pick';

export interface LaunchModelOptions {
  /**
   * Provenance label propagated to `ActiveEntry.launchedBy`. Undefined
   * for user-initiated launches (renderer Run button); set to the MCP
   * caller's `callerLabel` when the launch originated from a tool call.
   */
  launchedBy?: string;
  /** Optional ceiling for the bound HTTP port. */
  port?: number;
}

export interface LaunchModelResult extends LaunchResult {
  /** The runner that was chosen by `pickRunnerFor`. Useful for logs. */
  runner?: RunnerConfig;
  /** Effective params used (autotune merged with user override). */
  params?: RunParams;
  warnings?: string[];
}

export async function launchModelByPath(
  filePath: string,
  options: LaunchModelOptions = {},
): Promise<LaunchModelResult> {
  const canonical = await resolveCanonicalShardPath(filePath);
  const fileBasename = canonical.replace(/^.*[\\/]/, '');

  // Best-effort sidecar load. Missing meta is fine — autotune copes.
  const meta = await loadModelMeta(canonical).catch(() => undefined);

  let header = meta?.header;
  if (!header) {
    const parsed = await readModelHeader(canonical);
    if (parsed.ok && parsed.meta) header = parsed.meta;
  }

  const hardware = await detectHardwareProfile();
  const estimated = autotune({ header, hardware, port: options.port });
  const userOverride = meta?.userRunParams;
  const params: RunParams = userOverride
    ? { ...estimated, ...userOverride }
    : estimated;

  const runners = await listRunners();
  const runner = pickRunnerFor(runners, canonical, meta);
  if (!runner) {
    return {
      ok: false,
      params,
      error:
        'No llama.cpp binary configured — open the Configure runners dialog first.',
    };
  }

  const built = buildCommand(runner, canonical, params);
  const result = launchProcess(built.command, {
    url: built.url,
    runnerLabel: runner.label,
    modelName: fileBasename,
    launchedBy: options.launchedBy,
  });

  return {
    ...result,
    runner,
    params,
    warnings: built.warnings,
  };
}
