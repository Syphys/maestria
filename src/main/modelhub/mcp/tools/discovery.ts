/**
 * Filesystem-discovery MCP tools. Lightweight, read-only utilities the
 * renderer perspectives depend on (size filter, "hide folders without
 * models" gate). Exposed for symmetry — an MCP caller building its own
 * model picker shouldn't have to re-implement shard collapsing or
 * folder pruning.
 */

import { listModelHostingFolders } from '../../listModelHostingFolders';
import { resolveCanonicalShardPath, sumShardBytes } from '../../shardFs';
import { register } from '../registry';

register({
  name: 'models.sum_shard_bytes',
  description:
    'Sum the byte sizes of every sibling shard for a sharded model ' +
    "(or the file's own size when not sharded). Pure `fs.stat` — does " +
    'NOT parse headers or touch sidecars. Returns ' +
    '`{ totalBytes, shardCount, expectedTotal, incomplete }` — same ' +
    "shape the renderer's size filter consumes for the GB slider.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path to any shard. We resolve to shard 1 ' +
          'internally before walking siblings.',
      },
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
    return await sumShardBytes(canonical);
  },
});

register({
  name: 'models.list_hosting_folders',
  description:
    'Walk `directory` recursively and return the set of folder paths ' +
    'that contain at least one model file. Drives the "hide folders ' +
    'without models" filter in the renderer\'s directory listing. ' +
    'Bounded by `maxFiles` (default 50 000) and `maxDepth` (default ' +
    "16) so a runaway scan can't hang the server.",
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Absolute path to the directory to scan.',
      },
      maxFiles: {
        type: 'integer',
        minimum: 1,
        description:
          'Stop scanning after this many model files. Default 50 000.',
      },
      maxDepth: {
        type: 'integer',
        minimum: 1,
        description: 'Cap on directory recursion depth. Default 16.',
      },
    },
    required: ['directory'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as {
      directory?: unknown;
      maxFiles?: unknown;
      maxDepth?: unknown;
    };
    if (typeof a.directory !== 'string' || !a.directory) {
      throw new Error('directory is required and must be a string');
    }
    const folders = await listModelHostingFolders(a.directory, {
      maxFiles: typeof a.maxFiles === 'number' ? a.maxFiles : undefined,
      maxDepth: typeof a.maxDepth === 'number' ? a.maxDepth : undefined,
    });
    return { folders, count: folders.length };
  },
});
