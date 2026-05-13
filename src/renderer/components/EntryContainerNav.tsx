import {
  CloseIcon,
  EntryBookmarkAddIcon,
  EntryBookmarkIcon,
  NextDocumentIcon,
  PrevDocumentIcon,
} from '-/components/CommonIcons';
import TsIconButton from '-/components/TsIconButton';
import { useBookmarksContext } from '-/hooks/BookmarksContextProvider';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { usePerspectiveActionsContext } from '-/hooks/usePerspectiveActionsContext';
import { getKeyBindingObject } from '-/reducers/settings';
import { TS } from '-/tagspaces.namespace';
import { Box } from '@mui/material';
import { useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { ProTooltip } from './HelperComponents';

interface Props {
  isFile: boolean;
  smallScreen: boolean;
  startClosingEntry: (event) => void;
}

function EntryContainerNav(props: Props) {
  const { isFile, startClosingEntry, smallScreen } = props;
  const { setActions } = usePerspectiveActionsContext();
  const keyBindings = useSelector(getKeyBindingObject);
  const { openedEntry, sharingLink } = useOpenedEntryContext();
  const { t } = useTranslation();
  const [, forceUpdate] = useReducer((x) => x + 1, 0, undefined);

  const bookmarksContext = useBookmarksContext();

  const bookmarkClick = () => {
    if (bookmarksContext.haveBookmark(openedEntry.path)) {
      bookmarksContext.delBookmark(openedEntry.path);
    } else {
      bookmarksContext.setBookmark(openedEntry.path, sharingLink);
    }
    forceUpdate();
  };

  return (
    <Box
      sx={{
        zIndex: 1,
        position: 'absolute',
        top: 5,
        right: 5,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <ProTooltip tooltip={t('core:toggleBookmark')}>
        <TsIconButton
          data-tid="toggleBookmarkTID"
          aria-label="bookmark"
          onClick={bookmarkClick}
          sx={
            {
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties & { WebkitAppRegion?: string }
          }
        >
          {bookmarksContext.haveBookmark(openedEntry.path) ? (
            <EntryBookmarkIcon
              sx={{
                color: 'primary.main',
              }}
            />
          ) : (
            <EntryBookmarkAddIcon />
          )}
        </TsIconButton>
      </ProTooltip>
      {isFile && (
        <>
          <TsIconButton
            tooltip={t('core:openPrevFileTooltip')}
            keyBinding={keyBindings['prevDocument']}
            aria-label={t('core:openPrevFileTooltip')}
            data-tid="fileContainerPrevFile"
            onClick={() => {
              const action: TS.PerspectiveActions = {
                action: 'openPrevious',
              };
              setActions(action);
            }}
          >
            <PrevDocumentIcon />
          </TsIconButton>
          <TsIconButton
            tooltip={t('core:openNextFileTooltip')}
            keyBinding={keyBindings['nextDocument']}
            aria-label={t('core:openNextFileTooltip')}
            data-tid="fileContainerNextFile"
            onClick={() => {
              const action: TS.PerspectiveActions = { action: 'openNext' };
              setActions(action);
            }}
          >
            <NextDocumentIcon />
          </TsIconButton>
        </>
      )}
      {!smallScreen && (
        <TsIconButton
          tooltip={t('core:closeEntry')}
          keyBinding={keyBindings['closeViewer']}
          onClick={startClosingEntry}
          aria-label={t('core:closeEntry')}
          data-tid="fileContainerCloseOpenedFile"
        >
          <CloseIcon />
        </TsIconButton>
      )}
    </Box>
  );
}

export default EntryContainerNav;
