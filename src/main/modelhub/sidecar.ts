/**
 * Sidecar IO for Models Hub: extends an existing TagSpaces `.ts/{file}.json`
 * by setting/updating the `modelMeta` field while preserving everything else.
 *
 * Read-only guard: the caller passes `skipWrite: true` for read-only locations.
 * In that mode we still load + return the merged in-memory result, but never
 * touch disk.
 */

import fs from 'fs';
import path from 'path';
import { getMetaFileLocationForFile } from '@tagspaces/tagspaces-common/paths';
import { ModelMeta } from '../../renderer/modelhub/types';

/**
 * Path to the sidecar file for a given content file path.
 * Uses platform separator so Windows + POSIX both work.
 */
export function sidecarPathFor(filePath: string): string {
  return getMetaFileLocationForFile(filePath, path.sep);
}

interface SidecarTag {
  title?: string;
  type?: 'plain' | 'sidecar' | 'smart';
  color?: string;
  textcolor?: string;
  /** True when the tag is system-managed and read-only in the UI. */
  system?: boolean;
  /** Origin marker (e.g. "modelhub"). */
  origin?: string;
  [k: string]: unknown;
}

interface SidecarPayload {
  /** TagSpaces native fields we never overwrite: id, tags, description, color, ... */
  [k: string]: unknown;
  tags?: SidecarTag[];
  modelMeta?: ModelMeta;
}

