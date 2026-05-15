/**
 * Settings ▸ IA accordion that hosts the bulk-enrichment controls for
 * the current location (Parse all / Fetch HF / Clear). Replaces the
 * always-visible sidebar widget — these are admin actions used rarely,
 * and the auto-parse-on-location-open trigger (still owned by
 * `BulkEnrichmentContextProvider` mounted in Root) keeps doing the
 * 99 % case without UI.
 *
 * Renderless when `noLocation` is true — we surface a caption telling
 * the user to open a location first; the buttons are hidden in that
 * state to avoid the "what does Parse all mean with no location" UX
 * hole.
 */

import { ExpandIcon, TagIcon } from '-/components/CommonIcons';
import { useBulkEnrichment } from '-/modelhub';
import CloseIcon from '@mui/icons-material/Close';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function ModelhubBulkAccordion() {
  const { t } = useTranslation();
  const {
    bulk,
    reindexing,
    info,
    error,
    noLocation,
    start,
    cancel,
    clearTags,
    dismissMessage,
  } = useBulkEnrichment();

  const fileName = bulk.currentFile?.replace(/^.*[\\/]/, '');
  const percent =
    bulk.total > 0 ? Math.round((bulk.processed / bulk.total) * 100) : 0;

  return (
    <Accordion>
      <AccordionSummary
        expandIcon={<ExpandIcon />}
        aria-controls="modelhub-bulk"
        id="modelhub-bulk-header"
        data-tid="modelhubBulkTID"
      >
        <Box sx={{ display: 'block' }}>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <TagIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
            <Typography>{t('core:mhBulkBarTitle')}</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {t('core:mhBulkAccordionDescription')}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        {noLocation && (
          <Typography variant="caption" color="text.secondary">
            {t('core:mhBulkNoLocation')}
          </Typography>
        )}

        {!noLocation && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {!bulk.active && (
                <>
                  <Tooltip title={t('core:mhBulkTagAllTooltip')}>
                    <Button size="small" variant="outlined" onClick={start}>
                      {t('core:mhBulkTagAll')}
                    </Button>
                  </Tooltip>
                  <Tooltip title={t('core:mhBulkClearTagsTooltip')}>
                    <Button
                      size="small"
                      variant="text"
                      color="warning"
                      onClick={clearTags}
                    >
                      {t('core:mhBulkClearTags')}
                    </Button>
                  </Tooltip>
                </>
              )}
              {bulk.active && (
                <Button
                  size="small"
                  variant="text"
                  color="warning"
                  onClick={cancel}
                >
                  {t('core:mhBulkCancel')}
                </Button>
              )}
            </Stack>

            {bulk.active && (
              <Box>
                <LinearProgress
                  variant={bulk.total > 0 ? 'determinate' : 'indeterminate'}
                  value={percent}
                  sx={{ height: 4, borderRadius: 2, mb: 0.5 }}
                />
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', lineHeight: 1.4 }}
                >
                  {bulk.processed}/{bulk.total}
                  {bulk.errors > 0 && ` • ${bulk.errors} err`}
                  {fileName && (
                    <Box
                      component="span"
                      sx={{
                        display: 'block',
                        fontFamily: 'monospace',
                        fontSize: '0.95em',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        opacity: 0.8,
                      }}
                    >
                      {fileName}
                    </Box>
                  )}
                </Typography>
              </Box>
            )}

            {!bulk.active && reindexing && (
              <Box>
                <LinearProgress sx={{ height: 4, borderRadius: 2, mb: 0.5 }} />
                <Typography variant="caption" color="text.secondary">
                  {t('core:mhBulkReindexing')}
                </Typography>
              </Box>
            )}

            {!bulk.active && !reindexing && (info || error) && (
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{
                  p: 0.75,
                  borderRadius: 0.5,
                  bgcolor: error ? 'error.dark' : 'success.dark',
                  opacity: 0.85,
                }}
              >
                <Typography
                  variant="caption"
                  color={error ? 'error.contrastText' : 'success.contrastText'}
                  sx={{ flex: 1, mr: 0.5 }}
                >
                  {error ?? info}
                </Typography>
                <IconButton
                  size="small"
                  sx={{ p: 0.25 }}
                  onClick={dismissMessage}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Stack>
            )}
          </Stack>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
