/**
 * `models.route` MCP tool — the Slice 6 router, wired.
 *
 * Given a free-text query and a directory of models, returns which
 * characterized model is the best fit: it classifies the query into
 * competence-axis weights (deterministic, embedding-free — DECISIONS.md
 * D3), matches them against each model's persisted behavioral signature
 * (D9: only models with a COMPLETE first-pass signature are eligible),
 * and breaks ties with a live, resource-aware memory-fit + hot bonus
 * (D8 — the free-memory figure is probed here, never stored).
 *
 * This is preview/advice only: it does NOT launch anything. A caller
 * (deer-flow, a script) typically follows up with `models.run` on
 * `best.id`.
 */

import { listModelFiles } from '../../listModelFiles';
import { listRunning } from '../../runners/launch';
import { resolveCanonicalShardPath, sumShardBytes } from '../../shardFs';
import { probeFreeMemory } from '../../routing/freeMemory';
import { loadSignature } from '../../routing/signatureStore';
import {
  routeQuery,
  type RouteCandidate,
  type RouteWeights,
} from '../../routing/router';
import { register } from '../registry';

function coerceWeights(value: unknown): RouteWeights | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('weights must be an object');
  }
  const v = value as Record<string, unknown>;
  const out: RouteWeights = {};
  for (const k of ['competence', 'fit', 'hot', 'priorDiscount'] as const) {
    if (v[k] !== undefined) {
      if (typeof v[k] !== 'number')
        throw new Error(`weights.${k} must be number`);
      out[k] = v[k] as number;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

register({
  name: 'models.route',
  description:
    'Pick the best local model for a query. Classifies the query into ' +
    'competence axes (code / math / reasoning / factual / language / …), ' +
    "matches them against each model's measured behavioral signature, " +
    'and ranks by competence + live memory-fit + a hot (already-running) ' +
    'bonus. Only models with a COMPLETE characterization signature are ' +
    'eligible; uncharacterized / quarantined ones are returned too (for ' +
    'transparency) marked `eligible:false` and ranked last. Returns the ' +
    'derived `axisWeights`, the probed `resources` (free VRAM/RAM net of ' +
    'resident models, minus the configured reserve), `best` (top ' +
    'eligible, or null), and the `ranked` list. Advice only — does NOT ' +
    'launch; follow up with `models.run` on `best.id`.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The user prompt / task to route. Its language and required ' +
          'skills are inferred deterministically (no model call).',
      },
      directory: {
        type: 'string',
        description:
          'Absolute path to the directory of candidate models (scanned ' +
          'recursively, shards collapsed to shard 1). Required — the MCP ' +
          'server has no notion of "current location".',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description:
          'Cap on the number of ranked entries returned. Default 20. ' +
          '`best` is always included even if it would fall past the cap.',
      },
      weights: {
        type: 'object',
        description:
          'Optional scoring overrides. `competence` (default 1.0), ' +
          '`fit` (memory-fit weight, default 0.5), `hot` (already-running ' +
          'bonus, default 0.1), `priorDiscount` (0..1, how much an ' +
          "UNMEASURED axis trusts the model's overall as a prior, " +
          'default 0.5).',
        properties: {
          competence: { type: 'number' },
          fit: { type: 'number' },
          hot: { type: 'number' },
          priorDiscount: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    required: ['query', 'directory'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      query?: unknown;
      directory?: unknown;
      limit?: unknown;
      weights?: unknown;
    };
    if (typeof a.query !== 'string' || !a.query.trim()) {
      throw new Error('query is required and must be a non-empty string');
    }
    if (typeof a.directory !== 'string' || !a.directory) {
      throw new Error('directory is required and must be a string');
    }
    const limit =
      typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 20;
    const weights = coerceWeights(a.weights);

    // Which canonical paths are currently held by a runner (hot bonus).
    const runningSet = new Set<string>();
    for (const r of listRunning()) {
      if (!r.exited && r.filePath) {
        runningSet.add(await resolveCanonicalShardPath(r.filePath));
      }
    }

    const files = await listModelFiles(a.directory);
    const candidates: RouteCandidate[] = await Promise.all(
      files.map(async (f) => {
        const signature =
          (await loadSignature(f).catch(() => undefined)) ?? null;
        // Belt: signatures characterized before R0.4 was wired carry a
        // STUB structural (est_footprint_bytes: 0). Probe the real
        // on-disk shard size so memory-fit is never silently null. This
        // is exactly the number computeStructuralSignature would use.
        let footprintBytes: number | undefined;
        if (
          signature &&
          !(
            typeof signature.structural?.est_footprint_bytes === 'number' &&
            signature.structural.est_footprint_bytes > 0
          )
        ) {
          const bytes = await sumShardBytes(f)
            .then((s) => s.totalBytes)
            .catch(() => 0);
          if (bytes > 0) footprintBytes = bytes;
        }
        return {
          id: f,
          signature,
          footprintBytes,
          running: runningSet.has(f),
        };
      }),
    );

    const resources = await probeFreeMemory();
    const { axisWeights, ranked, best } = routeQuery(
      a.query,
      candidates,
      resources,
      weights,
    );

    const trim = (r: (typeof ranked)[number]) => ({
      id: r.id,
      eligible: r.eligible,
      ineligibleReason: r.ineligibleReason,
      score: r.eligible ? Number(r.score.toFixed(4)) : null,
      competenceMatch: Number(r.competenceMatch.toFixed(4)),
      fit: r.fit === null ? null : Number(r.fit.toFixed(4)),
      hot: r.hot,
      axes: r.axes.map((h) => ({
        axis: h.axis,
        weight: h.weight,
        modelScore: h.modelScore,
        usedPrior: h.usedPrior,
      })),
    });

    // Keep `best` even if the cap would drop it (it is always ranked[0]
    // when present, but be defensive if weights ever invert the order).
    const head = ranked.slice(0, limit);
    if (best && !head.some((r) => r.id === best.id)) head.push(best);

    return {
      query: a.query,
      axisWeights,
      resources: {
        freeVramBytes: resources.freeVramBytes,
        freeRamBytes: resources.freeRamBytes,
        vramSource: resources.vramSource,
        reserves: resources.reserves,
        residentModels: resources.residentModels,
      },
      best: best ? trim(best) : null,
      count: ranked.length,
      ranked: head.map(trim),
    };
  },
});
