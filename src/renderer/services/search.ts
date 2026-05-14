/* eslint-disable compat/compat */
/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */

import { TS } from '-/tagspaces.namespace';
import {
  searchLocationIndex,
  haveSearchFilters as _haveSearchFilters,
  defaultTitle as _defaultTitle,
} from '@tagspaces/tagspaces-search';
import { isNoteFile, isSupportedModelFile } from '-/modelhub/parsers';
import { detectShardInfo, isCanonicalShard } from '-/modelhub/shard';
import {
  getCachedTotalBytes,
  primeTotalBytes,
} from '-/modelhub/shardSizeCache';

/**
 * Returns true when the user has set any filter the upstream search engine
 * understands, OR our Models Hub `sizeMin/sizeMax` extension. Including the
 * size range here means setting just a size filter is enough to enter
 * search mode (otherwise haveSearchFilters returns false → no execution).
 */
export function haveSearchFilters(searchQuery: TS.SearchQuery) {
  if (_haveSearchFilters(searchQuery)) return true;
  if (typeof searchQuery?.sizeMin === 'number' && searchQuery.sizeMin > 0)
    return true;
  if (typeof searchQuery?.sizeMax === 'number' && searchQuery.sizeMax > 0)
    return true;
  if (
    Array.isArray(searchQuery?.paramBuckets) &&
    searchQuery.paramBuckets.length > 0
  ) {
    return true;
  }
  return false;
}

export function defaultTitle(searchQuery: TS.SearchQuery) {
  return _defaultTitle(searchQuery);
}

/**
 * Models Hub post-filter:
 *  - Always drops folders. A folder has no model weight; it's just a
 *    container, so it has nothing to do in the results list (and keeping
 *    them pushes actual matches off-screen).
 *  - Always drops non-model files (READMEs, configs, .ps1, .png …). This
 *    is a Models Hub fork — model browsing is the entire point. The
 *    user can still open a folder directly to see everything; this only
 *    affects search results.
 *  - Drops non-canonical shards (e.g. `foo-00007-of-00012.gguf`). A
 *    sharded model is one logical entry — see MODELS_HUB_SHARDS.md.
 *  - Applies the numeric `sizeMin/sizeMax` byte-range filter, comparing
 *    against the *aggregate* `totalBytes` for sharded canonical entries
 *    so a Llama-70B split into 12×5 GB shards is correctly matched by a
 *    "≥ 50 GB" slider.
 */
function entryTagTitles(entry: TS.FileSystemEntry): string[] {
  const raw = (entry as { tags?: Array<{ title?: string } | string> }).tags;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === 'string' ? t : (t?.title ?? '')))
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * Exported for smoke-testing only — keeps the post-filter rule isolated
 * so we can hammer it with synthetic entries without booting the
 * full search engine.
 */
export function _testApplyModelhubFilters(
  results: TS.FileSystemEntry[],
  searchQuery: TS.SearchQuery,
): TS.FileSystemEntry[] {
  return applyModelhubFilters(results, searchQuery);
}

