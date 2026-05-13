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

import AppConfig from '-/AppConfig';
import Marker2xIcon from '-/assets/icons/marker-icon-2x.png';
import MarkerIcon from '-/assets/icons/marker-icon.png';
import MarkerShadowIcon from '-/assets/icons/marker-shadow.png';
import {
  CalendarIcon,
  ClearColorIcon,
  CloudLocationIcon,
  ColorPaletteIcon,
  IDIcon,
  LocalLocationIcon,
  OpenLinkIcon,
  QrCodeIcon,
  SetColorIcon,
  SizeIcon,
} from '-/components/CommonIcons';
import { ProTooltip } from '-/components/HelperComponents';
import InfoIcon from '-/components/InfoIcon';
import NoTileServer from '-/components/NoTileServer';
import PerspectiveSelector from '-/components/PerspectiveSelector';
import TagDropContainer from '-/components/TagDropContainer';
import TagsSelect from '-/components/TagsSelect';
import Tooltip from '-/components/Tooltip';
import TransparentBackground from '-/components/TransparentBackground';
import TsButton from '-/components/TsButton';
import TsIconButton from '-/components/TsIconButton';
import TsTextField from '-/components/TsTextField';
import LinkGeneratorDialog from '-/components/dialogs/LinkGeneratorDialog';
import { useMenuContext } from '-/components/dialogs/hooks/useMenuContext';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useEditedEntryMetaContext } from '-/hooks/useEditedEntryMetaContext';
import { useFilePropertiesContext } from '-/hooks/useFilePropertiesContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { getTagDelimiter } from '-/reducers/settings';
import {
  dirNameValidation,
  fileNameValidation,
  getAllTags,
  openUrl,
  sanitizeAttribution,
} from '-/services/utils-io';
import { TS } from '-/tagspaces.namespace';
import { generateClipboardLink } from '-/utils/dom';
import { formatTimestampLocal } from '-/utils/formatLocalTime';
import { parseGeoLocation } from '-/utils/geo';
import useFirstRender from '-/utils/useFirstRender';
import {
  Box,
  FormControl,
  InputAdornment,
  Popover,
  Typography,
  inputBaseClasses,
} from '@mui/material';
import FormHelperText from '@mui/material/FormHelperText';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import { styled, useTheme } from '@mui/material/styles';
import { formatBytes } from '@tagspaces/tagspaces-common/misc';
import {
  extractContainingDirectoryPath,
  extractDirectoryName,
  extractFileName,
  extractTitle,
} from '@tagspaces/tagspaces-common/paths';
import {
  detectShardInfo,
  isCanonicalShard,
  stripShardSuffix,
} from '-/modelhub/shard';
import { fetchModelMeta } from '-/modelhub/useModelMeta';
import { parseSizeLabel } from '-/modelhub/autoTags';
import {
  getCachedTotalBytes,
  primeTotalBytes,
} from '-/modelhub/shardSizeCache';
import { useModelhubActions } from '-/modelhub/useModelhubActions';
import { isSupportedModelFile } from '-/modelhub/parsers';
import type { HeaderMeta } from '-/modelhub/types';
import RefreshIcon from '@mui/icons-material/Refresh';
import L from 'leaflet';
import React, {
  ChangeEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AttributionControl,
  LayerGroup,
  MapContainer,
  Marker,
  Popup,
} from 'react-leaflet';
import { useSelector } from 'react-redux';
import ElectronTileLayer from '-/components/ElectronTileLayer';
import { Pro } from '../pro';

const ThumbnailTextField = styled(TsTextField)(({ theme }) => ({
  [`& .${inputBaseClasses.root}`]: {
    height: 220,
  },
}));

