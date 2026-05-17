/**
 * Slice 3 — Competence section, mounted inside the Inférence tab
 * (ModelHubPanel). Spec: SEMANTIC_ROUTING_FEATURES.md §R9.8 ; D7.
 *
 * Reads the model's behavioral signature (useSignature), renders the full
 * radar, a copyable competence-vector line, the suite/date provenance, and
 * an inline per-axis drill-down (click an axis → its prompts/responses).
 *
 * When the model has no behavioral signature yet, a subtle copyable
 * placeholder line is shown instead (per the user's Slice-3 decision +
 * the project rule that all UI text is copyable). No "Characterize"
 * trigger here — that belongs to a later slice.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  ButtonBase,
  Collapse,
  Divider,
  IconButton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type {
  DiagnosticAxis,
  DiagnosticRunEntry,
} from '../../../shared/RoutingTypes';
import { useSignature } from '../useSignature';
import { CompetenceRadar } from './CompetenceRadar';
import { axisDataFromSignature } from './radarGeometry';

interface Props {
  filePath: string;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function CompetenceSection({ filePath }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const { loading, signature } = useSignature(filePath);
  const [axis, setAxis] = useState<DiagnosticAxis | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

  const beh = signature?.behavioral ?? null;
  const data = useMemo(() => axisDataFromSignature(beh), [beh]);

  const vectorText = useMemo(() => {
    if (!beh) return '';
    const parts = data.map(
      (d) => `${d.axis}=${d.score.toFixed(2)}${d.n != null ? `(n${d.n})` : ''}`,
    );
    const overall =
      typeof beh.overall === 'number'
        ? ` | overall=${beh.overall.toFixed(2)}`
        : '';
    return parts.join(' ') + overall;
  }, [beh, data]);

  const axisEntries: [string, DiagnosticRunEntry][] = useMemo(() => {
    if (!beh || !axis) return [];
    return Object.entries(beh.diagnostic_run).filter(([, e]) =>
      e.axes?.includes(axis),
    );
  }, [beh, axis]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSnack(t('core:mhCompetenceVectorCopied'));
    } catch {
      /* clipboard blocked — the text is still selectable inline */
    }
  };

  if (loading) return null;

  // ---- No signature yet → subtle copyable placeholder -------------------
  if (!beh || data.length === 0) {
    return (
      <Box>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
          {t('core:mhCompetenceTitle')}
        </Typography>
        <Typography
          variant="body2"
          color="text.disabled"
          sx={{ userSelect: 'text' }}
        >
          {t('core:mhCompetenceNotYet')} — {t('core:mhCompetenceNotYetHelp')}
        </Typography>
      </Box>
    );
  }

  const axisDetail = (id: string, e: DiagnosticRunEntry): string => {
    const head = `${id}  ${e.pass ? '[' + t('core:mhCompetencePass') + ']' : '[' + t('core:mhCompetenceFail') + ']'}  score=${(e.score ?? 0).toFixed(2)}`;
    const detail = e.detail ? `\n  ${e.detail}` : '';
    const err = e.error ? `\n  ! ${e.error}` : '';
    const resp = e.response ? `\n  → ${e.response.slice(0, 400)}` : '';
    return head + detail + err + resp;
  };

  const drillText = axis
    ? axisEntries.map(([id, e]) => axisDetail(id, e)).join('\n\n')
    : '';

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 0.5 }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          {t('core:mhCompetenceTitle')}
        </Typography>
        <Tooltip title={t('core:mhCompetenceCopyVector')}>
          <IconButton
            size="small"
            onClick={() => copy(vectorText)}
            aria-label={t('core:mhCompetenceCopyVector')}
          >
            <ContentCopyIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: 1 }}
      >
        {t('core:mhCompetenceSubtitle')}
      </Typography>

      <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
        <CompetenceRadar
          data={data}
          variant="full"
          size={300}
          overall={beh.overall}
          onAxisClick={(a) => setAxis((cur) => (cur === a ? null : a))}
        />
      </Box>

      {/* Copyable vector line (selectable even if clipboard is blocked). */}
      <Typography
        variant="body2"
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          userSelect: 'text',
          wordBreak: 'break-word',
          color: 'text.secondary',
        }}
      >
        {vectorText}
      </Typography>

      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ display: 'block', mt: 0.5, userSelect: 'text' }}
      >
        {t('core:mhCompetenceMeta', {
          version: signature?.suite_version ?? '—',
          when: fmtWhen(signature?.characterized_at ?? null),
        })}
      </Typography>

      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ display: 'block', mt: 0.5 }}
      >
        {t('core:mhCompetenceClickAxisHint')}
      </Typography>

      <Collapse in={!!axis} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          <Divider sx={{ mb: 1 }} />
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 0.5 }}
          >
            <Typography variant="subtitle2">
              {axis &&
                t('core:mhCompetenceAxisDetail', {
                  axis,
                  n: axisEntries.length,
                })}
            </Typography>
            <Stack direction="row" spacing={0.5}>
              <Tooltip title={t('core:mhCompetenceCopyVector')}>
                <IconButton
                  size="small"
                  onClick={() => copy(drillText)}
                  aria-label={t('core:mhCompetenceCopyVector')}
                >
                  <ContentCopyIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
              <ButtonBase
                onClick={() => setAxis(null)}
                sx={{ px: 1, fontSize: '0.75rem', borderRadius: 1 }}
              >
                {t('core:mhCompetenceClose')}
              </ButtonBase>
            </Stack>
          </Stack>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1,
              maxHeight: 260,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: '0.72rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text',
              bgcolor: 'action.hover',
              borderRadius: 1,
            }}
          >
            {drillText}
          </Box>
        </Box>
      </Collapse>

      <Snackbar
        open={!!snack}
        autoHideDuration={2000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          variant="filled"
          onClose={() => setSnack(null)}
        >
          {snack}
        </Alert>
      </Snackbar>
    </Box>
  );
}

export default CompetenceSection;