async function readSidecarJson(metaPath: string): Promise<SidecarPayload> {
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as SidecarPayload;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

async function ensureMetaDir(metaPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
}

/** Returns the current sidecar contents (or empty object if absent). */
export async function loadSidecar(filePath: string): Promise<SidecarPayload> {
  return readSidecarJson(sidecarPathFor(filePath));
}

/** Returns just the `modelMeta` block of the sidecar, if present. */
export async function loadModelMeta(
  filePath: string,
): Promise<ModelMeta | undefined> {
  const sidecar = await loadSidecar(filePath);
  return sidecar.modelMeta;
}

export interface WriteSidecarOptions {
  /** When true, compute the merged result but do not write to disk. */
  skipWrite?: boolean;
  /**
   * When provided, also sync the user-facing `tags[]` array with these
   * auto-tags marked as system-managed. Same write, no extra disk hit.
   */
  syncSystemTags?: string[];
}

export interface WriteSidecarResult {
  sidecarPath: string;
  written: boolean;
  modelMeta: ModelMeta;
  /** True when the sidecar JSON already existed before this call. */
  preExisting: boolean;
}

const SYSTEM_TAG_COLOR_BG = '#616161'; // grey-700 — visually distinct from user tags
const SYSTEM_TAG_COLOR_FG = '#ffffff';

/**
 * Build a fresh system tag with the Models Hub markers + colors. Used both
 * for new auto-tags AND to upgrade an existing same-titled user tag.
 */
function makeSystemTag(title: string): SidecarTag {
  return {
    title,
    type: 'sidecar',
    system: true,
    origin: 'modelhub',
    color: SYSTEM_TAG_COLOR_BG,
    textcolor: SYSTEM_TAG_COLOR_FG,
  };
}

/**
 * Reconcile the sidecar's `tags[]` with the freshly computed `autoTags`:
 *
 *  - Genuinely user-set tags (whose titles aren't in `autoTags`) are kept
 *    untouched.
 *  - Tags with titles that match `autoTags` are upgraded in place to the
 *    system shape (system: true + origin: modelhub + grey color), no
 *    matter whether they were system already or plain user tags. This
 *    fixes the duplicate-rendering bug where older sidecars had a
 *    non-system version that survived alongside our newly-added system
 *    one.
 *  - Auto-tags that aren't present at all get inserted as new system tags.
 *
 * Title comparison is case-sensitive (matches how TagSpaces handles tag
 * identity elsewhere). Order: user tags first, system tags appended.
 */
function mergeSystemTagsIntoExisting(
  existing: SidecarTag[] | undefined,
  autoTags: string[],
): SidecarTag[] {
  const prior: SidecarTag[] = Array.isArray(existing) ? existing : [];
  const autoSet = new Set(autoTags);
  const seenAuto = new Set<string>();

  const userTags: SidecarTag[] = [];

  // 1. Separate user tags from system tags.
  // We consider a tag "system" if it has system: true OR origin: 'modelhub'.
  for (const t of prior) {
    const title = typeof t.title === 'string' ? t.title : '';
    if (!title) continue;

    const isSystem = t.system === true || t.origin === 'modelhub';

    if (isSystem) {
      // It's a system tag. We don't keep it in userTags.
      // If its title is in autoTags, we'll recreate it anyway.
      continue;
    }

    // It's a user tag.
    if (autoSet.has(title)) {
      // Special case: if a user tag has the same title as a new auto-tag,
      // we "consume" it by not adding it to userTags, and it will be
      // re-added as a system tag below. This prevents duplicates.
      continue;
    }

    userTags.push(t);
  }

  // 2. Build the new system tags from autoTags.
  const newSystemTags: SidecarTag[] = autoTags.map((title) =>
    makeSystemTag(title),
  );

  // 3. Combine: user tags first, then new system tags.
  return [...userTags, ...newSystemTags];
}

/**
 * Patch the sidecar's `modelMeta` field. The patch is shallow-merged into the
 * existing modelMeta (or creates a new modelMeta if absent). All other sidecar
 * fields are preserved untouched.
 */
export async function patchModelMeta(
  filePath: string,
  patch: Partial<ModelMeta>,
  options: WriteSidecarOptions = {},
): Promise<WriteSidecarResult> {
  const metaPath = sidecarPathFor(filePath);
  const existing = await readSidecarJson(metaPath);
  const preExisting = Object.keys(existing).length > 0;
  const mergedModelMeta: ModelMeta = {
    ...(existing.modelMeta ?? {}),
    ...patch,
  };
  const merged: SidecarPayload = {
    ...existing,
    modelMeta: mergedModelMeta,
  };

  if (options.syncSystemTags) {
    merged.tags = mergeSystemTagsIntoExisting(
      existing.tags,
      options.syncSystemTags,
    );
  }

  if (options.skipWrite) {
    return {
      sidecarPath: metaPath,
      written: false,
      modelMeta: mergedModelMeta,
      preExisting,
    };
  }

  try {
    await ensureMetaDir(metaPath);
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify(merged, null, 2),
      'utf-8',
    );
    return {
      sidecarPath: metaPath,
      written: true,
      modelMeta: mergedModelMeta,
      preExisting,
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EROFS / EACCES / EPERM: filesystem says no → fall back to in-memory result.
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      return {
        sidecarPath: metaPath,
        written: false,
        modelMeta: mergedModelMeta,
        preExisting,
      };
    }
    throw e;
  }
}

/**
 * Standalone helper that only rewrites the sidecar's `tags[]` array with the
 * latest auto-tags marked as system-managed. Use when there's no modelMeta
 * patch to apply — otherwise prefer `patchModelMeta({syncSystemTags})` which
 * combines both into one disk write.
 */
export async function syncSystemTags(
  filePath: string,
  autoTags: string[],
  options: Pick<WriteSidecarOptions, 'skipWrite'> = {},
): Promise<{ written: boolean; sidecarPath: string }> {
  const metaPath = sidecarPathFor(filePath);
  const existing = await readSidecarJson(metaPath);
  const merged: SidecarPayload = {
    ...existing,
    tags: mergeSystemTagsIntoExisting(existing.tags, autoTags),
  };

  if (options.skipWrite) {
    return { written: false, sidecarPath: metaPath };
  }

  try {
    await ensureMetaDir(metaPath);
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify(merged, null, 2),
      'utf-8',
    );
    return { written: true, sidecarPath: metaPath };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      return { written: false, sidecarPath: metaPath };
    }
    throw e;
  }
}
