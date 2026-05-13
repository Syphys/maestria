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
import {
  CreateFileIcon,
  ExpandIcon,
  ReloadIcon,
} from '-/components/CommonIcons';
import TsButton from '-/components/TsButton';
import TsTextField from '-/components/TsTextField';
import { Pro } from '-/pro';
import { formatBytes, useHardware } from '-/modelhub/hardware';
import { buildClaudeDesktopConfig, useMcp } from '-/modelhub/mcp/useMcp';
import { TS } from '-/tagspaces.namespace';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Switch,
} from '@mui/material';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import InputAdornment from '@mui/material/InputAdornment';
import Typography from '@mui/material/Typography';
import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Kept for API compatibility with `SettingsDialog`. */
  closeSettings: () => void;
}

function SettingsAI(_props: Props) {
  const { t } = useTranslation();
  const mcp = useMcp();
  const hw = useHardware();
  const [hwDraft, setHwDraft] = React.useState<{
    vendor: string;
    name: string;
    vramGb: string;
    ramGb: string;
  }>({ vendor: '', name: '', vramGb: '', ramGb: '' });
  // Sync the draft from the persisted override every time it lands.
  React.useEffect(() => {
    setHwDraft({
      vendor: hw.override.vendor ?? '',
      name: hw.override.name ?? '',
      vramGb:
        typeof hw.override.vramBytes === 'number'
          ? String(Math.round(hw.override.vramBytes / 1024 ** 3))
          : '',
      ramGb:
        typeof hw.override.ramBytes === 'number'
          ? String(Math.round(hw.override.ramBytes / 1024 ** 3))
          : '',
    });
  }, [hw.override]);
  const [copyStatus, setCopyStatus] = React.useState<string | undefined>();

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied`);
      setTimeout(() => setCopyStatus(undefined), 2000);
    } catch (e) {
      setCopyStatus(`Copy failed: ${(e as Error).message}`);
    }
  };

  const saveHardwareDraft = async () => {
    const vramGb = parseFloat(hwDraft.vramGb);
    const ramGb = parseFloat(hwDraft.ramGb);
    await hw.saveOverride({
      vendor: hwDraft.vendor.trim() || undefined,
      name: hwDraft.name.trim() || undefined,
      vramBytes:
        Number.isFinite(vramGb) && vramGb > 0
          ? Math.round(vramGb * 1024 ** 3)
          : undefined,
      ramBytes:
        Number.isFinite(ramGb) && ramGb > 0
          ? Math.round(ramGb * 1024 ** 3)
          : undefined,
    });
  };
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0, undefined);
  const aiTemplates = React.useRef({});

  const aiTemplatesContext = Pro?.contextProviders?.AiTemplatesContext
    ? useContext<TS.AiTemplatesContextData>(
        Pro.contextProviders.AiTemplatesContext,
      )
    : undefined;

  function saveTemplate(key: string) {
    const template = aiTemplates.current[key];
    if (template) {
      aiTemplatesContext.setTemplate(key, template);
      aiTemplates.current[key] = undefined;
    }
  }

  function resetTemplate(key: string) {
    const template = aiTemplatesContext.getDefaultTemplate(key);
    if (template) {
      aiTemplatesContext.setTemplate(key, template);
      aiTemplates.current[key] = undefined;
    }
  }

  function cancelSavingTemplate(key: string) {
    aiTemplates.current[key] = undefined;
    forceUpdate();
  }

  const actionButtons = (key) => (
    <InputAdornment
      position="end"
      sx={{ flexDirection: 'column', marginTop: '-70px' }}
    >
      <TsButton
        variant="text"
        data-tid={'save' + key + 'TID'}
        onClick={() => saveTemplate(key)}
      >
        {t('core:save')}
      </TsButton>
      <TsButton
        variant="text"
        tooltip="Resets to the default prompt"
        data-tid={'reset' + key + 'TID'}
        onClick={() => resetTemplate(key)}
      >
        {t('core:resetBtn')}
      </TsButton>
      <TsButton
        variant="text"
        data-tid={'cancel' + key + 'TID'}
        onClick={() => cancelSavingTemplate(key)}
      >
        {t('core:cancel')}
      </TsButton>
    </InputAdornment>
  );

  return (
    <Box
      sx={{
        overflowX: 'hidden',
        overflowY: 'auto',
        height: '100%',
        padding: '10px',
      }}
    >
      <Accordion defaultExpanded>
        <AccordionSummary
          expandIcon={<ExpandIcon />}
          aria-controls="modelhub-hardware"
          id="modelhub-hardware-header"
          data-tid="modelhubHardwareTID"
        >
          <Box sx={{ display: 'block' }}>
            <Typography>{t('core:mhSettingsHardware')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('core:mhSettingsHardwareDescription')}
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <FormGroup>
            <Box
              sx={{
                p: 1,
                mb: 1,
                borderRadius: 1,
                bgcolor: 'action.hover',
                fontSize: '0.85em',
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', fontWeight: 500, mb: 0.5 }}
              >
                {t('core:mhSettingsDetected')}
              </Typography>
              <Typography variant="body2">
                RAM&nbsp;
                {hw.detected?.ramBytes
                  ? formatBytes(hw.detected.ramBytes)
                  : '—'}
                {' · '}
                CPU&nbsp;
                {hw.detected?.cpu?.cores
                  ? t('core:mhSettingsCpuCores', {
                      count: hw.detected.cpu.cores,
                    })
                  : '—'}
                {' · '}
                GPU&nbsp;
                {hw.detected?.gpu?.name
                  ? `${hw.detected.gpu.name}${
                      hw.detected.gpu.vramBytes
                        ? ` (${formatBytes(hw.detected.gpu.vramBytes)})`
                        : ''
                    }`
                  : t('core:mhSettingsGpuNotDetected')}
              </Typography>
              {hw.effective?.source === 'manual' && (
                <Typography
                  variant="caption"
                  color="warning.main"
                  sx={{ display: 'block', mt: 0.25 }}
                >
                  {t('core:mhSettingsOverrideActive')}
                </Typography>
              )}
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              {t('core:mhSettingsOverrideHint')}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 1,
                mb: 1,
              }}
            >
              <TsTextField
                label={t('core:mhSettingsGpuVendor')}
                placeholder="NVIDIA"
                value={hwDraft.vendor}
                updateValue={(v) => setHwDraft((d) => ({ ...d, vendor: v }))}
                retrieveValue={() => hwDraft.vendor}
              />
              <TsTextField
                label={t('core:mhSettingsGpuName')}
                placeholder="GeForce RTX 4090"
                value={hwDraft.name}
                updateValue={(v) => setHwDraft((d) => ({ ...d, name: v }))}
                retrieveValue={() => hwDraft.name}
              />
              <TsTextField
                label={t('core:mhSettingsVramGb')}
                placeholder="24"
                value={hwDraft.vramGb}
                updateValue={(v) => setHwDraft((d) => ({ ...d, vramGb: v }))}
                retrieveValue={() => hwDraft.vramGb}
              />
              <TsTextField
                label={t('core:mhSettingsRamGb')}
                placeholder="64"
                value={hwDraft.ramGb}
                updateValue={(v) => setHwDraft((d) => ({ ...d, ramGb: v }))}
                retrieveValue={() => hwDraft.ramGb}
              />
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <TsButton
                onClick={() => void saveHardwareDraft()}
                data-tid="hardwareSaveOverrideTID"
              >
                {t('core:save')}
              </TsButton>
              <TsButton
                variant="text"
                color="warning"
                onClick={() => void hw.clearOverride()}
                data-tid="hardwareClearOverrideTID"
                tooltip={t('core:mhSettingsClearOverrideTooltip')}
              >
                {t('core:mhSettingsClearOverride')}
              </TsButton>
              <TsButton
                variant="text"
                startIcon={<ReloadIcon />}
                onClick={() => void hw.refresh()}
                data-tid="hardwareReDetectTID"
              >
                {t('core:mhSettingsReDetect')}
              </TsButton>
            </Box>
            {hw.error && (
              <Typography
                variant="caption"
                color="error"
                sx={{ mt: 0.5, display: 'block' }}
              >
                {hw.error}
              </Typography>
            )}
          </FormGroup>
        </AccordionDetails>
      </Accordion>
      <Accordion defaultExpanded>
        <AccordionSummary
          expandIcon={<ExpandIcon />}
          aria-controls="modelhub-mcp"
          id="modelhub-mcp-header"
          data-tid="modelhubMcpTID"
        >
          <Box sx={{ display: 'block' }}>
            <Typography>{t('core:mhSettingsMcp')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('core:mhSettingsMcpDescription')} <code>127.0.0.1:41541</code>
              {t('core:mhSettingsMcpDescriptionTail')}
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <FormGroup>
            <FormControlLabel
              labelPlacement="start"
              sx={{ justifyContent: 'space-between', marginLeft: 0 }}
              control={
                <Switch
                  data-tid="mcpAutoStartTID"
                  checked={mcp.autoStart}
                  onChange={(e) => void mcp.setAutoStart(e.target.checked)}
                />
              }
              label={t('core:mhSettingsMcpAutoStart')}
            />
            <Box sx={{ display: 'flex', gap: 1, mt: 1, mb: 1 }}>
              {mcp.status.running ? (
                <>
                  <FiberManualRecordIcon
                    sx={{ color: 'green', fontSize: 19, mt: 0.4 }}
                  />
                  <Typography variant="caption" sx={{ mt: 0.5 }}>
                    {t('core:mhSettingsMcpListening', {
                      count: mcp.status.sessions,
                    })}
                  </Typography>
                  <TsButton
                    variant="text"
                    color="warning"
                    onClick={() => void mcp.stop()}
                    data-tid="mcpStopTID"
                  >
                    {t('core:mhSettingsMcpStop')}
                  </TsButton>
                </>
              ) : (
                <>
                  <FiberManualRecordIcon
                    sx={{ color: 'gray', fontSize: 19, mt: 0.4 }}
                  />
                  <Typography variant="caption" sx={{ mt: 0.5 }}>
                    {t('core:mhSettingsMcpStopped')}
                  </Typography>
                  <TsButton
                    variant="text"
                    onClick={() => void mcp.start()}
                    data-tid="mcpStartTID"
                  >
                    {t('core:mhSettingsMcpStartNow')}
                  </TsButton>
                </>
              )}
            </Box>
            <TsTextField
              fullWidth
              label={t('core:mhSettingsMcpUrl')}
              data-tid="mcpUrlTID"
              value={
                mcp.status.running
                  ? mcp.status.url
                  : t('core:mhSettingsMcpUrlStopped')
              }
              retrieveValue={() =>
                mcp.status.running
                  ? mcp.status.url
                  : 'http://127.0.0.1:41541/sse'
              }
              slotProps={{
                input: {
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <TsButton
                        variant="text"
                        onClick={() =>
                          copy(
                            mcp.status.running
                              ? mcp.status.url
                              : 'http://127.0.0.1:41541/sse',
                            'URL',
                          )
                        }
                        data-tid="mcpCopyUrlTID"
                      >
                        {t('core:copy')}
                      </TsButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <TsTextField
              fullWidth
              label={t('core:mhSettingsMcpToken')}
              data-tid="mcpTokenTID"
              value={mcp.token}
              retrieveValue={() => mcp.token}
              slotProps={{
                input: {
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <TsButton
                        variant="text"
                        onClick={() => copy(mcp.token, 'Token')}
                        data-tid="mcpCopyTokenTID"
                      >
                        {t('core:copy')}
                      </TsButton>
                      <TsButton
                        variant="text"
                        color="warning"
                        onClick={() => void mcp.regenerate()}
                        data-tid="mcpRegenerateTokenTID"
                        tooltip={t('core:mhSettingsMcpRegenerateTooltip')}
                      >
                        {t('core:resetBtn')}
                      </TsButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <TsButton
              sx={{ mt: 1 }}
              onClick={() =>
                copy(
                  buildClaudeDesktopConfig(
                    mcp.status.running
                      ? mcp.status.url
                      : 'http://127.0.0.1:41541/sse',
                    mcp.token,
                  ),
                  'MCP config',
                )
              }
              data-tid="mcpCopyClaudeConfigTID"
              startIcon={<CreateFileIcon />}
            >
              {t('core:mhSettingsMcpCopyConfig')}
            </TsButton>
            {copyStatus && (
              <Typography
                variant="caption"
                color="success.main"
                sx={{ mt: 0.5, display: 'block' }}
              >
                {copyStatus}
              </Typography>
            )}
            {mcp.error && (
              <Typography
                variant="caption"
                color="error"
                sx={{ mt: 0.5, display: 'block' }}
              >
                {mcp.error}
              </Typography>
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 1, display: 'block' }}
            >
              {t('core:mhSettingsMcpToolsExposed', {
                count: mcp.tools.length,
                names: mcp.tools.map((tool) => tool.name).join(', '),
              })}
            </Typography>
          </FormGroup>
        </AccordionDetails>
      </Accordion>
      {Pro && aiTemplatesContext && (
        <Accordion>
          <AccordionSummary
            expandIcon={<ExpandIcon />}
            aria-controls={'AdvancedContent'}
            data-tid={'AdvancedTID'}
            sx={{
              '& .MuiAccordionSummary-content': { alignItems: 'center' },
            }}
          >
            <Typography>{'Advanced'}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(typeof AppConfig.ExtDefaultQuestionPrompt === 'undefined')
              }
              label={t('defaultQuestionPrompt')}
              value={
                aiTemplates.current['DEFAULT_QUESTION_PROMPT'] ??
                aiTemplatesContext.getTemplate('DEFAULT_QUESTION_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['DEFAULT_QUESTION_PROMPT'] = e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['DEFAULT_QUESTION_PROMPT'] &&
                    actionButtons('DEFAULT_QUESTION_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(typeof AppConfig.ExtDefaultSystemPrompt === 'undefined')
              }
              label={t('defaultSystemPrompt')}
              value={
                aiTemplates.current['DEFAULT_SYSTEM_PROMPT'] ??
                aiTemplatesContext.getTemplate('DEFAULT_SYSTEM_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['DEFAULT_SYSTEM_PROMPT'] = e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['DEFAULT_SYSTEM_PROMPT'] &&
                    actionButtons('DEFAULT_SYSTEM_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={!(typeof AppConfig.ExtSummarizePrompt === 'undefined')}
              label={t('summarizePrompt')}
              value={
                aiTemplates.current['SUMMARIZE_PROMPT'] ??
                aiTemplatesContext.getTemplate('SUMMARIZE_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['SUMMARIZE_PROMPT'] = e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['SUMMARIZE_PROMPT'] &&
                    actionButtons('SUMMARIZE_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(
                  typeof AppConfig.ExtDescriptionFromImagePrompt === 'undefined'
                )
              }
              label={t('imageDescription')}
              value={
                aiTemplates.current['IMAGE_DESCRIPTION_PROMPT'] ??
                aiTemplatesContext.getTemplate('IMAGE_DESCRIPTION_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['IMAGE_DESCRIPTION_PROMPT'] =
                  e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['IMAGE_DESCRIPTION_PROMPT'] &&
                    actionButtons('IMAGE_DESCRIPTION_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(
                  typeof AppConfig.ExtDescriptionFromImageStructuredPrompt ===
                  'undefined'
                )
              }
              label={t('imageDescriptionStructured')}
              value={
                aiTemplates.current['IMAGE_DESCRIPTION_STRUCTURED_PROMPT'] ??
                aiTemplatesContext.getTemplate(
                  'IMAGE_DESCRIPTION_STRUCTURED_PROMPT',
                )
              }
              onChange={(e) => {
                aiTemplates.current['IMAGE_DESCRIPTION_STRUCTURED_PROMPT'] =
                  e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current[
                      'IMAGE_DESCRIPTION_STRUCTURED_PROMPT'
                    ] && actionButtons('IMAGE_DESCRIPTION_STRUCTURED_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(typeof AppConfig.ExtDescriptionFromTextPrompt === 'undefined')
              }
              label={t('textDescription')}
              value={
                aiTemplates.current['TEXT_DESCRIPTION_PROMPT'] ??
                aiTemplatesContext.getTemplate('TEXT_DESCRIPTION_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['TEXT_DESCRIPTION_PROMPT'] = e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['TEXT_DESCRIPTION_PROMPT'] &&
                    actionButtons('TEXT_DESCRIPTION_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(typeof AppConfig.ExtTagsFromImagePrompt === 'undefined')
              }
              label={t('generateImageTags')}
              value={
                aiTemplates.current['IMAGE_TAGS_PROMPT'] ??
                aiTemplatesContext.getTemplate('IMAGE_TAGS_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['IMAGE_TAGS_PROMPT'] = e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['IMAGE_TAGS_PROMPT'] &&
                    actionButtons('IMAGE_TAGS_PROMPT'),
                },
              }}
            />
            <TsTextField
              fullWidth
              multiline
              rows={5}
              disabled={
                !(typeof AppConfig.ExtTagsFromTextPrompt === 'undefined')
              }
              label={t('generateTags')}
              value={
                aiTemplates.current['TEXT_TAGS_PROMPT'] ??
                aiTemplatesContext.getTemplate('TEXT_TAGS_PROMPT')
              }
              onChange={(e) => {
                aiTemplates.current['TEXT_TAGS_PROMPT'] = e.target.value;
                forceUpdate();
              }}
              slotProps={{
                input: {
                  endAdornment:
                    aiTemplates.current['TEXT_TAGS_PROMPT'] &&
                    actionButtons('TEXT_TAGS_PROMPT'),
                },
              }}
            />
          </AccordionDetails>
        </Accordion>
      )}
    </Box>
  );
}

export default SettingsAI;
