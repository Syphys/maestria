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
import {
  AddExistingFileIcon,
  ArrowDropDownIcon,
  AudioFileIcon,
  CreateFileIcon,
  DownloadIcon,
  HTMLFileIcon,
  HelpIcon,
  LinkFileIcon,
  LocalLocationIcon,
  MarkdownFileIcon,
  NewFileIcon,
  NewFolderIcon,
  OpenLinkIcon,
  OpenNewWindowIcon,
  RecentThingsIcon,
  SettingsIcon,
  TagLibraryIcon,
  TemplateFileIcon,
  ThemingIcon,
  WorkspacesIcon,
} from '-/components/CommonIcons';
import CustomLogo from '-/components/CustomLogo';
import HelpFeedbackPanel from '-/components/HelpFeedbackPanel';
import InfoIcon from '-/components/InfoIcon';
import LocationManager from '-/components/LocationManager';
import RunningModelsPanel from '-/modelhub/RunningModelsPanel';
import CharacterizeAllPanel from '-/modelhub/CharacterizeAllPanel';
import StoredSearches from '-/components/StoredSearches';
import TagLibrary from '-/components/TagLibrary';
import TsButton from '-/components/TsButton';
import TsMenuList from '-/components/TsMenuList';
import TsToolbarButton from '-/components/TsToolbarButton';
import { useCreateDirectoryDialogContext } from '-/components/dialogs/hooks/useCreateDirectoryDialogContext';
import { useCreateEditLocationDialogContext } from '-/components/dialogs/hooks/useCreateEditLocationDialogContext';
import { useDownloadUrlDialogContext } from '-/components/dialogs/hooks/useDownloadUrlDialogContext';
import { useLinkDialogContext } from '-/components/dialogs/hooks/useLinkDialogContext';
import { useNewAudioDialogContext } from '-/components/dialogs/hooks/useNewAudioDialogContext';
import { useNewFileDialogContext } from '-/components/dialogs/hooks/useNewFileDialogContext';
import { useSettingsDialogContext } from '-/components/dialogs/hooks/useSettingsDialogContext';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useFileUploadContext } from '-/hooks/useFileUploadContext';
import { usePanelsContext } from '-/hooks/usePanelsContext';
import { Pro } from '-/pro';
import { AppDispatch } from '-/reducers/app';
import {
  actions as SettingsActions,
  getKeyBindingObject,
  isDesktopMode,
} from '-/reducers/settings';
import { createNewInstance } from '-/services/utils-io';
import { TS } from '-/tagspaces.namespace';
import { ClickAwayListener, Divider } from '@mui/material';
import Box from '@mui/material/Box';
import ButtonGroup from '@mui/material/ButtonGroup';
import Grow from '@mui/material/Grow';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import { alpha, useTheme } from '@mui/material/styles';
import React, {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import TsIconButton from './TsIconButton';

interface Props {
  hideDrawer?: () => void;
  width?: number;
}

function MobileNavigation(props: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const desktopMode = useSelector(isDesktopMode);
  const dispatch: AppDispatch = useDispatch();
  const { setSelectedLocation, currentLocation, locations } =
    useCurrentLocationContext();
  const { currentDirectoryPath } = useDirectoryContentContext();
  const { openFileUpload } = useFileUploadContext();
  const { openCreateEditLocationDialog } = useCreateEditLocationDialogContext();
  const { openCreateDirectoryDialog } = useCreateDirectoryDialogContext();
  const { openNewFileDialog } = useNewFileDialogContext();
  const { openNewAudioDialog } = useNewAudioDialogContext();
  const { openSettingsDialog } = useSettingsDialogContext();
  const { openLinkDialog } = useLinkDialogContext();
  const { currentOpenedPanel, showPanel } = usePanelsContext();
  const { openDownloadUrl } = useDownloadUrlDialogContext();
  const keyBindings = useSelector(getKeyBindingObject);
  const { hideDrawer, width } = props;
  const switchTheme = useCallback(
    () => dispatch(SettingsActions.switchTheme()),
    [dispatch],
  );
  const [openedCreateMenu, setOpenCreateMenu] = useState(false);
  const [openedWorkSpaceMenu, setOpenWorkSpaceMenu] = useState(false);
  /**
   * Height of the Console (in pixels) at the bottom of the sidebar.
   * The nav area above takes the remaining vertical space; the toolbar
   * is anchored just above the Console at its content height. A custom
   * row-resize handle between the toolbar and the Console lets the user
   * grow/shrink the Console. Persisted in localStorage.
   */
  const SIDEBAR_CONSOLE_HEIGHT_KEY = 'modelhub.sidebarConsoleHeight';
  const [consoleHeight, setConsoleHeight] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_CONSOLE_HEIGHT_KEY);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 80 ? n : 180;
    } catch {
      return 180;
    }
  });
  const consoleDragRef = useRef<{
    startY: number;
    startHeight: number;
  } | null>(null);
  const onConsoleHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      consoleDragRef.current = {
        startY: e.clientY,
        startHeight: consoleHeight,
      };
      setConsoleHandleDragging(true);
    },
    [consoleHeight],
  );
  const onConsoleHandleMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!consoleDragRef.current) return;
      const dy = consoleDragRef.current.startY - e.clientY; // up = positive
      const next = Math.max(80, consoleDragRef.current.startHeight + dy);
      setConsoleHeight(next);
    },
    [],
  );
  const [consoleHandleDragging, setConsoleHandleDragging] = useState(false);
  const onConsoleHandleUp = useCallback(() => {
    if (!consoleDragRef.current) return;
    consoleDragRef.current = null;
    setConsoleHandleDragging(false);
    try {
      window.localStorage.setItem(
        SIDEBAR_CONSOLE_HEIGHT_KEY,
        String(consoleHeight),
      );
    } catch {
      /* private mode / disabled storage — ignore */
    }
  }, [consoleHeight]);
  const anchorWSpaceRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const workSpacesContext = Pro?.contextProviders?.WorkSpacesContext
    ? useContext<TS.WorkSpacesContextData>(
        Pro.contextProviders.WorkSpacesContext,
      )
    : undefined;
  const workSpaces: TS.WorkSpace[] = workSpacesContext?.getWorkSpaces() ?? [];

  const handleToggle = useCallback(
    () => setOpenCreateMenu((prev) => !prev),
    [],
  );
  const handleToggleWorkSpaces = useCallback(
    () => setOpenWorkSpaceMenu((prev) => !prev),
    [],
  );
  const handleClose = useCallback((event: Event) => {
    if (
      anchorRef.current &&
      anchorRef.current.contains(event.target as HTMLElement)
    )
      return;
    setOpenCreateMenu(false);
  }, []);
  const handleCloseWSpace = useCallback((event: Event) => {
    if (
      anchorWSpaceRef.current &&
      anchorWSpaceRef.current.contains(event.target as HTMLElement)
    )
      return;
    setOpenWorkSpaceMenu(false);
  }, []);

  // Memoize workspace menu items for performance
  const workspaceMenuItems = useMemo(
    () => [
      <MenuItem
        key="allWSpace"
        data-tid={'wSpaceAllTID'}
        onClick={() => {
          workSpacesContext?.setCurrentWorkSpaceId(undefined);
          setOpenWorkSpaceMenu(false);
        }}
      >
        <ListItemIcon>
          <WorkspacesIcon />
        </ListItemIcon>
        <ListItemText primary={t('all')} />
      </MenuItem>,
      ...workSpaces.map((wSpace) => (
        <MenuItem
          key={wSpace.uuid}
          data-tid={'wSpace' + wSpace.shortName + 'TID'}
          onClick={() => {
            workSpacesContext?.setCurrentWorkSpaceId(wSpace.uuid);
            setOpenWorkSpaceMenu(false);
          }}
        >
          <ListItemIcon>
            <WorkspacesIcon />
          </ListItemIcon>
          <ListItemText primary={`${wSpace.fullName} - ${wSpace.shortName}`} />
        </MenuItem>
      )),
    ],
    [workSpaces, t, workSpacesContext],
  );

  return (
    <Box
      sx={{
        background: alpha(theme.palette.background.default, 0.85),
        backdropFilter: 'blur(5px)',
        height: '100%',
        overflow: 'hidden',
        width: width || 320,
        maxWidth: width || 320,
        // Flex column so the bottom (ModelhubGlobalStatus + toolbar)
        // auto-sizes to its content and the top scroll area takes the
        // rest. The previous fixed `calc(100% - 110px)` reservation
        // didn't grow when the Running-models panel added rows, leaving
        // them clipped off-screen.
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          // Take the remaining vertical space; minHeight: 0 is the
          // standard flex idiom that lets a flex child shrink below
          // its content size so its own overflow can scroll. The
          // <Split> below splits this area between the main panel
          // scroller (top) and the Console (bottom of sidebar).
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          sx={{
            // Scrollable nav area — takes all remaining vertical
            // space above the pinned toolbar + Console block. No
            // top splitter anymore: the toolbar is anchored at its
            // content height and only the Console below it is
            // user-resizable (via the custom row-resize handle).
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <Box>
            <CustomLogo />
            <Box
              sx={{
                width: '100%',
                justifyContent: 'center',
                paddingLeft: '10px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <ButtonGroup
                aria-label="split button"
                sx={{
                  textAlign: 'center',
                  marginLeft: '5px',
                  marginRight: '5px',
                }}
              >
                <TsButton
                  ref={anchorRef}
                  aria-controls={
                    openedCreateMenu ? 'split-button-menu' : undefined
                  }
                  aria-expanded={openedCreateMenu ? 'true' : undefined}
                  aria-haspopup="menu"
                  data-tid="createNewDropdownButtonTID"
                  onClick={handleToggle}
                  startIcon={<CreateFileIcon />}
                  endIcon={<ArrowDropDownIcon />}
                  sx={{
                    borderRadius: 'unset',
                    borderTopLeftRadius: AppConfig.defaultCSSRadius,
                    borderBottomLeftRadius: AppConfig.defaultCSSRadius,
                  }}
                >
                  <Box
                    sx={{
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      maxWidth: 100,
                    }}
                  >
                    {t('core:new')}
                  </Box>
                </TsButton>
                {workSpaces && workSpaces.length > 0 && (
                  <TsButton
                    ref={anchorWSpaceRef}
                    tooltip={t('currentWorkspace')}
                    aria-controls={
                      openedWorkSpaceMenu ? 'create-wspace-menu' : undefined
                    }
                    aria-expanded={openedWorkSpaceMenu ? 'true' : undefined}
                    aria-haspopup="menu"
                    data-tid="openedWorkSpaceMenuButtonTID"
                    onClick={handleToggleWorkSpaces}
                    endIcon={<ArrowDropDownIcon />}
                    sx={{ borderRadius: 'unset' }}
                  >
                    <Box
                      sx={{
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        maxWidth: 100,
                      }}
                    >
                      {workSpacesContext?.getCurrentWorkSpace()?.shortName ||
                        t('core:all')}
                    </Box>
                  </TsButton>
                )}
                <TsButton
                  tooltip={t('core:openSharingLink')}
                  data-tid="openLinkNavigationTID"
                  onClick={openLinkDialog}
                  sx={{
                    borderRadius: 'unset',
                    borderTopRightRadius: AppConfig.defaultCSSRadius,
                    borderBottomRightRadius: AppConfig.defaultCSSRadius,
                  }}
                >
                  <OpenLinkIcon />
                </TsButton>
              </ButtonGroup>
              <TsIconButton
                tooltip={t('core:switchTheme')}
                data-tid="switchTheme"
                onClick={switchTheme}
              >
                <ThemingIcon />
              </TsIconButton>
              <TsIconButton
                tooltip={t('core:settings')}
                id="verticalNavButton"
                data-tid="settings"
                onClick={() => openSettingsDialog()}
                title={t('core:settings')}
              >
                <SettingsIcon />
              </TsIconButton>
            </Box>
          </Box>
          {workSpaces && workSpaces.length > 0 && (
            <ClickAwayListener onClickAway={handleCloseWSpace}>
              <Popper
                anchorEl={anchorWSpaceRef.current}
                sx={{ zIndex: 1 }}
                open={openedWorkSpaceMenu}
                role={undefined}
                transition
                disablePortal
              >
                {({ TransitionProps, placement }) => (
                  <Grow
                    {...TransitionProps}
                    style={{
                      transformOrigin:
                        placement === 'bottom' ? 'center top' : 'center bottom',
                    }}
                  >
                    <Paper>
                      <TsMenuList id="create-file-menu" autoFocusItem>
                        {workspaceMenuItems}
                      </TsMenuList>
                    </Paper>
                  </Grow>
                )}
              </Popper>
            </ClickAwayListener>
          )}
          <ClickAwayListener onClickAway={handleClose}>
            <Popper
              sx={{ zIndex: 1 }}
              open={openedCreateMenu}
              anchorEl={anchorRef.current}
              role={undefined}
              transition
              disablePortal
            >
              {({ TransitionProps, placement }) => (
                <Grow
                  {...TransitionProps}
                  style={{
                    transformOrigin:
                      placement === 'bottom' ? 'center top' : 'center bottom',
                  }}
                >
                  <Paper>
                    <TsMenuList id="nav-create-menu" autoFocusItem>
                      <MenuItem
                        key="navCreateNewTextFile"
                        data-tid="navCreateNewTextFileTID"
                        onClick={() => {
                          openNewFileDialog('txt');
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <NewFileIcon />
                        </ListItemIcon>
                        <ListItemText primary={t('core:createTextFile')} />
                      </MenuItem>
                      <MenuItem
                        key="navCreateNewMarkdownFile"
                        data-tid="navCreateNewMarkdownFileTID"
                        onClick={() => {
                          openNewFileDialog('md');
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <MarkdownFileIcon />
                        </ListItemIcon>
                        <ListItemText primary={t('core:createMarkdown')} />
                        <InfoIcon tooltip={t('core:createMarkdownTitle')} />
                      </MenuItem>
                      <MenuItem
                        key="navCreateHTMLTextFile"
                        data-tid="navCreateHTMLTextFileTID"
                        onClick={() => {
                          openNewFileDialog('html');
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <HTMLFileIcon />
                        </ListItemIcon>
                        <ListItemText primary={t('core:createRichTextFile')} />
                        <InfoIcon tooltip={t('core:createNoteTitle')} />
                      </MenuItem>
                      <MenuItem
                        key="navCreateNewLinkFile"
                        data-tid="navCreateNewLinkFileTID"
                        onClick={() => {
                          openNewFileDialog('url');
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <LinkFileIcon />
                        </ListItemIcon>
                        <ListItemText primary={t('core:createLinkFile')} />
                      </MenuItem>
                      <MenuItem
                        key="navCreateNewAudio"
                        data-tid="navCreateNewAudioTID"
                        disabled={!Pro}
                        onClick={() => {
                          openNewAudioDialog();
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <AudioFileIcon />
                        </ListItemIcon>
                        <ListItemText
                          primary={<>{t('core:newAudioRecording')}</>}
                        />
                      </MenuItem>
                      <MenuItem
                        key="navCreateFileFromTemplate"
                        data-tid="navCreateFileFromTemplateTID"
                        disabled={!Pro}
                        onClick={() => {
                          openNewFileDialog();
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <TemplateFileIcon />
                        </ListItemIcon>
                        <ListItemText
                          primary={<>{t('core:createNewFromTemplate')}</>}
                        />
                      </MenuItem>
                      <Divider />
                      <MenuItem
                        key="addUploadFiles"
                        data-tid="addUploadFilesTID"
                        onClick={() => {
                          openFileUpload(currentDirectoryPath);
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <AddExistingFileIcon />
                        </ListItemIcon>
                        <ListItemText primary={t('core:addFiles')} />
                      </MenuItem>
                      {AppConfig.isElectron &&
                        !currentLocation?.haveObjectStoreSupport() && (
                          <MenuItem
                            key="newFromDownloadURL"
                            data-tid="newFromDownloadURLTID"
                            onClick={() => {
                              openDownloadUrl();
                              setOpenCreateMenu(false);
                              hideDrawer?.();
                            }}
                          >
                            <ListItemIcon>
                              <DownloadIcon />
                            </ListItemIcon>
                            <ListItemText
                              primary={t('core:newFromDownloadURL')}
                            />
                          </MenuItem>
                        )}
                      <Divider />
                      <MenuItem
                        key="createNewFolder"
                        data-tid="createNewFolderTID"
                        onClick={() => {
                          openCreateDirectoryDialog();
                          setOpenCreateMenu(false);
                          hideDrawer?.();
                        }}
                      >
                        <ListItemIcon>
                          <NewFolderIcon />
                        </ListItemIcon>
                        <ListItemText primary={t('core:createDirectory')} />
                      </MenuItem>
                      <Divider />
                      {!AppConfig.ExtLocationsReadOnly && (
                        <MenuItem
                          key="createNewLocation"
                          data-tid="createNewLocationTID"
                          onClick={() => {
                            setSelectedLocation(undefined);
                            openCreateEditLocationDialog();
                            setOpenCreateMenu(false);
                            hideDrawer?.();
                          }}
                        >
                          <ListItemIcon>
                            <LocalLocationIcon />
                          </ListItemIcon>
                          <ListItemText primary={t('core:createLocation')} />
                        </MenuItem>
                      )}
                      {!AppConfig.isNativeMobile && (
                        <MenuItem
                          key="createWindow"
                          data-tid="createWindowTID"
                          onClick={() => {
                            createNewInstance();
                            setOpenCreateMenu(false);
                          }}
                        >
                          <ListItemIcon>
                            <OpenNewWindowIcon />
                          </ListItemIcon>
                          <ListItemText primary={t('core:newWindow')} />
                        </MenuItem>
                      )}
                    </TsMenuList>
                  </Paper>
                </Grow>
              )}
            </Popper>
          </ClickAwayListener>
          <LocationManager
            reduceHeightBy={desktopMode ? 150 : 180}
            show={currentOpenedPanel === 'locationManagerPanel'}
          />
          {currentOpenedPanel === 'tagLibraryPanel' && (
            <TagLibrary reduceHeightBy={desktopMode ? 140 : 170} />
          )}
          {currentOpenedPanel === 'searchPanel' && (
            <StoredSearches reduceHeightBy={desktopMode ? 140 : 165} />
          )}
          {currentOpenedPanel === 'helpFeedbackPanel' && (
            <HelpFeedbackPanel reduceHeightBy={desktopMode ? 150 : 175} />
          )}
        </Box>
        <Box
          sx={{
            // Pinned bottom block: toolbar anchored at its content
            // height, then a custom row-resize handle, then the Console
            // at a state-controlled height. The scrollable nav area
            // above absorbs all remaining vertical space.
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: theme.palette.background.default,
          }}
        >
          <Box
            sx={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <TsToolbarButton
                title={t('core:locationManager')}
                tooltip={t('core:locationManager')}
                keyBinding={keyBindings['showLocationManager']}
                onClick={() => showPanel('locationManagerPanel')}
                sx={{
                  backgroundColor:
                    currentOpenedPanel === 'locationManagerPanel'
                      ? theme.palette.primary.light
                      : theme.palette.background.default,
                }}
                data-tid="locationManager"
              >
                <LocalLocationIcon />
              </TsToolbarButton>
              <TsToolbarButton
                data-tid="tagLibrary"
                title={t('core:tags')}
                tooltip={t('core:tagLibrary')}
                keyBinding={keyBindings['showTagLibrary']}
                onClick={() => showPanel('tagLibraryPanel')}
                sx={{
                  backgroundColor:
                    currentOpenedPanel === 'tagLibraryPanel'
                      ? theme.palette.primary.light
                      : theme.palette.background.default,
                }}
              >
                <TagLibraryIcon />
              </TsToolbarButton>
              <TsToolbarButton
                title={t('core:quickAccess')}
                tooltip={t('core:quickAccess')}
                data-tid="quickAccessButton"
                onClick={() => showPanel('searchPanel')}
                sx={{
                  backgroundColor:
                    currentOpenedPanel === 'searchPanel'
                      ? theme.palette.primary.light
                      : theme.palette.background.default,
                }}
              >
                <RecentThingsIcon />
              </TsToolbarButton>
              <TsToolbarButton
                tooltip={t('core:helpFeedback')}
                title={t('core:help')}
                data-tid="helpFeedback"
                onClick={() => showPanel('helpFeedbackPanel')}
                sx={{
                  backgroundColor:
                    currentOpenedPanel === 'helpFeedbackPanel'
                      ? theme.palette.primary.light
                      : theme.palette.background.default,
                }}
              >
                <HelpIcon />
              </TsToolbarButton>
            </Box>
          </Box>
          <Box
            onPointerDown={onConsoleHandleDown}
            onPointerMove={onConsoleHandleMove}
            onPointerUp={onConsoleHandleUp}
            onPointerCancel={onConsoleHandleUp}
            sx={{
              height: '8px',
              flexShrink: 0,
              cursor: 'row-resize',
              backgroundColor: consoleHandleDragging
                ? theme.palette.action.selected
                : theme.palette.background.default,
              borderTop: '1px solid ' + theme.palette.divider,
              borderBottom: '1px solid ' + theme.palette.divider,
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              '&:hover': {
                backgroundColor: theme.palette.action.hover,
              },
            }}
          >
            <Box
              sx={{
                width: '10%',
                border: '1px dashed ' + theme.palette.text.secondary,
                pointerEvents: 'none',
              }}
            />
          </Box>
          <Box
            sx={{
              height: consoleHeight,
              flexShrink: 0,
              overflowY: 'auto',
              pt: 1,
              px: 1,
              backgroundColor: theme.palette.background.default,
            }}
          >
            {!AppConfig.isNativeMobile && (
              <>
                <CharacterizeAllPanel />
                <RunningModelsPanel />
              </>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export default MobileNavigation;
