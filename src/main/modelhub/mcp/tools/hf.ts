/**
 * `hf.*` MCP tools.
 *
 * Thin wrapper around `enrichHf` so an external client can trigger a
 * Hugging Face match + metadata fetch on a file. Honours the existing
 * 7-day TTL cache, can be bypassed with `force: true`.
 */

import { enrichHf } from '../../enrichHf';
import { register } from '../registry';

register({
  name: 'hf.fetch',
  description:
    'Match a model file against Hugging Face by filename + header ' +
    'heuristics, fetch its model card (license, downloads, tags, ' +
    'README excerpt) and merge into the sidecar `modelMeta.huggingface` ' +
    'block. Cached for 7 days; pass `force: true` to bypass the cache. ' +
    'Returns the matched repo and the new huggingface block, or an ' +
    'error reason when no repo matched.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
      force: {
        type: 'boolean',
        description: 'Re-fetch even if a fresh cached entry exists.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; force?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const result = await enrichHf(a.path, {
      force: a.force === true,
    });
    if (!result.ok) {
      throw new Error(result.error ?? 'HF fetch failed');
    }
    return {
      matchedRepo: result.matchedRepo,
      fromCache: result.fromCache,
      written: result.written,
      huggingface: result.modelMeta?.huggingface,
    };
  },
});
