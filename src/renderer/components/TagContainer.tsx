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

import DateIcon from '@mui/icons-material/DateRange';
import LockIcon from '@mui/icons-material/Lock';
import PlaceIcon from '@mui/icons-material/Place';
import { Box } from '@mui/material';
import React, { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';

import Tag from '-/components/Tag';
import TagContainerMenu from '-/components/TagContainerMenu';
import { useEditedTagLibraryContext } from '-/hooks/useEditedTagLibraryContext';
import { useSelectedEntriesContext } from '-/hooks/useSelectedEntriesContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { getTagColor, getTagTextColor } from '-/reducers/settings';
import { getTagColors } from '-/services/taglibrary-utils';
import { TS } from '-/tagspaces.namespace';
import { isAutoTag } from '-/modelhub/autoTags';
import { convertToTimestamp, isDateTimeTag } from '-/utils/dates';
import { isGeoTag } from '-/utils/geo';
import { formatDateTime } from '@tagspaces/tagspaces-common/misc';

interface Props {
  tag: TS.Tag;
  tagGroup?: TS.TagGroup;
  handleTagMenu?: (
    event: Object,
    tag: TS.Tag,
    tagGroup: TS.TagGroup | TS.FileSystemEntry,
    haveSelectedEntries: boolean,
  ) => void;
  handleRemoveTag?: (event: Object, tags: Array<TS.Tag>) => void;
  isDragging?: boolean;
  tagMode?: 'default' | 'display' | 'remove';
  entry?: TS.FileSystemEntry;
  deleteIcon?: any;
  moveTag?: (
    tagTitle: string,
    fromTagGroupId: TS.Uuid,
    toTagGroupId: TS.Uuid,
  ) => void;
  reorderTags?: boolean;
}

function TagContainer({
  tag,
  tagGroup,
  entry,
  handleTagMenu,
  handleRemoveTag,
  deleteIcon,
  isDragging,
  tagMode,
}: Props) {
  const {
    title: originalTitle,
    functionality,
    color,
    textcolor,
    description,
  } = tag;
  const { addTags } = useTaggingActionsContext();
  const { selectedEntries } = useSelectedEntriesContext();
  const { tagGroups } = useEditedTagLibraryContext();

  const defaultBgColor = useSelector(getTagColor);
  const defaultTextColor = useSelector(getTagTextColor);

  // Compute tag color once
  const { color: bgColor, textcolor: txtColor } = useMemo(
    () =>
      color && textcolor
        ? { color, textcolor }
        : getTagColors(
            originalTitle,
            tagGroup ? [tagGroup] : tagGroups,
            defaultTextColor,
            defaultBgColor,
          ),
    [
      color,
      textcolor,
      originalTitle,
      tagGroup,
      tagGroups,
      defaultTextColor,
      defaultBgColor,
    ],
  );

  // Create the getColor function once
  // const getColors = useCallback(
  //   () =>
  //     color && textcolor
  //       ? { color, textcolor }
  //       : getTagColors(
  //           originalTitle,
  //           tagGroup ? [tagGroup] : tagGroups,
  //           defaultTextColor,
  //           defaultBgColor,
  //         ),
  //   [
  //     color,
  //     textcolor,
  //     originalTitle,
  //     tagGroup,
  //     tagGroups,
  //     defaultTextColor,
  //     defaultBgColor,
  //   ],
  // );
  // const { color: bgColor, textcolor: txtColor } = getColors();

  // let txtColor;
  // let bgColor;
  // if (tag.color && tag.textcolor) {
  //   txtColor = tag.textcolor;
  //   bgColor = tag.color;
  // } else {
  //   const tagColors = getTagColors(
  //     originalTitle,
  //     tagGroup ? [tagGroup] : undefined,
  //     defaultTextColor,
  //     defaultBgColor,
  //   );
  //   txtColor = tagColors.textcolor;
  //   bgColor = tagColors.color;
  // }

  /** Detect tag type */
  const isTagGeo = useMemo(
    () => !tagGroup && isGeoTag(originalTitle),
    [originalTitle, tagGroup],
  );
  const isTagDate = useMemo(
    () => !isTagGeo && !tagGroup && isDateTimeTag(originalTitle),
    [isTagGeo, originalTitle, tagGroup],
  );

  const isGeoSmartTag = functionality === 'geoTagging';
  const isDateSmartTag = [
    'now',
    'today',
    'tomorrow',
    'yesterday',
    'currentMonth',
    'currentYear',
    'dateTagging',
  ].includes(functionality || '');
  // Source of truth = the namespace prefix (arch:, tier:, dir:, …)
  // in addition to the persisted `system: true` marker. Upstream TagSpaces
  // tag-edit flows occasionally rewrite the sidecar `tags[]` from a
  // flattened representation that drops custom fields like `system` and
  // `origin`, which would un-lock our auto-tags. The namespace check is
  // robust to that — any title matching a Models Hub auto-tag namespace
  // stays read-only no matter what's in the JSON.
  const isSystemTag = tag.system === true || isAutoTag(tag.title ?? '');
  /** System tags are read-only: force display mode regardless of caller intent. */
  const effectiveTagMode = isSystemTag ? 'display' : tagMode;

  /** Compute readable tag title for date tags */
  const tagTitle = useMemo(() => {
    if (!isTagDate) return description ? `${originalTitle} ${description}` : '';
    const [first, second] = originalTitle.split('-');
    const format = (val: string) => {
      const ts = convertToTimestamp(val);
      return formatDateTime(ts, val.length > 8);
    };

    let titleText = '';
    if (second && !isNaN(+first) && !isNaN(+second)) {
      titleText = `${format(first)} <-> ${format(second)}`;
    } else {
      titleText = format(originalTitle);
    }

    return description ? `${titleText} ${description}` : titleText;
  }, [isTagDate, originalTitle, description]);

  /** Truncate long date titles for display */
  const displayTitle = useMemo(
    () =>
      isTagDate && originalTitle.length > 8
        ? `${originalTitle.slice(0, 8)}...`
        : originalTitle,
    [isTagDate, originalTitle],
  );

  const tid = useMemo(
    () => `tagContainer_${originalTitle.replace(/\s+/g, '_')}`,
    [originalTitle],
  );

  /** Unified menu handler */
  const handleMenu = useCallback(
    (event: any) => {
      if (!handleTagMenu) return;
      // System tags are read-only — suppress the context/edit menu entirely.
      if (isSystemTag) return;
      handleTagMenu(event, tag, entry || tagGroup, !!selectedEntries?.length);
    },
    [handleTagMenu, tag, entry, tagGroup, selectedEntries, isSystemTag],
  );

  /** Ctrl+Click adds tag */
  const handleClick = useCallback(
    (event: any) => {
      // Block all interactions on system tags — they are managed by the system.
      if (isSystemTag) return;
      if (event.ctrlKey && addTags) {
        addTags(selectedEntries, [tag]);
      } else {
        handleMenu(event);
      }
    },
    [addTags, selectedEntries, tag, handleMenu, isSystemTag],
  );

  return (
    <Box
      role="presentation"
      data-tid={tid}
      key={tag.id || (tagGroup?.uuid ?? '') + tid}
      onClick={handleClick}
      onContextMenu={handleMenu}
      onDoubleClick={handleMenu}
      sx={{ display: 'inline-block' }}
    >
      <Tag
        isDragging={isDragging}
        tagTitle={tagTitle}
        textColor={txtColor}
        backgroundColor={bgColor}
      >
        <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center' }}>
          {(isTagGeo || isGeoSmartTag) && (
            <PlaceIcon sx={{ color: txtColor, height: 16, ml: '-5px' }} />
          )}
          {(isTagDate || isDateSmartTag) && (
            <DateIcon sx={{ color: txtColor, height: 16, ml: '-5px' }} />
          )}
          {isSystemTag && (
            <LockIcon
              sx={{
                color: txtColor,
                height: 12,
                width: 12,
                ml: '-3px',
                opacity: 0.7,
              }}
              titleAccess="System tag (read-only)"
            />
          )}
          {!isTagGeo && <span>{displayTitle}</span>}
        </Box>

        <TagContainerMenu
          handleRemoveTag={handleRemoveTag}
          tag={tag}
          tagMode={effectiveTagMode}
          deleteIcon={deleteIcon}
        />
      </Tag>
    </Box>
  );
}

export default React.memo(TagContainer);