/** Compact parameter-count formatter (e.g. 22e9 → "22B", 270e6 → "270M"). */
function formatParamCount(n: number | undefined): string {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}K`;
  return String(n);
}

const CustomBackgroundDialog =
  Pro && Pro.UI ? Pro.UI.CustomBackgroundDialog : false;

interface Props {
  tileServer: TS.MapTileServer;
}

function EntryProperties({ tileServer }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { openedEntry, sharingLink, getOpenedDirProps, fileChanged } =
    useOpenedEntryContext();
  const { openMoveCopyFilesDialog } = useMenuContext();
  const { isEditMode } = useFilePropertiesContext();
  const {
    renameDirectory,
    renameFile,
    setBackgroundColorChange,
    saveDirectoryPerspective,
  } = useIOActionsContext();
  const { metaActions } = useEditedEntryMetaContext();
  const { addTagsToFsEntry, removeTagsFromEntry } = useTaggingActionsContext();
  const { findLocation } = useCurrentLocationContext();
  const { showNotification, openConfirmDialog } = useNotificationContext();
  const thumbDialogContext = Pro?.contextProviders?.ThumbDialogContext
    ? useContext<TS.ThumbDialogContextData>(
        Pro.contextProviders.ThumbDialogContext,
      )
    : undefined;
  const bgndDialogContext = Pro?.contextProviders?.BgndDialogContext
    ? useContext<TS.BgndDialogContextData>(
        Pro.contextProviders.BgndDialogContext,
      )
    : undefined;
  const tagDelimiter: string = useSelector(getTagDelimiter);

  const dirProps = useRef<TS.DirProp>();
  const fileNameRef = useRef<HTMLInputElement>(null);
  const sharingLinkRef = useRef<HTMLInputElement>(null);
  const disableConfirmButton = useRef<boolean>(true);
  const fileNameError = useRef<boolean>(false);
  const location = findLocation(openedEntry?.locationID);

  const entryName = useMemo(() => {
    if (!openedEntry) return '';
    if (!openedEntry.isFile) {
      return extractDirectoryName(
        openedEntry.path,
        location?.getDirSeparator(),
      );
    }
    const raw = extractFileName(openedEntry.path, location?.getDirSeparator());
    // Models Hub: strip the `-NNNNN-of-NNNNN` suffix from the displayed
    // filename for canonical sharded entries. Path stays untouched (IO
    // still uses the real on-disk name).
    return isCanonicalShard(raw) && detectShardInfo(raw)
      ? stripShardSuffix(raw)
      : raw;
  }, [openedEntry, location]);

  const [editName, setEditName] = useState<string>();
  const [showSharingLinkDialog, setShowSharingLinkDialog] = useState(false);
  const [displayColorPicker, setDisplayColorPicker] = useState(false);

  // Modelhub: aggregate shard size + sidecar header. Lets the "Taille" field
  // show the sum across all sibling shards (not just shard 1) and surfaces
  // a "Taille des experts" row for MoE models like GLM-5.1 256x22B.
  const [modelHeaderForPanel, setModelHeaderForPanel] = useState<
    HeaderMeta | undefined
  >();
  const [shardAggregateBytes, setShardAggregateBytes] = useState<
    number | undefined
  >();

  // Modelhub actions co-located near the tags chips — clicking "Generate"
  // emits the system tags right above where they'll appear, so the user
  // sees the cause-and-effect in one place.
  const isModelFile = Boolean(
    openedEntry?.isFile &&
      openedEntry.path &&
      isSupportedModelFile(openedEntry.path),
  );
  const modelhubActions = useModelhubActions({
    filePath: openedEntry?.path,
    readOnly: location?.isReadOnly,
  });
  const backgroundImage = useRef<string>('none');
  const thumbImage = useRef<string>('none');

  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const firstRender = useFirstRender();

  const [popoverAnchorEl, setPopoverAnchorEl] = useState<HTMLElement | null>(
    null,
  );
  const popoverOpen = Boolean(popoverAnchorEl);
  const popoverId = popoverOpen ? 'popoverBackground' : undefined;

  const handlePopoverClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      setPopoverAnchorEl(event.currentTarget);
    },
    [],
  );
  const handlePopoverClose = useCallback(() => setPopoverAnchorEl(null), []);

  useEffect(() => {
    reloadBackground();
    reloadThumbnails();
    // eslint-disable-next-line
  }, [openedEntry]);

  useEffect(() => {
    let alive = true;
    setModelHeaderForPanel(undefined);
    setShardAggregateBytes(undefined);

    const path = openedEntry?.path;
    if (!openedEntry?.isFile || !path) return undefined;

    fetchModelMeta(path).then((meta) => {
      if (alive) setModelHeaderForPanel(meta?.header);
    });

    const name = extractFileName(path, location?.getDirSeparator() ?? '/');
    if (isCanonicalShard(name) && detectShardInfo(name)) {
      const cached = getCachedTotalBytes(path);
      if (cached) {
        setShardAggregateBytes(cached);
      } else {
        primeTotalBytes([path]).then(() => {
          if (alive) setShardAggregateBytes(getCachedTotalBytes(path));
        });
      }
    }

    return () => {
      alive = false;
    };
  }, [openedEntry, location]);

  useEffect(() => {
    if (!firstRender && metaActions && metaActions.length > 0 && openedEntry) {
      for (const action of metaActions) {
        if (action.action === 'bgdImgChange') {
          reloadBackground();
        } else if (action.action === 'thumbChange') {
          reloadThumbnails();
        }
      }
    }
    // eslint-disable-next-line
  }, [metaActions, openedEntry]);

  function reloadBackground() {
    if (location && openedEntry) {
      location
        .getFolderBgndPath(openedEntry.path, openedEntry.meta?.lastUpdated)
        .then((bgPath) => {
          const bgImage = bgPath ? `url("${bgPath}")` : 'none';
          if (bgImage !== backgroundImage.current) {
            backgroundImage.current = bgImage;
            forceUpdate();
          }
        });
    }
  }

  function reloadThumbnails() {
    if (location && openedEntry) {
      location
        .getThumbPath(
          openedEntry.meta?.thumbPath,
          openedEntry.meta?.lastUpdated,
        )
        .then((thumbPath) => {
          const thbImage = thumbPath
            ? `url("${thumbPath.replace(/#/g, '%23')}")`
            : 'none';
          if (thbImage !== thumbImage.current) {
            thumbImage.current = thbImage;
            forceUpdate();
          }
        });
    }
  }

  useEffect(() => {
    if (editName === entryName && fileNameRef.current) {
      fileNameRef.current.focus();
    }
  }, [editName, entryName]);

  const renameEntry = useCallback(() => {
    if (editName !== undefined && openedEntry) {
      const dirSeparator = location?.getDirSeparator();
      const path = extractContainingDirectoryPath(
        openedEntry.path,
        dirSeparator,
      );
      const nextPath =
        (path && path !== dirSeparator ? path + dirSeparator : '') + editName;

      if (openedEntry.isFile) {
        renameFile(openedEntry.path, nextPath, openedEntry.locationID).catch(
          () => {
            if (fileNameRef.current) fileNameRef.current.value = entryName;
          },
        );
      } else {
        renameDirectory(
          openedEntry.path,
          editName,
          openedEntry.locationID,
        ).catch(() => {
          if (fileNameRef.current) fileNameRef.current.value = entryName;
        });
      }
      setEditName(undefined);
    }
  }, [editName, openedEntry, location, entryName, renameFile, renameDirectory]);

  const activateEditNameField = useCallback(() => {
    if (location?.isReadOnly) {
      setEditName(undefined);
      return;
    }
    setEditName(entryName);
  }, [location, entryName]);

  const deactivateEditNameField = useCallback(() => {
    setEditName(undefined);
    fileNameError.current = false;
    if (fileNameRef.current) {
      fileNameRef.current.value = entryName;
    }
  }, [entryName]);

  const toggleMoveCopyFilesDialog = useCallback(() => {
    if (openedEntry) {
      openMoveCopyFilesDialog([
        {
          ...openedEntry,
          isFile: openedEntry.isFile,
          name: entryName,
          tags: [],
        },
      ]);
    }
  }, [openMoveCopyFilesDialog, openedEntry, entryName]);

  const openThumbFilesDialog = useCallback(() => {
    if (!Pro) {
      showNotification(t('core:thisFunctionalityIsAvailableInPro'));
      return true;
    }
    if (!isEditMode && editName === undefined && thumbDialogContext) {
      thumbDialogContext.openThumbsDialog(openedEntry);
    }
  }, [
    Pro,
    showNotification,
    t,
    isEditMode,
    editName,
    thumbDialogContext,
    openedEntry,
  ]);

  const openBgndImgDialog = useCallback(() => {
    if (!Pro) {
      showNotification(t('core:thisFunctionalityIsAvailableInPro'));
      return true;
    }
    if (!isEditMode && editName === undefined && bgndDialogContext) {
      bgndDialogContext.openBgndDialog(openedEntry);
    }
  }, [
    Pro,
    showNotification,
    t,
    isEditMode,
    editName,
    bgndDialogContext,
    openedEntry,
  ]);

  // MoE detection from `general.size_label` ("8x7B", "256x22B", …).
  // Drives the read-only "Taille des experts" field below.
  const moeExpertSize = useMemo(() => {
    const parsed = parseSizeLabel(modelHeaderForPanel?.sizeLabel);
    return parsed?.perExpert ? formatParamCount(parsed.perExpert) : undefined;
  }, [modelHeaderForPanel]);

  // Header fields promoted to native variables. Numbers (params, ctx, layers,
  // disk, dims, shard count) live as Properties variables; categorical info
  // (format, arch, quant) is also surfaced here for one-glance reading even
  // though it's also available as a tag (`fmt:`, `arch:`, `quant:`).
  const headerFieldRows = useMemo(() => {
    const h = modelHeaderForPanel;
    if (!h) return [] as Array<{ label: string; value: string }>;
    const rows: Array<{ label: string; value: string }> = [];
    if (h.format) {
      rows.push({ label: t('core:modelFormat'), value: h.format });
    }
    if (h.architecture && h.architecture !== 'unknown') {
      rows.push({
        label: t('core:modelArchitecture'),
        value: String(h.architecture),
      });
    }
    if (h.name) rows.push({ label: t('core:modelName'), value: h.name });
    if (h.basename && h.basename !== h.name) {
      rows.push({ label: t('core:modelBasename'), value: h.basename });
    }
    if (h.sizeLabel) {
      rows.push({ label: t('core:modelParameters'), value: h.sizeLabel });
    }
    if (h.quantization) {
      rows.push({ label: t('core:modelQuantization'), value: h.quantization });
    }
    if (h.contextMax) {
      rows.push({
        label: t('core:modelContextMax'),
        value: h.contextMax.toLocaleString(),
      });
    }
    if (h.embeddingDim) {
      rows.push({
        label: t('core:modelEmbeddingDim'),
        value: h.embeddingDim.toLocaleString(),
      });
    }
    if (h.blockCount) {
      rows.push({ label: t('core:modelBlocks'), value: String(h.blockCount) });
    }
    if (h.headCount) {
      rows.push({
        label: t('core:modelAttnHeads'),
        value: String(h.headCount),
      });
    }
    if (h.shardCount && h.shardCount > 1) {
      rows.push({
        label: t('core:shardCount'),
        value: String(h.shardCount),
      });
    }
    return rows;
  }, [modelHeaderForPanel, t]);

  const fileSize = useCallback(() => {
    if (openedEntry?.isFile) {
      // For sharded canonical entries (e.g. shard 1 of 1810), `openedEntry.size`
      // is just shard 1's bytes — wildly misleading. Prefer the freshly-summed
      // aggregate from the shard-size cache when available.
      if (shardAggregateBytes && shardAggregateBytes > 0) {
        return formatBytes(shardAggregateBytes);
      }
      return formatBytes(openedEntry.size);
    } else if (dirProps.current) {
      return formatBytes(dirProps.current.totalSize);
    }
    return t(location?.haveObjectStoreSupport() ? 'core:notAvailable' : '?');
  }, [openedEntry, shardAggregateBytes, t, location]);

  const toggleBackgroundColorPicker = useCallback(() => {
    if (location?.isReadOnly) return;
    if (!Pro) {
      showNotification(t('core:thisFunctionalityIsAvailableInPro'));
      return;
    }
    setDisplayColorPicker((prev) => !prev);
  }, [location, Pro, showNotification, t]);

  const handleChangeColor = useCallback(
    (color) => {
      setBackgroundColorChange(openedEntry, color).then((success) => {
        if (success && openedEntry) {
          openedEntry.meta = { ...openedEntry.meta, color };
        }
      });
    },
    [openedEntry, setBackgroundColorChange],
  );

  const handleFileNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value, name } = event.target;
      if (name === 'name') {
        const initValid = disableConfirmButton.current;
        let noValid;
        if (openedEntry.isFile) {
          noValid = fileNameValidation(value);
        } else {
          noValid = dirNameValidation(value);
        }
        disableConfirmButton.current = noValid;
        if (noValid || initValid !== noValid) {
          fileNameError.current = noValid;
        }
        setEditName(value);
      }
    },
    [openedEntry],
  );

  const handleChange = useCallback(
    (name: string, value: Array<TS.Tag>, action: string) => {
      if (openedEntry && fileChanged) {
        showNotification(
          `You can't edit tags, because '${openedEntry.path}' is opened for editing`,
          'default',
          true,
        );
        return;
      }
      if (action === 'remove-value') {
        if (!value) {
          return removeTagsFromEntry(openedEntry);
        } else {
          return removeTagsFromEntry(openedEntry, value);
        }
      } else if (action === 'clear') {
        return removeTagsFromEntry(openedEntry);
      }
      // create-option or select-option
      const tags =
        openedEntry.tags === undefined
          ? value
          : value.filter(
              (tag) => !openedEntry.tags.some((obj) => obj.title === tag.title),
            );
      return addTagsToFsEntry(openedEntry, tags);
    },
    [
      openedEntry,
      fileChanged,
      showNotification,
      removeTagsFromEntry,
      addTagsToFsEntry,
    ],
  );

  if (!openedEntry || !openedEntry.path || openedEntry.path === '') {
    return <div />;
  }

  const ldtm = openedEntry.lmdt ? formatTimestampLocal(openedEntry.lmdt) : ' ';
  const cdt = openedEntry.cdt
    ? formatTimestampLocal(openedEntry.cdt)
    : undefined;

  const changePerspective = useCallback(
    (event: any) => {
      const perspective = event.target.value;
      openedEntry.meta = {
        ...(openedEntry.meta && openedEntry.meta),
        perspective,
      };
      saveDirectoryPerspective(
        openedEntry,
        perspective,
        openedEntry.locationID,
      );
    },
    [openedEntry, saveDirectoryPerspective],
  );

  let perspectiveDefault = openedEntry.meta?.perspective || 'unspecified';

  // https://github.com/Leaflet/Leaflet/blob/main/src/layer/marker/Icon.Default.js#L22
  const iconFileMarker = useMemo(
    () =>
      new L.Icon({
        iconUrl: MarkerIcon,
        iconRetinaUrl: Marker2xIcon,
        shadowUrl: MarkerShadowIcon,
        tooltipAnchor: [16, -28],
        iconSize: [25, 41],
        shadowSize: [41, 41],
        iconAnchor: [12, 41], // point of the icon which will correspond to marker's location
        shadowAnchor: [5, 41],
        popupAnchor: [1, -34], // point from which the popup should open relative to the iconAnchor
      }),
    [],
  );

  function getGeoLocation(tags: Array<TS.Tag>) {
    if (!Pro) return;
    if (tags) {
      for (let i = 0; i < tags.length; i += 1) {
        const location = parseGeoLocation(tags[i].title);
        if (location !== undefined) {
          return location;
        }
      }
    }
  }

  const geoLocation: any = getGeoLocation(
    openedEntry.isFile ? openedEntry.tags : openedEntry.meta?.tags,
  );

  const isCloudLocation = openedEntry.url && openedEntry.url.length > 5;
  const showLinkForDownloading =
    isCloudLocation && openedEntry.isFile && !openedEntry.isEncrypted;

  // --- RENDER ---
  return (
    <>
      <Grid container>
        <Grid size={12}>
          <TsTextField
            error={fileNameError.current}
            title={isEditMode && t('core:renameDisableTooltip')}
            label={
              openedEntry.isFile ? t('core:fileName') : t('core:folderName')
            }
            slotProps={{
              input: {
                readOnly: editName === undefined,
                endAdornment: (
                  <InputAdornment position="end">
                    {!location.isReadOnly && !isEditMode && (
                      <Box sx={{ textAlign: 'right' }}>
                        {editName !== undefined ? (
                          <>
                            <TsButton
                              data-tid="cancelRenameEntryTID"
                              onClick={deactivateEditNameField}
                              variant="text"
                            >
                              {t('core:cancel')}
                            </TsButton>
                            <TsButton
                              data-tid="confirmRenameEntryTID"
                              onClick={renameEntry}
                              variant="text"
                              disabled={disableConfirmButton.current}
                            >
                              {t('core:confirmSaveButton')}
                            </TsButton>
                          </>
                        ) : (
                          <TsButton
                            data-tid="startRenameEntryTID"
                            variant="text"
                            onClick={activateEditNameField}
                          >
                            {t('core:rename')}
                          </TsButton>
                        )}
                      </Box>
                    )}
                  </InputAdornment>
                ),
              },
            }}
            name="name"
            data-tid="fileNameProperties"
            defaultValue={entryName}
            inputRef={fileNameRef}
            retrieveValue={() => fileNameRef.current.value}
            onClick={() => {
              if (!isEditMode && editName === undefined) {
                activateEditNameField();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !fileNameError.current) {
                renameEntry();
              } else if (event.key === 'Escape') {
                deactivateEditNameField();
              }
            }}
            onChange={handleFileNameChange}
          />
          {fileNameError.current && (
            <FormHelperText sx={{ marginTop: 0 }}>
              {t(
                'core:' +
                  (openedEntry.isFile ? 'fileNameHelp' : 'directoryNameHelp'),
              )}
            </FormHelperText>
          )}
        </Grid>
        <Grid size={12}>
          <TagDropContainer entry={openedEntry}>
            <TagsSelect
              label={t('core:fileTags')}
              dataTid="PropertiesTagsSelectTID"
              placeholderText={t('core:dropHere')}
              tags={getAllTags(openedEntry, tagDelimiter)}
              tagMode="default"
              handleChange={handleChange}
              selectedEntry={openedEntry}
              // autoFocus={true}
              generateButton={true}
              extraEndAdornment={
                isModelFile ? (
                  <TsButton
                    variant="text"
                    onClick={modelhubActions.regenerateTags}
                    disabled={
                      modelhubActions.busy !== 'idle' || location?.isReadOnly
                    }
                    startIcon={
                      modelhubActions.busy === 'regenerate' ? undefined : (
                        <RefreshIcon />
                      )
                    }
                    loading={modelhubActions.busy === 'regenerate'}
                    tooltip={t('core:modelhubRegenerateTagsTooltip')}
                    data-tid="modelhubRegenerateTagsTID"
                  >
                    {t('core:modelhubRegenerateTags')}
                  </TsButton>
                ) : undefined
              }
            />
          </TagDropContainer>
          {isModelFile && (modelhubActions.error || modelhubActions.info) && (
            <Typography
              variant="caption"
              color={modelhubActions.error ? 'error' : 'text.secondary'}
              sx={{ mt: 0.5, display: 'block' }}
            >
              {modelhubActions.error ?? modelhubActions.info}
            </Typography>
          )}
        </Grid>

        {geoLocation && (
          <Grid size={12}>
            <MapContainer
              style={{
                height: '200px',
                width: '99%',
                margin: 2,
                marginTop: 8,
                borderRadius: AppConfig.defaultCSSRadius,
              }}
              doubleClickZoom={true}
              keyboard={false}
              dragging={true}
              center={geoLocation}
              zoom={10}
              scrollWheelZoom={false}
              zoomControl={true}
              attributionControl={false}
            >
              {tileServer ? (
                <ElectronTileLayer
                  attribution={sanitizeAttribution(tileServer.serverInfo)}
                  url={tileServer.serverURL}
                />
              ) : (
                <NoTileServer />
              )}
              <LayerGroup>
                <Marker
                  icon={iconFileMarker}
                  position={[geoLocation.lat, geoLocation.lng]}
                >
                  <Popup>
                    <Box
                      sx={{
                        marginBottom: '-15px',
                        marginTop: '-22px',
                        marginLeft: '-22px',
                        marginRight: '-25px',
                        padding: '10px',
                        backgroundColor: 'background.default',
                        borderRadius: AppConfig.defaultCSSRadius,
                      }}
                    >
                      <Typography sx={{ color: 'text.primary' }}>
                        {`${t('core:lat')}: ${geoLocation.lat}, ${t('core:lng')}: ${geoLocation.lng}`}
                      </Typography>
                      <Box sx={{ display: 'inline-flex' }}>
                        <TsButton
                          onClick={() => {
                            openUrl(
                              `https://www.openstreetmap.org/?mlat=${geoLocation.lat}&mlon=${geoLocation.lng}#map=10/${geoLocation.lat}/${geoLocation.lng}`,
                            );
                          }}
                        >
                          {t('core:openInApp', { appName: 'OpenStreetMap' })}
                        </TsButton>
                        <TsButton
                          sx={{
                            marginLeft: AppConfig.defaultSpaceBetweenButtons,
                          }}
                          onClick={() => {
                            openUrl(
                              `https://maps.google.com/?q=${geoLocation.lat},${geoLocation.lng}&ll=${geoLocation.lat},${geoLocation.lng}&z=10`,
                            );
                          }}
                        >
                          {t('core:openInApp', { appName: 'Google Maps' })}
                        </TsButton>
                      </Box>
                    </Box>
                  </Popup>
                </Marker>
              </LayerGroup>
              <AttributionControl position="bottomright" prefix="" />
            </MapContainer>
          </Grid>
        )}

        <Grid size={12}>
          <TsTextField
            value={ldtm}
            label={t('core:fileLDTM')}
            retrieveValue={() => ldtm}
            slotProps={{
              input: {
                readOnly: true,
                startAdornment: (
                  <InputAdornment position="start">
                    <CalendarIcon />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Grid>

        {AppConfig.isElectron && cdt && (
          <Grid size={12}>
            <TsTextField
              value={cdt}
              label={t('core:creationDate')}
              retrieveValue={() => cdt}
              slotProps={{
                input: {
                  readOnly: true,
                  startAdornment: (
                    <InputAdornment position="start">
                      <CalendarIcon />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Grid>
        )}

        <Grid size={12}>
          <Tooltip
            title={
              !location?.haveObjectStoreSupport() &&
              dirProps.current &&
              !openedEntry.isFile &&
              dirProps.current.dirsCount +
                ' ' +
                t('core:directories') +
                ', ' +
                dirProps.current.filesCount +
                ' ' +
                t('core:files')
            }
          >
            <TsTextField
              value={fileSize()}
              retrieveValue={() => fileSize()}
              label={t('core:fileSize')}
              slotProps={{
                input: {
                  readOnly: true,
                  startAdornment: (
                    <InputAdornment position="start">
                      <SizeIcon />
                    </InputAdornment>
                  ),
                  ...(!openedEntry.isFile && {
                    endAdornment: (
                      <TsButton
                        variant="text"
                        onClick={() =>
                          getOpenedDirProps().then((props) => {
                            dirProps.current = props;
                            forceUpdate();
                          })
                        }
                      >
                        {t('core:calculate')}
                      </TsButton>
                    ),
                  }),
                },
              }}
            />
          </Tooltip>
        </Grid>

        {moeExpertSize && (
          <Grid size={12}>
            <TsTextField
              value={moeExpertSize}
              retrieveValue={() => moeExpertSize}
              label={t('core:expertSize')}
              slotProps={{
                input: {
                  readOnly: true,
                  startAdornment: (
                    <InputAdornment position="start">
                      <SizeIcon />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Grid>
        )}

        {headerFieldRows.map((row) => (
          <Grid key={row.label} size={12}>
            <TsTextField
              value={row.value}
              retrieveValue={() => row.value}
              label={row.label}
              slotProps={{ input: { readOnly: true } }}
            />
          </Grid>
        ))}

        <Grid size={12}>
          <FormControl fullWidth={true}>
            <TsTextField
              name="path"
              title={openedEntry.url || openedEntry.path}
              label={isCloudLocation ? t('cloudPath') : t('core:filePath')}
              data-tid="filePathProperties"
              value={openedEntry.path || ''}
              retrieveValue={() => openedEntry.path}
              slotProps={{
                input: {
                  readOnly: true,
                  startAdornment: (
                    <InputAdornment position="start">
                      {isCloudLocation ? (
                        <CloudLocationIcon
                          sx={{ color: theme.palette.text.secondary }}
                        />
                      ) : (
                        <LocalLocationIcon
                          sx={{ color: theme.palette.text.secondary }}
                        />
                      )}
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      {!location.isReadOnly &&
                        !isEditMode &&
                        editName === undefined && (
                          <TsButton
                            data-tid="moveCopyEntryTID"
                            onClick={toggleMoveCopyFilesDialog}
                            variant="text"
                          >
                            {t('core:moveFile')}
                          </TsButton>
                        )}
                    </InputAdornment>
                  ),
                },
              }}
            />
          </FormControl>
        </Grid>

        <Grid size={12}>
          <TsTextField
            data-tid="sharingLinkTID"
            name="sharinglink"
            label={<>{t('core:sharingLink')}</>}
            value={sharingLink}
            inputRef={sharingLinkRef}
            slotProps={{
              input: {
                readOnly: true,
                startAdornment: (
                  <InputAdornment position="start">
                    <OpenLinkIcon />
                  </InputAdornment>
                ),
                endAdornment: (
                  <InputAdornment position="end">
                    <TsButton
                      tooltip={t('core:copyLinkToClipboard')}
                      data-tid="copyLinkToClipboardTID"
                      variant="text"
                      onClick={() => {
                        const entryTitle = extractTitle(
                          openedEntry.name,
                          !openedEntry.isFile,
                          location?.getDirSeparator(),
                        );
                        const clipboardItem = generateClipboardLink(
                          sharingLink,
                          entryTitle,
                        );
                        const promise =
                          navigator.clipboard.write(clipboardItem);
                        showNotification(t('core:linkCopied'));
                      }}
                    >
                      {t('core:copy')}
                    </TsButton>
                    <InfoIcon tooltip={t('core:sharingLinkTooltip')} />
                  </InputAdornment>
                ),
              },
            }}
          />
          {showLinkForDownloading && (
            <Grid size={12}>
              <TsTextField
                name="downloadLink"
                label={<>{t('core:downloadLink')}</>}
                value={' '}
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <TsButton
                          tooltip={t('core:generateDownloadLink')}
                          onClick={() => setShowSharingLinkDialog(true)}
                          variant="text"
                        >
                          {t('core:generateDownloadLink')}
                        </TsButton>
                        <InfoIcon tooltip={t('core:downloadLinkTooltip')} />
                      </InputAdornment>
                    ),
                    startAdornment: (
                      <InputAdornment position="start">
                        <QrCodeIcon />
                      </InputAdornment>
                    ),
                  },
                }}
              />
            </Grid>
          )}
        </Grid>

        {!openedEntry.isFile && (
          <Grid size={12}>
            <PerspectiveSelector
              onChange={changePerspective}
              defaultValue={perspectiveDefault}
              label={t('core:choosePerspective')}
              testId="changePerspectiveTID"
            />
          </Grid>
        )}
        {!openedEntry.isFile && (
          <Grid size={12} sx={{ marginTop: '5px' }}>
            <TsTextField
              name="path"
              label={<>{t('core:backgroundColor')}</>}
              slotProps={{
                input: {
                  readOnly: true,
                  startAdornment: (
                    <InputAdornment position="start">
                      <TransparentBackground>
                        <TsButton
                          tooltip={t('editBackgroundColor')}
                          fullWidth
                          sx={{
                            width: 160,
                            height: 25,
                            background: openedEntry.meta?.color,
                            border: '1px solid lightgray',
                          }}
                          onClick={toggleBackgroundColorPicker}
                        >
                          &nbsp;
                        </TsButton>
                      </TransparentBackground>
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <Box>
                        <ProTooltip tooltip={t('changeBackgroundColor')}>
                          <TsIconButton
                            data-tid="changeBackgroundColorTID"
                            aria-describedby={popoverId}
                            onClick={handlePopoverClick}
                            disabled={!Pro}
                          >
                            <ColorPaletteIcon />
                          </TsIconButton>
                        </ProTooltip>
                        <Popover
                          open={popoverOpen}
                          onClose={handlePopoverClose}
                          anchorEl={popoverAnchorEl}
                          id={popoverId}
                          anchorOrigin={{
                            vertical: 'top',
                            horizontal: 'center',
                          }}
                          transformOrigin={{
                            vertical: 'bottom',
                            horizontal: 'center',
                          }}
                        >
                          <Box sx={{ padding: '10px' }}>
                            {AppConfig.backgroundColors.map(
                              (background, cnt) => (
                                <>
                                  <TsIconButton
                                    key={cnt}
                                    data-tid={'backgroundTID' + cnt}
                                    aria-label="changeFolderBackround"
                                    onClick={() => {
                                      handleChangeColor(background);
                                      handlePopoverClose();
                                    }}
                                  >
                                    <Box
                                      sx={{
                                        width: '35px',
                                        paddingTop: '5px',
                                        borderRadius:
                                          AppConfig.defaultCSSRadius,
                                        backgroundColor: background,
                                        backgroundImage: background,
                                      }}
                                    >
                                      <SetColorIcon />
                                    </Box>
                                  </TsIconButton>
                                  {cnt % 4 === 3 && <br />}
                                </>
                              ),
                            )}
                          </Box>
                        </Popover>
                      </Box>
                      {openedEntry.meta && openedEntry.meta.color && (
                        <>
                          <ProTooltip tooltip={t('clearFolderColor')}>
                            <TsIconButton
                              data-tid={'backgroundClearTID'}
                              disabled={!Pro}
                              aria-label="clear"
                              onClick={() =>
                                openConfirmDialog(
                                  t('core:confirm'),
                                  t('core:confirmResetColor'),
                                  (result) => {
                                    if (result) {
                                      handleChangeColor('transparent');
                                    }
                                  },
                                  'cancelConfirmResetColorDialog',
                                  'confirmConfirmResetColorDialog',
                                  'confirmResetColorDialogContent',
                                )
                              }
                            >
                              <ClearColorIcon />
                            </TsIconButton>
                          </ProTooltip>
                        </>
                      )}
                      <InfoIcon tooltip={t('core:backgroundColorInfo')} />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Grid>
        )}
        {/* Models Hub: the Thumbnail block was removed — useless for the
            target use case (no preview of a 50 GB GGUF, and we already
            display rich header metadata in the ModelHub panel). The
            Background-image block is kept for folders since it's a
            location-level decoration. */}
        {!openedEntry.isFile && (
          <Grid container spacing={1} size={12}>
            <Grid size={12}>
              <FormHelperText>{t('core:backgroundImage')}</FormHelperText>
              <ThumbnailTextField
                margin="dense"
                fullWidth
                sx={{
                  marginTop: 0,
                }}
                variant="outlined"
                slotProps={{
                  input: {
                    readOnly: true,
                    startAdornment: (
                      <InputAdornment position="end">
                        <Stack
                          direction="column"
                          spacing={0}
                          sx={{ alignItems: 'center' }}
                        >
                          {!location.isReadOnly &&
                            !isEditMode &&
                            editName === undefined && (
                              <ProTooltip tooltip={t('changeBackgroundImage')}>
                                <TsButton
                                  data-tid="changeBackgroundImageTID"
                                  fullWidth
                                  variant="text"
                                  onClick={openBgndImgDialog}
                                >
                                  {t('core:change')}
                                </TsButton>
                              </ProTooltip>
                            )}
                          <Box
                            data-tid="propsBgnImageTID"
                            role="button"
                            tabIndex={0}
                            sx={{
                              backgroundSize: 'cover',
                              backgroundRepeat: 'no-repeat',
                              backgroundImage: backgroundImage.current,
                              backgroundPosition: 'center',
                              borderRadius: AppConfig.defaultCSSRadius,
                              minHeight: 150,
                              minWidth: 150,
                              marginBottom: '5px',
                            }}
                            onClick={openBgndImgDialog}
                          />
                        </Stack>
                      </InputAdornment>
                    ),
                  },
                }}
              />
            </Grid>
          </Grid>
        )}
        <Grid size={12}>
          <TsTextField
            data-tid="entryIDTID"
            name="entryid"
            label={t('core:entryId')}
            value={openedEntry?.meta?.id}
            retrieveValue={() => openedEntry?.meta?.id}
            slotProps={{
              input: {
                readOnly: true,
                startAdornment: (
                  <InputAdornment position="start">
                    <IDIcon />
                  </InputAdornment>
                ),
                endAdornment: (
                  <InputAdornment position="end">
                    <TsButton
                      tooltip={t('core:copyIdToClipboard')}
                      data-tid="copyIdToClipboardTID"
                      variant="text"
                      disabled={!openedEntry?.meta?.id}
                      onClick={() => {
                        const entryId = openedEntry?.meta?.id;
                        if (entryId) {
                          const clibboardItem = generateClipboardLink(
                            entryId,
                            entryId,
                          );
                          const promise =
                            navigator.clipboard.write(clibboardItem);
                          showNotification(t('core:entryIdCopied'));
                        }
                      }}
                    >
                      {t('core:copy')}
                    </TsButton>
                    <InfoIcon tooltip={t('core:entryIdTooltip')} />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Grid>
      </Grid>
      {showSharingLinkDialog && (
        <LinkGeneratorDialog
          open={showSharingLinkDialog}
          onClose={() => setShowSharingLinkDialog(false)}
        />
      )}
      {CustomBackgroundDialog && (
        <CustomBackgroundDialog
          color={openedEntry.meta?.color}
          open={displayColorPicker}
          setColor={handleChangeColor}
          onClose={toggleBackgroundColorPicker}
          currentDirectoryPath={openedEntry.path}
        />
      )}
    </>
  );
}

export default EntryProperties;
