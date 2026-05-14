/**
 * Bulk-clear every model-file sidecar in a root: removes the TagSpaces
 * `description` field and filters out system / auto-namespaced tags.
 *
 * User-added tags (anything without `system: true`, without
 * `origin: 'modelhub'`, and whose title doesn't match a known auto
 * namespace) survive untouched.
 *
 * Synchronous walk — no concurrency. Each file is a single read + write,
 * cheap on NVMe even for thousands of sidecars. Per-file failures are
 * captured in the summary but don't abort the run.
 */

import fs from 'fs';
import { listModelFiles } from './listModelFiles';
import { sidecarPathFor } from './sidecar';

// Auto-tag namespaces — kept in sync with renderer/modelhub/autoTags.ts.
// Duplicated because the main process can't import renderer code; the list
// is short and changes rarely.
const AUTO_TAG_NAMESPACES = new Set<string>([
  'arch',
  'quant',
  'tier',
  'ctx',
  'mod',
  'fmt',
  'lic',
  'type',
  'dir',
  'meta',
  'hf',
]);

function isAutoTagTitle(title: string): boolean {
  const colonIdx = title.indexOf(':');
  if (colonIdx <= 0) return false;
  return AUTO_TAG_NAMESPACES.has(title.slice(0, colonIdx));
}

interface SidecarTagLite {
  title?: string;
  system?: boolean;
  origin?: string;
  [k: string]: unknown;
}

export interface ClearFolderSummary {
  total: number;
  cleared: number;
  skipped: number;
  errors: number;
  errorSamples: Array<{ filePath: string; error: string }>;
}

export interface ClearFolderOptions {
  /** Strip system / auto-namespaced tags from `sidecar.tags[]`. */
  tags?: boolean;
  /** Empty the `sidecar.description` string. */
  description?: boolean;
  /** Drop the entire `modelMeta.huggingface` block too. */
  huggingface?: boolean;
}

export async function clearFolder(
  rootDir: string,
  options: ClearFolderOptions = { tags: true, description: true },
): Promise<ClearFolderSummary> {
  const wantTags = options.tags === true;
  const wantDesc = options.description === true;
  const wantHf = options.huggingface === true;
  const files = await listModelFiles(rootDir);
  const summary: ClearFolderSummary = {
    total: files.length,
    cleared: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
  };

  // Caller passed `{}` — nothing to do, return early with everything skipped
  // so the UI still gets a coherent summary instead of a silent no-op.
  if (!wantTags && !wantDesc && !wantHf) {
    summary.skipped = files.length;
    return summary;
  }

  for (const filePath of files) {
    try {
      const sidecarPath = sidecarPathFor(filePath);
      let raw: string;
      try {
        // eslint-disable-next-line no-await-in-loop
        raw = await fs.promises.readFile(sidecarPath, 'utf-8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          summary.skipped += 1;
          continue;
        }
        throw e;
      }
      const sidecar = JSON.parse(raw);
      let changed = false;
      if (
        wantDesc &&
        typeof sidecar.description === 'string' &&
        sidecar.description
      ) {
        sidecar.description = '';
        changed = true;
      }
      if (wantTags && Array.isArray(sidecar.tags)) {
        const filtered = sidecar.tags.filter((t: SidecarTagLite) => {
          const title = typeof t.title === 'string' ? t.title : '';
          return !(
            t.system === true ||
            t.origin === 'modelhub' ||
            isAutoTagTitle(title)
          );
        });
        if (filtered.length !== sidecar.tags.length) {
          sidecar.tags = filtered;
          changed = true;
        }
      }
      if (
        wantHf &&
        sidecar.modelMeta &&
        typeof sidecar.modelMeta === 'object' &&
        (sidecar.modelMeta as { huggingface?: unknown }).huggingface !==
          undefined
      ) {
        delete (sidecar.modelMeta as { huggingface?: unknown }).huggingface;
        changed = true;
      }
      if (changed) {
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.writeFile(
          sidecarPath,
          JSON.stringify(sidecar, null, 2),
          'utf-8',
        );
        summary.cleared += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (e) {
      summary.errors += 1;
      if (summary.errorSamples.length < 8) {
        summary.errorSamples.push({
          filePath,
          error: (e as Error).message,
        });
      }
    }
  }

  return summary;
}
