/**
 * Helper to keep a "Models Hub (auto)" tag group in sync with the system
 * auto-tags discovered during bulk enrichment.
 *
 * The group is kept in the user's tag library so it shows up in the search
 * autocomplete and in the Tag Library panel — but marked `readOnly` so the
 * user can't accidentally edit it from the UI. It is rebuilt every time bulk
 * enrichment runs.
 */

import { TS } from '-/tagspaces.namespace';

/**
 * Stable UUID for the Models Hub tag group. Lets us locate and overwrite the
 * group on each bulk run without proliferating duplicates.
 * (Plain string used as Uuid — TagSpaces accepts any unique string here.)
 */
export const MODELHUB_TAGGROUP_UUID = 'modelhub-auto-tags-system';
export const MODELHUB_TAGGROUP_TITLE = 'Models Hub (auto)';

const SYSTEM_TAG_BG = '#616161';
const SYSTEM_TAG_FG = '#ffffff';

/** Build the tag group from a deduplicated list of auto-tag strings. */
export function buildModelhubTagGroup(autoTags: string[]): TS.TagGroup {
  const sorted = Array.from(new Set(autoTags)).sort();
  const children: TS.Tag[] = sorted.map((title) => ({
    title,
    type: 'sidecar',
    system: true,
    origin: 'modelhub',
    color: SYSTEM_TAG_BG,
    textcolor: SYSTEM_TAG_FG,
  }));
  // NOTE: do NOT mark this group `readOnly`. The TagSpaces persistence layer
  // (`setTagLibrary` in services/taglibrary-utils.ts) filters out `readOnly`
  // groups when writing to localStorage, which would mean our group is lost
  // on every app restart. Per-tag immutability is already enforced via
  // `system: true` on each child (TagContainer renders them in display-only
  // mode). If the user manually deletes the group via UI, it'll be rebuilt on
  // the next "Parse all" run.
  return {
    uuid: MODELHUB_TAGGROUP_UUID,
    title: MODELHUB_TAGGROUP_TITLE,
    description:
      'Auto-derived tags from model file headers. Managed by Models Hub — recomputed on every "Parse all" run.',
    color: SYSTEM_TAG_BG,
    textcolor: SYSTEM_TAG_FG,
    expanded: true,
    children,
    modified_date: Date.now(),
  };
}

/**
 * Returns a new tagGroups list with the Models Hub group upserted at the end.
 * If `autoTags` is empty, the group is removed entirely (clean-up).
 */
export function upsertModelhubTagGroup(
  existing: TS.TagGroup[],
  autoTags: string[],
): TS.TagGroup[] {
  const filtered = (existing || []).filter(
    (g) => g.uuid !== MODELHUB_TAGGROUP_UUID,
  );
  if (autoTags.length === 0) return filtered;
  return [...filtered, buildModelhubTagGroup(autoTags)];
}
