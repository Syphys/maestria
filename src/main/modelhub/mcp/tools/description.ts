/**
 * `description.*` MCP tools.
 *
 * The TagSpaces description is a markdown string at the sidecar root
 * level (`description`). `description.get` reads it, `description.set`
 * overwrites it. Both resolve to the canonical shard so a description
 * written from any sibling of a sharded model lands on the canonical
 * entry — matches every other write path in Models Hub.
 */

import { loadSidecar, patchSidecar } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';

register({
  name: 'description.get',
  description:
    'Read the TagSpaces `description` field (markdown) for a file. ' +
    'Returns an empty string when none has been set yet.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const sidecar = await loadSidecar(canonical);
    return {
      description:
        typeof sidecar.description === 'string' ? sidecar.description : '',
    };
  },
});

register({
  name: 'description.set',
  description:
    'Replace the TagSpaces `description` field (markdown) for a file. ' +
    'Pass an empty string to clear it. The previous content is lost — ' +
    'no merge, no append. Other sidecar fields (tags, modelMeta, …) ' +
    'are preserved.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
      markdown: {
        type: 'string',
        description: 'New description content. Use an empty string to clear.',
      },
    },
    required: ['path', 'markdown'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; markdown?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    if (typeof a.markdown !== 'string') {
      throw new Error('markdown is required and must be a string');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const result = await patchSidecar(canonical, { description: a.markdown });
    return {
      ok: true,
      written: result.written,
      sidecarPath: result.sidecarPath,
    };
  },
});
