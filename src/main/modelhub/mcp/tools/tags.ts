/**
 * `tags.*` MCP tools.
 *
 * Operates on the sidecar `tags[]` array — TagSpaces' canonical
 * representation. System tags (those marked `system: true` or
 * `origin: 'modelhub'`) are never touched: the LLM can only add/remove
 * user-set tags, the auto-tag namespace (arch:*, quant:*, size:*, …)
 * stays under our deterministic control.
 *
 * Tag titles are matched case-sensitive (TagSpaces' convention). Newly
 * created tags get a neutral color so the UI doesn't render them as
 * "untitled blank" chips. Existing-by-title tags are left alone — no
 * color clobbering on re-add.
 */

import { loadSidecar, patchSidecar } from '../../sidecar';
import { resolveCanonicalShardPath } from '../../shardFs';
import { register } from '../registry';

interface SidecarTag {
  title?: string;
  type?: string;
  color?: string;
  textcolor?: string;
  system?: boolean;
  origin?: string;
  [k: string]: unknown;
}

const DEFAULT_USER_TAG_COLOR = '#4caf50'; // material green-500
const DEFAULT_USER_TAG_TEXT = '#ffffff';

function makeUserTag(title: string): SidecarTag {
  return {
    title,
    type: 'sidecar',
    color: DEFAULT_USER_TAG_COLOR,
    textcolor: DEFAULT_USER_TAG_TEXT,
  };
}

function isSystemTag(t: SidecarTag): boolean {
  return t.system === true || t.origin === 'modelhub';
}

register({
  name: 'tags.add',
  description:
    'Add user tags to a file. Tags already present (same title, ' +
    'case-sensitive) are skipped. System tags (arch:*, quant:*, ' +
    'size:*, …) are read-only and out of scope here. Returns the ' +
    'updated `tags[]` array.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description:
          'Tag titles to add. Empty / whitespace-only entries ignored.',
      },
    },
    required: ['path', 'tags'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; tags?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    if (!Array.isArray(a.tags) || a.tags.length === 0) {
      throw new Error('tags is required and must be a non-empty array');
    }
    const additions = a.tags
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
    if (additions.length === 0) {
      throw new Error('no valid tag titles in `tags`');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const sidecar = await loadSidecar(canonical);
    const existing: SidecarTag[] = Array.isArray(sidecar.tags)
      ? (sidecar.tags as SidecarTag[])
      : [];
    const existingTitles = new Set(
      existing
        .map((t) => t.title)
        .filter((s): s is string => typeof s === 'string'),
    );
    const newTags: SidecarTag[] = [];
    for (const title of additions) {
      if (!existingTitles.has(title)) {
        newTags.push(makeUserTag(title));
        existingTitles.add(title);
      }
    }
    if (newTags.length === 0) {
      return { tags: existing, added: 0, written: false };
    }
    const next = [...existing, ...newTags];
    const result = await patchSidecar(canonical, { tags: next });
    return {
      tags: next,
      added: newTags.length,
      written: result.written,
      sidecarPath: result.sidecarPath,
    };
  },
});

register({
  name: 'tags.remove',
  description:
    'Remove user tags from a file. System tags are skipped silently — ' +
    'they cannot be removed via MCP; use Models Hub UI for that. ' +
    'Returns the updated `tags[]` array.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'Tag titles to remove (case-sensitive match).',
      },
    },
    required: ['path', 'tags'],
    additionalProperties: false,
  },
  handler: async (args: unknown) => {
    const a = args as { path?: unknown; tags?: unknown };
    if (typeof a.path !== 'string' || !a.path) {
      throw new Error('path is required and must be a string');
    }
    if (!Array.isArray(a.tags) || a.tags.length === 0) {
      throw new Error('tags is required and must be a non-empty array');
    }
    const remove = new Set(
      a.tags
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (remove.size === 0) {
      throw new Error('no valid tag titles in `tags`');
    }
    const canonical = await resolveCanonicalShardPath(a.path);
    const sidecar = await loadSidecar(canonical);
    const existing: SidecarTag[] = Array.isArray(sidecar.tags)
      ? (sidecar.tags as SidecarTag[])
      : [];
    const next: SidecarTag[] = [];
    let removed = 0;
    for (const t of existing) {
      const title = typeof t.title === 'string' ? t.title : '';
      // Keep system tags regardless of whether they're targeted.
      if (isSystemTag(t)) {
        next.push(t);
        continue;
      }
      if (remove.has(title)) {
        removed += 1;
        continue;
      }
      next.push(t);
    }
    if (removed === 0) {
      return { tags: existing, removed: 0, written: false };
    }
    const result = await patchSidecar(canonical, { tags: next });
    return {
      tags: next,
      removed,
      written: result.written,
      sidecarPath: result.sidecarPath,
    };
  },
});
