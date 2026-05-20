/**
 * Slice 3 + Slice 4 — Competence section, mounted inside the Inférence tab
 * (ModelHubPanel). Spec: SEMANTIC_ROUTING_FEATURES.md §R9.8 / R2.6 ;
 * D7 ; Slice-4 decisions (hybrid execution, disable on read-only,
 * re-characterize with confirmation).
 *
 * Reads the model's behavioral signature (useSignature), renders the full
 * radar, a copyable competence-vector line, the suite/date provenance, and
 * an inline per-axis drill-down (click an axis → its prompts/responses).
 *
 * Slice 4 adds the trigger: a "Characterize" button (on the placeholder
 * when there's no signature, "Re-characterize" — with a confirm — when one
 * exists). Disabled with an explanatory tooltip on read-only locations;
 * progress is shown inline; on completion the cached signature is
 * invalidated and the radar appears without a reload.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  LinearProgress,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ScienceIcon from '@mui/icons-material/Science';
import type {
  DiagnosticAxis,
  DiagnosticRunEntry,
} from '../../../shared/RoutingTypes';
import { useSignature } from '../useSignature';
import {
  useCharacterize,
  type CharacterizeRunStatus,
} from '../useCharacterize';
import { CompetenceRadar } from './CompetenceRadar';
import { CompetenceTree } from './CompetenceTree';
import {
  hasTreeData,
  treeBreakdownText,
  treeDataFromSignature,
} from './treeSunburstGeometry';
import {
  AXIS_I18N,
  AXIS_DESC_I18N,
  axisDataFromSignature,
  type RadarAxisDatum,
} from './radarGeometry';

interface Props {
  filePath: string;
  /** Location read-only flag — disables the characterize trigger. */
  readOnly?: boolean;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function CompetenceSection({
  filePath,
  readOnly,
}: Props): JSX.Element | null {
  const { t } = useTranslation();
  const [reloadNonce, setReloadNonce] = useState(0);
  const { loading, signature } = useSignature(filePath, true, reloadNonce);
  const { running, otherRunning, status, start } = useCharacterize(
    filePath,
    () => setReloadNonce((n) => n + 1),
  );
  const [axis, setAxis] = useState<DiagnosticAxis | null>(null);
  // Slice 8b — the fine vector-routing tree is information-dense (9
  // branches × ~32 leaves + breakdown). Default closed; toggle reveals it
  // under the R5 radar so it never competes with the coarse view above.
  const [treeOpen, setTreeOpen] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
  // Slice 7d — surface the missing free-gen probe ONCE per signature load.
  // The probe is opt-in (Settings ▸ AI ▸ Routing must have an embedder
  // URL set). Without it, characterization works but `topic_coverage_*`
  // is absent — silently. We point the user at the setting so they know
  // why one signal is missing, instead of leaving it as a mystery.
  useEffect(() => {
    if (!signature?.behavioral) return;
    if (signature.characterization_state !== 'complete') return;
    if (signature.behavioral.topic_coverage_per_leaf) return;
    setSnack(t('core:mhFreegenAbsentNotice'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature?.characterized_at]);

  const beh = signature?.behavioral ?? null;
  const qcm = signature?.qcm_reliability ?? null;
  // R5 radar presentation (user 2026-05-19). PURE presentation — the
  // routing vector / scores_per_axis are never touched here:
  //  - fr/en/zh collapsed into ONE `lang` axis (mean of measured langs);
  //  - a `qcm` axis = qcm_reliability.overall (aptitude to answer an
  //    MCQ). Display-only, NEVER enters routing (SPEC §6bis);
  //  - semantic order (math between code & reasoning), unknown last.
  const data = useMemo(() => {
    const rows = axisDataFromSignature(beh);
    const isLang = (a: string) => a === 'fr' || a === 'en' || a === 'zh';
    const out: RadarAxisDatum[] = rows.filter((r) => !isLang(r.axis));
    const subs = rows.filter((r) => isLang(r.axis));
    if (subs.length > 0) {
      const mean = subs.reduce((s, r) => s + r.score, 0) / subs.length;
      const n = subs.reduce((s, r) => s + (r.n ?? 0), 0) || undefined;
      // 'lang'/'qcm' are presentation-only axes, not routing
      // DiagnosticAxis; the radar uses `axis` only as a label/key.
      out.push({
        axis: 'lang' as unknown as RadarAxisDatum['axis'],
        score: mean,
        n,
      });
    }
    if (qcm && Number.isFinite(qcm.overall)) {
      out.push({
        axis: 'qcm' as unknown as RadarAxisDatum['axis'],
        score: qcm.overall,
        n: qcm.n,
      });
    }
    const ORDER = [
      'code',
      'informatics',
      'math',
      'reasoning',
      'multistep',
      'meta',
      'calibration',
      'qcm',
      'instruction',
      'tooluse',
      'factual',
      'summarization',
      'longctx',
      'lang',
      'creative',
      'vision',
      'fim',
      'robustness',
      'refusal',
    ];
    const rank = (a: string) => {
      const i = ORDER.indexOf(a);
      return i === -1 ? ORDER.length : i;
    };
    return out.sort((a, b) => rank(String(a.axis)) - rank(String(b.axis)));
  }, [beh, qcm]);

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

  // Tree-level projection (slice 8b). The geometry is pure and resilient
  // to a partial signature; we only render the section when at least one
  // leaf or branch score is finite (`hasTreeData`), otherwise the toggle
  // would expand into an empty card.
  const treeData = useMemo(() => treeDataFromSignature(beh), [beh]);
  const hasTree = useMemo(() => hasTreeData(beh), [beh]);
  const treeBreakdown = useMemo(
    () => (hasTree ? treeBreakdownText(treeData) : ''),
    [hasTree, treeData],
  );

  const copy = async (text: string, msg?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSnack(msg ?? t('core:mhCompetenceVectorCopied'));
    } catch {
      /* clipboard blocked — the text is still selectable inline */
    }
  };

  const launch = useCallback(
    (hasExisting: boolean) => {
      if (readOnly || running || otherRunning) return;
      if (hasExisting && !window.confirm(t('core:mhCharacterizeConfirm'))) {
        return;
      }
      void start(readOnly);
    },
    [readOnly, running, otherRunning, start, t],
  );

  const statusLabel = (s: CharacterizeRunStatus | undefined): string => {
    if (!s) return t('core:mhCharacterizeRunning');
    if (s.stage === 'preparing') {
      if (s.detail === 'reuse') return t('core:mhCharacterizePrepReuse');
      if (s.detail === 'launching') return t('core:mhCharacterizePrepLaunch');
      return t('core:mhCharacterizePrepWait');
    }
    if (s.stage === 'running') {
      const p = s.progress;
      if (p.kind === 'prompt_started') {
        return t('core:mhCharacterizeProgress', {
          i: p.index + 1,
          n: p.total,
        });
      }
      return t('core:mhCharacterizeRunning');
    }
    return t('core:mhCharacterizeRunning');
  };

  const progressValue = (): number | undefined => {
    if (
      status?.stage === 'running' &&
      status.progress.kind === 'prompt_started'
    ) {
      const { index, total } = status.progress;
      return total > 0 ? Math.round((index / total) * 100) : undefined;
    }
    return undefined;
  };

  const triggerError = status?.stage === 'error' ? status.error : undefined;

  // Shared trigger/progress block (placeholder + populated header reuse it).
  const Trigger = ({ hasExisting }: { hasExisting: boolean }) => {
    if (running) {
      const v = progressValue();
      return (
        <Box sx={{ mt: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              {statusLabel(status)}
            </Typography>
          </Stack>
          <LinearProgress
            variant={v == null ? 'indeterminate' : 'determinate'}
            value={v}
            sx={{ mt: 0.5, borderRadius: 1 }}
          />
        </Box>
      );
    }
    const blockedTip = readOnly
      ? t('core:mhCharacterizeReadOnly')
      : otherRunning
        ? t('core:mhCharacterizeBusyOther')
        : '';
    const btn = (
      <span>
        <Button
          size="small"
          variant={hasExisting ? 'text' : 'outlined'}
          startIcon={<ScienceIcon />}
          disabled={!!readOnly || otherRunning}
          onClick={() => launch(hasExisting)}
          data-tid="characterizeModelTID"
        >
          {hasExisting ? t('core:mhRecharacterize') : t('core:mhCharacterize')}
        </Button>
      </span>
    );
    return (
      <Box sx={{ mt: 1 }}>
        {blockedTip ? <Tooltip title={blockedTip}>{btn}</Tooltip> : btn}
        {triggerError && (
          <Alert severity="error" sx={{ mt: 1 }} variant="outlined">
            {t('core:mhCharacterizeFailed', { err: triggerError })}
          </Alert>
        )}
      </Box>
    );
  };

  if (loading) return null;

  // ---- No signature yet → subtle copyable placeholder + trigger ---------
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
        <Trigger hasExisting={false} />
      </Box>
    );
  }

  const axisDetail = (id: string, e: DiagnosticRunEntry): string => {
    const head = `${id}  ${e.pass ? '[' + t('core:mhCompetencePass') + ']' : '[' + t('core:mhCompetenceFail') + ']'}  score=${(e.score ?? 0).toFixed(2)}`;
    const detail = e.detail ? `\n  ${e.detail}` : '';
    const err = e.error ? `\n  ! ${e.error}` : '';
    const resp = e.response ? `\n  → ${e.response.trim()}` : '';
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
          // The locale date contains "/" — i18next's default HTML escaper
          // turns it into "&#x2F;", which React then renders literally.
          // Both values are plain, non-HTML, so skip escaping here.
          interpolation: { escapeValue: false },
        })}
      </Typography>

      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ display: 'block', mt: 0.5 }}
      >
        {t('core:mhCompetenceClickAxisHint')}
      </Typography>

      <Trigger hasExisting />

      {/* Slice 8b — fine vector-routing tree (per-leaf), collapsible. The
          geometry uses `signature.scoring_scheme` to pick the right
          "fully mastered" predicate (Beta-Laplace passes===n vs legacy
          breaking-rung integer); the breakdown text below it stays the
          honest, copyable source of truth for every leaf. */}
      {hasTree && (
        <Box sx={{ mt: 1.5 }}>
          <Divider sx={{ mb: 1 }} />
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 0.5 }}
          >
            <ButtonBase
              onClick={() => setTreeOpen((v) => !v)}
              sx={{
                px: 0.5,
                fontSize: '0.875rem',
                fontWeight: 500,
                borderRadius: 1,
              }}
              aria-expanded={treeOpen}
            >
              {treeOpen ? '▾ ' : '▸ '}
              {t('core:mhTreeTitle')}
            </ButtonBase>
            {treeOpen && treeBreakdown && (
              <Tooltip title={t('core:mhTreeCopy')}>
                <IconButton
                  size="small"
                  onClick={() => copy(treeBreakdown, t('core:mhTreeCopied'))}
                  aria-label={t('core:mhTreeCopy')}
                >
                  <ContentCopyIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
          <Collapse in={treeOpen} unmountOnExit>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              {t('core:mhTreeSubtitle')}
            </Typography>
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: 'block', mb: 1 }}
            >
              {t('core:mhTreeScaleHint')}
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
              <CompetenceTree
                data={treeData}
                scheme={beh.scoring_scheme}
                size={280}
              />
            </Box>
            {treeBreakdown && (
              <Box
                component="pre"
                sx={{
                  m: 0,
                  mt: 1,
                  p: 1,
                  maxHeight: 280,
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.72rem',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  userSelect: 'text',
                  color: 'text.primary',
                  bgcolor: 'action.hover',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                }}
              >
                {treeBreakdown}
              </Box>
            )}
          </Collapse>
        </Box>
      )}

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
                  axis: AXIS_I18N[axis] ? t(AXIS_I18N[axis]) : axis,
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

          {/* What this competence means (also on hover via SVG title). */}
          {axis && AXIS_DESC_I18N[axis] && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1, userSelect: 'text' }}
            >
              {t(AXIS_DESC_I18N[axis])}
            </Typography>
          )}

          {drillText && (
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1,
                maxHeight: 320,
                overflow: 'auto',
                fontFamily: 'monospace',
                fontSize: '0.78rem',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text',
                color: 'text.primary',
                bgcolor: 'action.hover',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
              }}
            >
              {drillText}
            </Box>
          )}
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
