/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2024-present TagSpaces GmbH
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
import EditDescriptionButtons from '-/components/EditDescriptionButtons';
import DescriptionMdEditor from '-/components/md/DescriptionMdEditor';
import { CrepeRef } from '-/components/md/useCrepeHandler';
import { useFilePropertiesContext } from '-/hooks/useFilePropertiesContext';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { HfBlock } from '-/modelhub/HfBlock';
import { fetchModelMeta } from '-/modelhub/useModelMeta';
import { isSupportedModelFile } from '-/modelhub/parsers';
import type { HfMeta } from '-/modelhub/types';
import { MilkdownProvider } from '@milkdown/react';
import { Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

function EditDescription() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { setEditDescriptionMode } = useFilePropertiesContext();
  const { openedEntry } = useOpenedEntryContext();

  const milkdownDivRef = useRef<HTMLDivElement>(null);
  const fileDescriptionRef = useRef<CrepeRef>(null);

  // Modelhub HF info lives here (not in the side panel) — Description is
  // the natural surface for "what is this model" content. The block only
  // renders when there's actually HF data on the sidecar. For model files
  // without HF data yet, a hint points the user at the Fetch from HF
  // button in the Models Hub panel so the tab is never silently empty.
  const isModelFile = Boolean(
    openedEntry?.isFile &&
      openedEntry.path &&
      isSupportedModelFile(openedEntry.path),
  );
  const [hf, setHf] = useState<HfMeta | undefined>();
  useEffect(() => {
    let alive = true;
    setHf(undefined);
    if (!isModelFile || !openedEntry?.path) return undefined;
    fetchModelMeta(openedEntry.path).then((m) => {
      if (alive) setHf(m?.huggingface);
    });
    return () => {
      alive = false;
    };
  }, [openedEntry, isModelFile]);

  useEffect(() => {
    return () => {
      fileDescriptionRef.current?.destroy();
    };
  }, []);

  //const noDescription = !description || description.length < 1;
  const resetMdContent = (mdContent: string) => {
    if (!fileDescriptionRef.current) return;
    fileDescriptionRef.current.update(mdContent);
  };

  const setEditMode = (editMode: boolean) => {
    if (!fileDescriptionRef.current) return;
    fileDescriptionRef.current.setEditMode(editMode);
  };

  return (
    <Box
      sx={{
        height: 'calc(100% - 50px)',
      }}
    >
      {hf && (
        <Box sx={{ px: 2, pt: 1 }}>
          <HfBlock hf={hf} />
        </Box>
      )}
      {isModelFile && !hf && (
        <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {t('core:noHfDataYet')}
          </Typography>
        </Box>
      )}
      <EditDescriptionButtons
        resetMdContent={resetMdContent}
        setEditMode={setEditMode}
      />
      <Box
        ref={milkdownDivRef}
        className="descriptionEditor"
        data-tid="descriptionTID"
        onDoubleClick={() => {
          setEditDescriptionMode(true);
          setEditMode(true);
        }}
        sx={{
          border: '1px solid ' + theme.palette.divider,
          borderRadius: AppConfig.defaultCSSRadius,
          background: theme.palette.background.paper,
          height: 'calc(100% - 10px)',
          width: '100%',
          overflowY: 'auto',
        }}
      >
        <style>{`
          .descriptionEditor .milkdown .ProseMirror { padding: 10px 30px 10px 80px; }
          .descriptionEditor .milkdown .ProseMirror a { color: ${theme.palette.primary.main}; }
        `}</style>
        <MilkdownProvider>
          <DescriptionMdEditor ref={fileDescriptionRef} />
        </MilkdownProvider>
      </Box>
    </Box>
  );
}

export default EditDescription;
