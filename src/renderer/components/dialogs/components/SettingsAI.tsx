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
import ModelhubBulkAccordion from '-/modelhub/ModelhubBulkAccordion';
import { Pro } from '-/pro';
import { formatBytes, useHardware } from '-/modelhub/hardware';
import { useRoutingConfig } from '-/modelhub/routingConfig';
import { selectGgufFileDialog } from '-/services/utils-io';
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
  const rc = useRoutingConfig();
  const [rcDraft, setRcDraft] = React.useState<{
    vramGb: string;
    ramGb: string;
    // Slice 7e — `embPath` is the managed-launch path; `embUrl` is the
    // legacy external-URL fallback. `embPath` wins when both are set.
    // Note: the routing tuning knobs (`thetaQ`, `thetaOpen`,
    // `embeddingReliabilityThreshold`, `routingEmbedderModel`) are not
    // surfaced here anymore — they are power-user options whose defaults
    // are documented in `effectiveRoutingParams` and reset by the
    // "Réinitialiser" button.
    embPath: string;
    embUrl: string;
    /** Slice 2d — opt-in for the code-tests sandbox (default false). */
    enableSandbox: boolean;
  }>({
    vramGb: '',
    ramGb: '',
    embPath: '',
    embUrl: '',
    enableSandbox: false,
  });
  // Sync the draft from the persisted config every time it lands. Blank
  // means "use the documented default" — the placeholder shows it.
  React.useEffect(() => {
    const gb = (b: number | undefined) =>
      typeof b === 'number' ? String(Number((b / 1024 ** 3).toFixed(2))) : '';
    setRcDraft({
      vramGb: gb(rc.config.vramReserveBytes),
      ramGb: gb(rc.config.ramReserveBytes),
      embPath: rc.config.routingEmbedderPath ?? '',
      embUrl: rc.config.routingEmbedderBaseUrl ?? '',
      enableSandbox: rc.config.enableSandbox === true,
    });
  }, [rc.config]);

  const browseEmbedder = async () => {
    try {
      const picked = await selectGgufFileDialog();
      if (picked && picked.length > 0) {
        setRcDraft((d) => ({ ...d, embPath: picked[0] }));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('selectGgufFileDialog failed:', (e as Error).message);
    }
  };

  const saveRoutingDraft = async () => {
    const v = parseFloat(rcDraft.vramGb);
    const r = parseFloat(rcDraft.ramGb);
    const path = rcDraft.embPath.trim();
    const url = rcDraft.embUrl.trim();
    // We pass the routing tuning knobs as `undefined` so the persisted
    // config falls back to the documented defaults — the UI no longer
    // exposes them, and we don't want a previously saved value to linger
    // invisibly after the user comes back to this form.
    await rc.save({
      vramReserveBytes:
        Number.isFinite(v) && v > 0 ? Math.round(v * 1024 ** 3) : undefined,
      ramReserveBytes:
        Number.isFinite(r) && r > 0 ? Math.round(r * 1024 ** 3) : undefined,
      routingEmbedderPath: path || undefined,
      routingEmbedderBaseUrl: url || undefined,
      routingEmbedderModel: undefined,
      thetaQ: undefined,
      thetaOpen: undefined,
      embeddingReliabilityThreshold: undefined,
      enableSandbox: rcDraft.enableSandbox === true ? true : undefined,
    });
  };

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
      <ModelhubBulkAccordion />
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
          aria-controls="modelhub-routing"
          id="modelhub-routing-header"
          data-tid="modelhubRoutingTID"
        >
          <Box sx={{ display: 'block' }}>
            <Typography>{t('core:mhSettingsRouting')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('core:mhSettingsRoutingDescription')}
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <FormGroup>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              {t('core:mhSettingsRoutingHint')}
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
                label={t('core:mhSettingsRoutingVramReserveGb')}
                placeholder="1"
                value={rcDraft.vramGb}
                updateValue={(v) => setRcDraft((d) => ({ ...d, vramGb: v }))}
                retrieveValue={() => rcDraft.vramGb}
              />
              <TsTextField
                label={t('core:mhSettingsRoutingRamReserveGb')}
                placeholder="2"
                value={rcDraft.ramGb}
                updateValue={(v) => setRcDraft((d) => ({ ...d, ramGb: v }))}
                retrieveValue={() => rcDraft.ramGb}
              />
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              {t('core:mhSettingsRoutingVectorHint')}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                gap: 1,
                alignItems: 'flex-end',
              }}
            >
              <Box sx={{ flex: 1 }}>
                <TsTextField
                  label={t('core:mhSettingsRoutingEmbedderPath')}
                  placeholder="D:\\models\\LLM\\Embedding\\Qwen3-Embedding-0.6B-Q8_0.gguf"
                  value={rcDraft.embPath}
                  updateValue={(v) => setRcDraft((d) => ({ ...d, embPath: v }))}
                  retrieveValue={() => rcDraft.embPath}
                />
              </Box>
              <TsButton
                variant="outlined"
                onClick={() => void browseEmbedder()}
                data-tid="routingBrowseEmbedderTID"
                tooltip={t('core:mhSettingsRoutingEmbedderBrowseTooltip')}
                sx={{ mb: 0.5, whiteSpace: 'nowrap' }}
              >
                {t('core:mhSettingsRoutingEmbedderBrowse')}
              </TsButton>
            </Box>
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: 'block', mt: 0.25, mb: 0.5, fontStyle: 'italic' }}
            >
              {t('core:mhSettingsRoutingEmbedderPathHint')}
            </Typography>
            <TsTextField
              label={t('core:mhSettingsRoutingEmbedderUrl')}
              placeholder="http://127.0.0.1:8081"
              value={rcDraft.embUrl}
              updateValue={(v) => setRcDraft((d) => ({ ...d, embUrl: v }))}
              retrieveValue={() => rcDraft.embUrl}
            />
            {/* Slice 2d — code-tests sandbox opt-in. Default off; toggling on
                lets the staircase measure the 9 `code-tests` items via a
                kernel-isolated subprocess (POSIX rlimits / Windows Job
                Object). The hint spells out the residual risk surface
                (per DECISIONS.md Dαα) so the user opts in informed. */}
            <FormControlLabel
              control={
                <Switch
                  checked={rcDraft.enableSandbox}
                  onChange={(_e, checked) =>
                    setRcDraft((d) => ({ ...d, enableSandbox: checked }))
                  }
                  data-tid="routingEnableSandboxTID"
                />
              }
              label={t('core:mhSettingsRoutingEnableSandbox')}
              sx={{ mt: 1, display: 'block' }}
            />
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: 'block', mt: 0, mb: 0.5, fontStyle: 'italic' }}
            >
              {t('core:mhSettingsRoutingEnableSandboxHint')}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <TsButton
                onClick={() => void saveRoutingDraft()}
                data-tid="routingSaveConfigTID"
              >
                {t('core:save')}
              </TsButton>
              <TsButton
                variant="text"
                color="warning"
                onClick={() => void rc.save({})}
                data-tid="routingResetConfigTID"
                tooltip={t('core:mhSettingsRoutingResetTooltip')}
              >
                {t('core:mhSettingsRoutingReset')}
              </TsButton>
            </Box>
            {rc.error && (
              <Typography
                variant="caption"
                color="error"
                sx={{ mt: 0.5, display: 'block' }}
              >
                {rc.error}
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
