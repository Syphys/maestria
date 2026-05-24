/**
 * Configuration-mutation MCP tools. Read sides are unrestricted;
 * writes are admin-gated because they affect every subsequent routing
 * decision / autotune result (and persist across restarts).
 *
 *  - `hardware.detect_raw` — raw probe, no user override applied.
 *  - `hardware.get_override` — persisted manual override fields.
 *  - `hardware.set_override` — ADMIN — writes the override (drives
 *    autotune system-wide).
 *  - `routing.get_config` — read memory reserves + embedder + thetaQ.
 *  - `routing.set_config` — ADMIN — writes the routing config.
 */

import { detectRawHardwareProfile } from '../../hardware';
import {
  getOverride as getHardwareOverride,
  setOverride as setHardwareOverride,
  type HardwareOverride,
} from '../../hardwareOverride';
import {
  effectiveRoutingParams,
  getRoutingConfig,
  setRoutingConfig,
  type RoutingConfig,
} from '../../routingConfig';
import { register } from '../registry';

register({
  name: 'hardware.detect_raw',
  description:
    'Return the raw `HardwareProfile` from platform detection — no ' +
    'manual override applied. Use this when you want to see what the ' +
    'OS thinks regardless of what the user typed into Settings (the ' +
    'Settings UI uses the same call to render "Detected: …" next to ' +
    'the editable override fields).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    return await detectRawHardwareProfile();
  },
});

register({
  name: 'hardware.get_override',
  description:
    'Return the persisted manual `HardwareOverride` (any subset of ' +
    '`ramBytes` / `freeRamBytes` / `gpu.vramBytes` / `cpu.cores` / ' +
    '…). Returns `{}` when nothing has been overridden.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    return await getHardwareOverride();
  },
});

register({
  name: 'hardware.set_override',
  description:
    'Persist a manual `HardwareOverride`. Passing `{}` clears every ' +
    'field (back to pure detection). Drives autotune for every ' +
    'subsequent launch. ADMIN-GATED — a bad override (e.g. pretending ' +
    'you have 64 GB VRAM when you have 8) breaks every launch.',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      override: {
        type: 'object',
        description: 'HardwareOverride object. Pass {} to clear.',
        additionalProperties: true,
      },
    },
    required: ['override'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { override?: unknown };
    if (
      typeof a.override !== 'object' ||
      a.override === null ||
      Array.isArray(a.override)
    ) {
      throw new Error('override is required and must be an object');
    }
    await setHardwareOverride(a.override as HardwareOverride);
    return { ok: true, override: await getHardwareOverride() };
  },
});

register({
  name: 'routing.get_config',
  description:
    'Return the persisted `RoutingConfig` — memory reserves (vramMb / ' +
    'ramMb), routing embedder config (managed | external | none), ' +
    'thetaQ + embedding-reliability gate threshold. Also returns the ' +
    '`effective` derived shape (defaults filled in) so the caller ' +
    "doesn't have to mirror our default constants.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const raw = await getRoutingConfig();
    const effective = effectiveRoutingParams(raw);
    return { raw, effective };
  },
});

register({
  name: 'routing.set_config',
  description:
    'Persist a new `RoutingConfig`. Pass `{}` to reset to defaults. ' +
    'Drives `models.route` for every subsequent query. ADMIN-GATED — ' +
    'pointing the embedder at the wrong URL silently downgrades every ' +
    'routing decision to R5 fallback.',
  requiresAdmin: true,
  inputSchema: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        description: 'RoutingConfig object. Pass {} to reset.',
        additionalProperties: true,
      },
    },
    required: ['config'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { config?: unknown };
    if (
      typeof a.config !== 'object' ||
      a.config === null ||
      Array.isArray(a.config)
    ) {
      throw new Error('config is required and must be an object');
    }
    await setRoutingConfig(a.config as RoutingConfig);
    return { ok: true, raw: await getRoutingConfig() };
  },
});