function applyModelhubFilters(
  results: TS.FileSystemEntry[],
  searchQuery: TS.SearchQuery,
): TS.FileSystemEntry[] {
  const min = searchQuery?.sizeMin;
  const max = searchQuery?.sizeMax;
  const minActive = typeof min === 'number' && min > 0;
  const maxActive = typeof max === 'number' && max > 0;
  const buckets = Array.isArray(searchQuery?.paramBuckets)
    ? searchQuery!.paramBuckets!.filter(
        (b) => typeof b === 'string' && b.length > 0,
      )
    : [];
  const wantedSizeTags = new Set(buckets.map((b) => `tier:${b}`));
  const bucketsActive = wantedSizeTags.size > 0;

  // Mirror the central listing filter: search results follow the same
  // three-mode rule (modelsOnly / modelsAndNotes / all) set in the
  // FolderContainer header. We read straight from localStorage because
  // search.ts is a pure module (no React context). The note-extension
  // whitelist is also user-editable in Settings ▸ AI and persisted there.
  let listingMode: 'modelsOnly' | 'modelsAndNotes' | 'all' = 'modelsAndNotes';
  let noteExtensions: string[] | undefined;
  try {
    const raw = localStorage.getItem('modelhub.listingMode');
    if (raw === 'modelsOnly' || raw === 'modelsAndNotes' || raw === 'all') {
      listingMode = raw;
    }
    const extRaw = localStorage.getItem('modelhub.noteExtensions');
    if (extRaw) {
      const parsed = JSON.parse(extRaw);
      if (Array.isArray(parsed) && parsed.every((e) => typeof e === 'string')) {
        noteExtensions = parsed;
      }
    }
  } catch {
    // ignore storage / parse failures
  }
  const allowNotes = listingMode === 'modelsAndNotes';

  return results.filter((entry) => {
    if (!entry.isFile) return false; // never show folders in search results
    // entry.path may be undefined for synthetic results; fall back to name.
    const nameForExt = entry.name ?? entry.path ?? '';
    if (listingMode !== 'all') {
      const isNote = allowNotes && isNoteFile(nameForExt, noteExtensions);
      if (!isSupportedModelFile(nameForExt) && !isNote) return false;
      if (!isNote && !isCanonicalShard(nameForExt)) return false;
    }

    // Parameter-count chips: keep entries that carry at least one of the
    // requested `size:<bucket>` system tags. The auto-tags get mirrored
    // into `entry.tags` during enrichment via syncSystemTags, so this is
    // a pure in-memory check — no IPC. Entries with no tags at all (not
    // yet enriched) are dropped to avoid false positives.
    if (bucketsActive) {
      const tags = entryTagTitles(entry);
      if (tags.length === 0) return false;
      if (!tags.some((t) => wantedSizeTags.has(t))) return false;
    }

    if (!minActive && !maxActive) return true;

    // For sharded canonical entries, prefer the cached aggregate. The
    // cache is populated asynchronously by `primeTotalBytes`; until it
    // lands we fall back to `entry.size` (just shard 1's bytes), which
    // means a sharded model may briefly fail a strict size filter on
    // the first render. Acceptable trade-off vs blocking the UI on
    // 1500 sidecar reads per keystroke.
    const isSharded = !!detectShardInfo(nameForExt);
    let s = entry.size;
    if (isSharded && typeof entry.path === 'string') {
      const cached = getCachedTotalBytes(entry.path);
      if (typeof cached === 'number' && cached > 0) {
        s = cached;
      }
    }
    if (typeof s !== 'number') return false;
    if (minActive && s < (min as number)) return false;
    if (maxActive && s > (max as number)) return false;
    return true;
  });
}

/**
 * Collect canonical sharded paths from a result set so we can prime the
 * `totalBytes` cache before applying the size filter.
 */
function shardedPaths(entries: TS.FileSystemEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile) continue;
    const name = e.name ?? e.path ?? '';
    if (!isCanonicalShard(name)) continue;
    if (!detectShardInfo(name)) continue;
    if (typeof e.path === 'string') out.push(e.path);
  }
  return out;
}

export default class Search {
  static searchLocationIndex = async (
    locationContent: Array<TS.FileSystemEntry>,
    searchQuery: TS.SearchQuery,
    tagDelimiter: string,
    options?: {
      fuseInstance?: any;
      preparedIndex?: any[];
    },
  ): Promise<TS.FileSystemEntry[]> => {
    const upstream = await searchLocationIndex(
      locationContent,
      searchQuery,
      tagDelimiter,
      options,
    );
    // Background-prime the shard-size cache so the next pass through the
    // filter (after the user nudges the slider) sees correct aggregate
    // sizes. Awaited only when a size filter is active so cold queries
    // get a one-shot correct result; otherwise fire-and-forget.
    const sharded = shardedPaths(upstream);
    if (sharded.length > 0) {
      const sizeActive =
        (typeof searchQuery?.sizeMin === 'number' && searchQuery.sizeMin > 0) ||
        (typeof searchQuery?.sizeMax === 'number' && searchQuery.sizeMax > 0);
      if (sizeActive) {
        await primeTotalBytes(sharded);
      } else {
        primeTotalBytes(sharded).catch(() => {
          /* best-effort; cache stays empty on failure */
        });
      }
    }
    return applyModelhubFilters(upstream, searchQuery);
  };
}
