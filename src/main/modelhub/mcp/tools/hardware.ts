/**
 * `hardware.*` MCP tools.
 *
 * Two read-only probes:
 *  - `hardware.detect` returns the current `HardwareProfile` (RAM, CPU,
 *    optional GPU). GPU detection is still a stub on most platforms —
 *    Phase 4.0.10 will fill it in, this tool will then automatically
 *    surface the richer profile.
 *  - `hardware.autotune` returns the launch params we'd use for a given
 *    model, given the current hardware. Useful for an MCP caller to
 *    preview the autotune before deciding to `models.run`.
 */

import { detectHardwareProfile } from '../../hardware';
import { readModelHeader } from '../../parseHeader';
import { autotune } from '../../runners/autotune';
import { loadModelMeta } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';

register({
  name: 'hardware.detect',
  description:
    'Return the detected hardware profile: total RAM, free RAM, CPU ' +
    'model + logical core count, optional GPU (vendor / name / VRAM). ' +
    'GPU detection is currently a stub on most platforms — fields can ' +
    'be undefined.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    return await detectHardwareProfile();
  },
});

register({
  name: 'hardware.autotune',
  description:
    'Compute the launch parameters we would use for the given model ' +
    'on the current hardware: ngl (GPU layers), ctx (context size), ' +
    'threads, batchSize, mlock / flashAttn flags, suggested port. ' +
    'Returns the rationale array explaining each choice — useful to ' +
    'show the caller why a specific value was picked. Does NOT spawn ' +
    'anything; this is preview-only.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the model file.' },
      port: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description: 'Optional HTTP port. Default 8080.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; port?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const port = typeof a.port === 'number' ? a.port : undefined;

    const canonical = await resolveCanonicalShardPath(a.path);
    const meta = await loadModelMeta(canonical).catch(() => undefined);
    let header = meta?.header;
    if (!header) {
      const parsed = await readModelHeader(canonical);
      if (parsed.ok && parsed.meta) header = parsed.meta;
    }
    const hardware = await detectHardwareProfile();
    const estimated = autotune({ header, hardware, port });
    return {
      params: estimated,
      hasUserOverride: !!meta?.userRunParams,
    };
  },
});
