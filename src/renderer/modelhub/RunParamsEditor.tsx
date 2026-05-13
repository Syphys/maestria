/**
 * Per-model llama.cpp launch-parameter editor.
 *
 * Two columns:
 *   - Estimated: what `autotune()` derived from the model header + hardware.
 *     Read-only. Refreshed each time the file is opened (re-runs autotune
 *     against the current hardware profile).
 *   - Used: what's actually passed to the runner on Run. Defaults to the
 *     estimated value, can be overridden per-field. Persisted in the
 *     sidecar as `modelMeta.userRunParams` so a hand-tuned set survives
 *     close/reopen.
 *
 * The "Reset" button per row clears that field's override, so the next
 * launch picks up a freshly-estimated value (e.g. after the user installs
 * a bigger GPU). "Reset all" wipes the whole override.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import RefreshIcon from '@mui/icons-material/Refresh';
import { FitProbeResult, RunParams } from './types';
import { autotuneFor, probeFitParams, useRunners } from './runners/useRunners';
import { pickRunnerFor } from './runners/pick';
import { patchModelMeta } from './useModelMeta';

interface Props {
  filePath: string;
  /** Initial user override loaded from sidecar (if any). */
  initialUserParams?: RunParams;
  /**
   * Per-file runner override loaded from the sidecar by `ModelHubPanel`.
   * Drives the dropdown's current value; changes are persisted via
   * `patchModelMeta` and bubbled up via `onPreferredRunnerSaved`.
   */
  initialPreferredRunnerId?: string;
  /**
   * Last `llama-fit-params` probe loaded from the sidecar. When the
   * stored probe matches the current params + runner, we show it
   * immediately and skip the ~5 s spawn; mismatch triggers a fresh
   * probe in the background.
   */
  initialFitProbe?: FitProbeResult;
  onSaved?: (next: RunParams | undefined) => void;
  /**
   * Notifies the parent when the runner choice changes, so it can keep its
   * cached `meta` in sync (and therefore feed `RunModelButton` the same
   * value `pickRunnerFor` will use at launch).
   */
  onPreferredRunnerSaved?: (next: string | undefined) => void;
  /** Notifies the parent when a new fit probe lands in the sidecar. */
  onFitProbeSaved?: (next: FitProbeResult | undefined) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
const SAVE_DEBOUNCE_MS = 800;

interface FieldDef {
  key: keyof RunParams;
  /** i18n key suffix; the full key is `core:mhParam${labelKey}`. */
  labelKey: string;
  /** i18n key suffix for the tooltip help. */
  helpKey: string;
  type: 'number' | 'boolean';
  min?: number;
  max?: number;
  /**
   * When true, this row is disabled while `fit` is on — llama-server
   * computes the value itself at boot from free VRAM and ignores any
   * explicit override. Toggling fit off re-enables the row.
   */
  managedByFit?: boolean;
}

const FIELDS: FieldDef[] = [
  {
    key: 'fit',
    labelKey: 'AutoFit',
    helpKey: 'AutoFitHelp',
    type: 'boolean',
  },
  {
    key: 'ngl',
    labelKey: 'GpuLayers',
    helpKey: 'GpuLayersHelp',
    type: 'number',
    min: -1,
    managedByFit: true,
  },
  {
    key: 'ctx',
    labelKey: 'ContextSize',
    helpKey: 'ContextSizeHelp',
    type: 'number',
    min: 128,
    managedByFit: true,
  },
  {
    key: 'batchSize',
    labelKey: 'BatchSize',
    helpKey: 'BatchSizeHelp',
    type: 'number',
    min: 1,
    managedByFit: true,
  },
  {
    key: 'threads',
    labelKey: 'Threads',
    helpKey: 'ThreadsHelp',
    type: 'number',
    min: 1,
  },
  {
    key: 'port',
    labelKey: 'ServerPort',
    helpKey: 'ServerPortHelp',
    type: 'number',
    min: 1,
    max: 65535,
  },
  {
    key: 'flashAttn',
    labelKey: 'FlashAttn',
    helpKey: 'FlashAttnHelp',
    type: 'boolean',
  },
  {
    key: 'mlock',
    labelKey: 'Mlock',
    helpKey: 'MlockHelp',
    type: 'boolean',
  },
];

function formatVal(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

export default function RunParamsEditor({
  filePath,
  initialUserParams,
  initialPreferredRunnerId,
  initialFitProbe,
  onSaved,
  onPreferredRunnerSaved,
  onFitProbeSaved,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const { runners } = useRunners();
  const [estimated, setEstimated] = useState<RunParams | undefined>();
  const [user, setUser] = useState<Partial<RunParams>>(initialUserParams ?? {});
  const [preferredRunner, setPreferredRunner] = useState<string | undefined>(
    initialPreferredRunnerId,
  );
  const [fitProbe, setFitProbe] = useState<FitProbeResult | undefined>(
    initialFitProbe,
  );
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | undefined>();
  const [loadingEst, setLoadingEst] = useState(true);
  const [estError, setEstError] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>('idle');
  const [saveErr, setSaveErr] = useState<string | undefined>();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const probeDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  /** Monotonic id — lets us drop stale probe results when params change mid-flight. */
  const probeGenerationRef = useRef(0);
  const filePathRef = useRef(filePath);

  // Reset state when the user opens another file.
  useEffect(() => {
    filePathRef.current = filePath;
    setUser(initialUserParams ?? {});
    setPreferredRunner(initialPreferredRunnerId);
    setFitProbe(initialFitProbe);
    setProbeError(undefined);
    setProbing(false);
    setSave('idle');
    setSaveErr(undefined);
  }, [filePath, initialUserParams, initialPreferredRunnerId, initialFitProbe]);

  const onRunnerChange = useCallback(
    async (next: string | undefined) => {
      const target = filePathRef.current;
      setPreferredRunner(next);
      setSave('saving');
      setSaveErr(undefined);
      try {
        const r = await patchModelMeta(target, { preferredRunnerId: next });
        if (filePathRef.current !== target) return;
        if (!r.ok) {
          setSave('error');
          setSaveErr(r.error ?? 'save failed');
          return;
        }
        setSave('saved');
        onPreferredRunnerSaved?.(next);
        setTimeout(() => {
          if (filePathRef.current === target) setSave('idle');
        }, 1500);
      } catch (e) {
        setSave('error');
        setSaveErr((e as Error).message);
      }
    },
    [onPreferredRunnerSaved],
  );

  // Fetch fresh autotune for "estimated" column. Hardware can change between
  // sessions (new GPU, more RAM), so we don't cache this across sessions.
  useEffect(() => {
    let alive = true;
    setLoadingEst(true);
    setEstError(undefined);
    autotuneFor(filePath)
      .then((r) => {
        if (!alive) return;
        if (r.ok && r.estimated) setEstimated(r.estimated);
        else setEstError(r.error ?? 'autotune failed');
      })
      .finally(() => {
        if (alive) setLoadingEst(false);
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  /**
   * Resolve the runner the probe should use. Mirrors the launch-time
   * `pickRunnerFor` so the suggestions match what'll actually run.
   * Undefined when no runner can handle the file format — the probe is
   * skipped in that case.
   */
  const probeRunner = useMemo(
    () =>
      pickRunnerFor(runners, filePath, { preferredRunnerId: preferredRunner }),
    [runners, filePath, preferredRunner],
  );

  /**
   * Estimated column values — heuristic from autotune, with llama-fit-params
   * resolved values overlaid when the probe has run successfully against
   * the current runner. The probe is more accurate than our cost-per-layer
   * heuristic, so when it has an answer for ngl/ctx/batch we surface that
   * instead. Falls back to autotune for fields the probe didn't expose.
   */
  const estimatedForUI: Partial<RunParams> | undefined = useMemo(() => {
    if (!estimated) return undefined;
    const probeSayingSomething =
      fitProbe && probeRunner && fitProbe.runnerPath === probeRunner.path;
    if (!probeSayingSomething || !fitProbe.resolved) return estimated;
    return {
      ...estimated,
      ...(fitProbe.resolved.ngl !== undefined && {
        ngl: fitProbe.resolved.ngl,
      }),
      ...(fitProbe.resolved.ctx !== undefined && {
        ctx: fitProbe.resolved.ctx,
      }),
      ...(fitProbe.resolved.batchSize !== undefined && {
        batchSize: fitProbe.resolved.batchSize,
      }),
    };
  }, [estimated, fitProbe, probeRunner]);

  /** What'll actually be used at launch — user override falls back to estimated. */
  const effective: Partial<RunParams> = useMemo(
    () => ({ ...(estimatedForUI ?? {}), ...user }),
    [estimatedForUI, user],
  );

  /**
   * Probe runs in "suggest" mode whenever fit is off — we want
   * llama-fit-params' own picks for ngl/ctx/batch to populate the
   * Estimated column, replacing our cost-per-layer heuristic.
   */
  const probeApplies = effective.fit === false;

  /**
   * Suggest-mode freshness: the resolved values are a function of
   * (runner, model). Hardware can shift between sessions, but within
   * the same session the same runner against the same model always
   * resolves to the same values, so we don't re-probe just because the
   * user reopened the editor.
   */
  const probeIsFresh = useMemo(() => {
    if (!fitProbe || !probeRunner) return false;
    return fitProbe.runnerPath === probeRunner.path;
  }, [fitProbe, probeRunner]);

  const runProbe = useCallback(async () => {
    if (!probeRunner || !probeApplies) return;
    const myGen = ++probeGenerationRef.current;
    const target = filePathRef.current;
    setProbing(true);
    setProbeError(undefined);
    try {
      const r = await probeFitParams(
        probeRunner,
        target,
        { fit: false, flashAttn: effective.flashAttn },
        { suggest: true },
      );
      if (probeGenerationRef.current !== myGen) return;
      if (filePathRef.current !== target) return;
      if (!r.ok || !r.probe) {
        setProbeError(r.error ?? 'probe failed');
        return;
      }
      setFitProbe(r.probe);
      patchModelMeta(target, { fitProbe: r.probe })
        .then(() => {
          if (filePathRef.current === target) onFitProbeSaved?.(r.probe);
        })
        .catch(() => {
          /* non-fatal — probe still surfaces in this session */
        });
    } catch (e) {
      if (probeGenerationRef.current !== myGen) return;
      setProbeError((e as Error).message);
    } finally {
      if (probeGenerationRef.current === myGen) setProbing(false);
    }
  }, [probeRunner, probeApplies, effective.flashAttn, onFitProbeSaved]);

  /**
   * Trigger the probe when fit is just turned off and the cache doesn't
   * already have a fresh answer for this runner. We don't debounce here
   * — the suggest probe doesn't depend on the user's ngl/ctx values,
   * only on the runner/model pair, so there's nothing to debounce
   * against. A flat 200 ms delay still gives React time to settle the
   * toggle state.
   */
  useEffect(() => {
    if (!probeApplies) {
      probeGenerationRef.current += 1;
      setProbing(false);
      return;
    }
    if (probeIsFresh) return;
    if (probeDebounceRef.current) clearTimeout(probeDebounceRef.current);
    probeDebounceRef.current = setTimeout(() => {
      runProbe();
    }, 200);
    return () => {
      if (probeDebounceRef.current) clearTimeout(probeDebounceRef.current);
    };
  }, [probeApplies, probeIsFresh, runProbe]);

  const persist = useCallback(
    async (next: Partial<RunParams>) => {
      const target = filePathRef.current;
      setSave('saving');
      setSaveErr(undefined);
      try {
        // Empty override → drop the field entirely so the next launch picks
        // up a fresh estimate (won't be pinned to a stale value).
        const clean: RunParams = { ...next } as RunParams;
        const isEmpty = Object.keys(clean).length === 0;
        const r = await patchModelMeta(target, {
          userRunParams: isEmpty ? undefined : clean,
        });
        if (filePathRef.current !== target) return;
        if (!r.ok) {
          setSave('error');
          setSaveErr(r.error ?? 'save failed');
          return;
        }
        setSave('saved');
        onSaved?.(isEmpty ? undefined : clean);
        setTimeout(() => {
          if (filePathRef.current === target) setSave('idle');
        }, 1500);
      } catch (e) {
        setSave('error');
        setSaveErr((e as Error).message);
      }
    },
    [onSaved],
  );

  const scheduleSave = useCallback(
    (next: Partial<RunParams>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => persist(next), SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  const setField = useCallback(
    (key: keyof RunParams, value: number | boolean | undefined) => {
      setUser((prev) => {
        const next: Partial<RunParams> = { ...prev };
        if (
          value === undefined ||
          value === null ||
          (value as unknown) === ''
        ) {
          delete next[key];
        } else {
          (next as Record<string, unknown>)[key] = value;
        }
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const resetField = useCallback(
    (key: keyof RunParams) => {
      setUser((prev) => {
        const next: Partial<RunParams> = { ...prev };
        delete next[key];
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const resetAll = useCallback(() => {
    setUser({});
    if (debounceRef.current) clearTimeout(debounceRef.current);
    persist({});
  }, [persist]);

  // `fit` is a mode switch (Auto-fit checkbox), not a numeric tuning
  // override — the checkbox itself reflects its state. Counting it in
  // the badge surfaced a confusing "(1) reset all" the moment the user
  // unchecked Auto-fit, even though nothing was actually tuned.
  const overrideCount = Object.keys(user).filter((k) => k !== 'fit').length;

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 0.5 }}
      >
        <Typography variant="subtitle2">{t('core:mhRunParams')}</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {save === 'saving' && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <CircularProgress size={10} />
              <Typography variant="caption" color="text.secondary">
                {t('core:mhSaving')}
              </Typography>
            </Stack>
          )}
          {save === 'saved' && (
            <Typography variant="caption" color="success.main">
              {t('core:mhSaved')}
            </Typography>
          )}
          {save === 'error' && (
            <Typography variant="caption" color="error">
              {saveErr ?? t('core:mhSaveFailed')}
            </Typography>
          )}
          {overrideCount > 0 && (
            <Tooltip
              title={t('core:mhResetAllTooltip', { count: overrideCount })}
              placement="left"
            >
              <Button
                size="small"
                variant="outlined"
                onClick={resetAll}
                startIcon={<RestartAltIcon sx={{ fontSize: 14 }} />}
                sx={{ minWidth: 0, px: 1, py: 0, fontSize: '0.7em' }}
              >
                {t('core:mhResetAll', { count: overrideCount })}
              </Button>
            </Tooltip>
          )}
        </Stack>
      </Stack>

      {runners.length > 0 && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ mb: 0.75 }}
        >
          <Tooltip title={t('core:mhRunnerHelp')} placement="left">
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ cursor: 'help', minWidth: 56 }}
            >
              {t('core:mhRunner')}
            </Typography>
          </Tooltip>
          <Select
            size="small"
            value={preferredRunner ?? ''}
            displayEmpty
            // Custom renderValue so the empty-string sentinel actually
            // shows the "Auto" label in the closed field. MUI's default
            // renders nothing for value="" — looked like an invisible
            // selection (black-on-black in dark mode).
            renderValue={(v) => {
              if (!v) {
                return (
                  <Typography
                    component="span"
                    variant="body2"
                    sx={{
                      fontStyle: 'italic',
                      color: 'text.secondary',
                      fontSize: '0.85em',
                    }}
                  >
                    {t('core:mhRunnerAuto')}
                  </Typography>
                );
              }
              const r = runners.find((x) => x.id === v);
              return r?.label ?? String(v);
            }}
            onChange={(e) => {
              const v = e.target.value as string;
              onRunnerChange(v === '' ? undefined : v);
            }}
            sx={{ flex: 1, fontSize: '0.85em' }}
          >
            <MenuItem value="">
              <em>{t('core:mhRunnerAuto')}</em>
            </MenuItem>
            {runners.map((r) => (
              <MenuItem key={r.id} value={r.id}>
                {r.label}
              </MenuItem>
            ))}
          </Select>
        </Stack>
      )}

      {loadingEst ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary">
            {t('core:mhEstimating')}
          </Typography>
        </Stack>
      ) : estError ? (
        <Typography variant="caption" color="error">
          {estError}
        </Typography>
      ) : (
        <>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns:
                'minmax(120px,1.4fr) minmax(80px,1fr) minmax(120px,1.4fr) auto',
              columnGap: 1,
              rowGap: 0.5,
              alignItems: 'center',
              fontSize: '0.85em',
            }}
          >
            {/* Header row */}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontWeight: 600 }}
            >
              {t('core:mhColParameter')}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontWeight: 600 }}
            >
              {t('core:mhColEstimated')}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontWeight: 600 }}
            >
              {t('core:mhColUsed')}
            </Typography>
            <Box />

            {FIELDS.map((f) => {
              const est = estimatedForUI?.[f.key];
              const userVal = user[f.key];
              const eff = effective[f.key];
              const isOverridden = userVal !== undefined;
              // `fit` on → llama-server picks ngl/ctx/batchSize itself.
              // Disable those rows so the user can't tune values that
              // the runner will ignore anyway.
              const disabled = !!f.managedByFit && effective.fit === true;
              // When the probe is running and this is one of the fields
              // it'll fill (ngl/ctx/batchSize), the est cell shows a
              // spinner instead of the stale heuristic — keeps the user
              // from acting on a number that's about to be replaced.
              const estProbing =
                probing &&
                probeApplies &&
                (f.key === 'ngl' || f.key === 'ctx' || f.key === 'batchSize');
              const estFromProbe =
                probeApplies &&
                !!fitProbe?.resolved &&
                (f.key === 'ngl' || f.key === 'ctx' || f.key === 'batchSize') &&
                fitProbe.resolved[f.key as 'ngl' | 'ctx' | 'batchSize'] !==
                  undefined;
              return (
                <ParamRow
                  key={String(f.key)}
                  field={f}
                  est={est}
                  estProbing={estProbing}
                  estFromProbe={estFromProbe}
                  effective={eff}
                  isOverridden={isOverridden}
                  disabled={disabled}
                  onChange={(v) => setField(f.key, v)}
                  onReset={() => resetField(f.key)}
                />
              );
            })}
          </Box>

          {probeApplies && (
            <FitProbeSummary
              probe={fitProbe}
              probing={probing}
              error={probeError}
              fresh={probeIsFresh}
              runnerLabel={probeRunner?.label}
              onRefresh={() => {
                if (probeDebounceRef.current)
                  clearTimeout(probeDebounceRef.current);
                runProbe();
              }}
            />
          )}

          <RationaleTooltip
            rationale={estimated?.rationale}
            probeOverrodeFields={
              probeApplies && !!fitProbe?.resolved
                ? fitProbe.resolved
                : undefined
            }
          />
        </>
      )}
    </Box>
  );
}

interface ParamRowProps {
  field: FieldDef;
  est: unknown;
  /** True while llama-fit-params is computing the value for this field. */
  estProbing?: boolean;
  /** True when the displayed est value comes from llama-fit-params (not heuristic). */
  estFromProbe?: boolean;
  effective: unknown;
  isOverridden: boolean;
  /** Greyed out + non-editable — used when --fit on subsumes this field. */
  disabled?: boolean;
  onChange: (v: number | boolean | undefined) => void;
  onReset: () => void;
}

function ParamRow({
  field,
  est,
  estProbing,
  estFromProbe,
  effective,
  isOverridden,
  disabled,
  onChange,
  onReset,
}: ParamRowProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <Tooltip title={t(`core:mhParam${field.helpKey}`)} placement="left">
        <Typography
          variant="body2"
          sx={{
            fontSize: '0.85em',
            cursor: 'help',
            color: disabled ? 'text.disabled' : 'text.primary',
          }}
        >
          {t(`core:mhParam${field.labelKey}`)}
        </Typography>
      </Tooltip>
      {estProbing ? (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <CircularProgress size={10} />
          <Typography variant="caption" color="text.secondary">
            {t('core:mhFitProbing')}
          </Typography>
        </Stack>
      ) : (
        <Tooltip
          title={estFromProbe ? t('core:mhFitProbeFromProbe') : ''}
          placement="top"
        >
          <Typography
            variant="body2"
            color={estFromProbe ? 'primary.main' : 'text.secondary'}
            sx={{
              fontSize: '0.85em',
              fontFamily: 'monospace',
              fontWeight: estFromProbe ? 600 : 400,
              cursor: estFromProbe ? 'help' : 'default',
            }}
          >
            {formatVal(est)}
          </Typography>
        </Tooltip>
      )}
      {field.type === 'number' ? (
        <TextField
          size="small"
          type="number"
          disabled={disabled}
          value={
            typeof effective === 'number' && Number.isFinite(effective)
              ? effective
              : ''
          }
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(undefined);
              return;
            }
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) onChange(n);
          }}
          slotProps={{
            input: {
              sx: { fontSize: '0.85em', fontFamily: 'monospace' },
              inputProps: {
                min: field.min,
                max: field.max,
              },
            },
          }}
          sx={{ width: '100%' }}
        />
      ) : (
        <Box>
          <Checkbox
            checked={!!effective}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            size="small"
            sx={{ p: 0.25 }}
          />
        </Box>
      )}
      {isOverridden && !disabled ? (
        <Tooltip title={t('core:mhResetToEstimated')}>
          <IconButton size="small" onClick={onReset} sx={{ p: 0.25 }}>
            <RestartAltIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      ) : (
        <Box sx={{ width: 24 }} />
      )}
    </>
  );
}

interface FitProbeSummaryProps {
  probe?: FitProbeResult;
  probing: boolean;
  error?: string;
  /** True when the cached probe matches the current runner — refresh is a no-op then. */
  fresh: boolean;
  runnerLabel?: string;
  onRefresh: () => void;
}

function formatMiB(mib: number): string {
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${mib} MiB`;
}

/**
 * Single-line memory summary below the params grid:
 *  "Memory: 13.2 GiB GPU / 0.2 GiB RAM (llama-fit-params, llama.cpp) [↻]"
 * Hover surfaces the device-by-device breakdown. Replaces the bloated
 * panel that confused the user — the breakdown matters for diagnostics
 * but doesn't deserve a whole encart in the main editor flow.
 */
function FitProbeSummary({
  probe,
  probing,
  error,
  fresh,
  runnerLabel,
  onRefresh,
}: FitProbeSummaryProps): JSX.Element {
  const { t } = useTranslation();
  const summary = probe
    ? `${formatMiB(probe.totalVramMiB ?? 0)} ${t('core:mhFitProbeGpu')} / ${formatMiB(probe.hostMiB ?? 0)} ${t('core:mhFitProbeRam')}`
    : undefined;
  const detailTooltip = probe ? (
    <Box>
      {probe.devices.map((d) => {
        const total = d.modelMiB + d.contextMiB + d.computeMiB;
        return (
          <Typography
            key={d.name}
            variant="caption"
            sx={{ display: 'block', fontFamily: 'monospace' }}
          >
            {d.name}: {formatMiB(total)} ({formatMiB(d.modelMiB)}{' '}
            {t('core:mhFitProbeWeights').toLowerCase()} +{' '}
            {formatMiB(d.contextMiB)}{' '}
            {t('core:mhFitProbeContext').toLowerCase()} +{' '}
            {formatMiB(d.computeMiB)}{' '}
            {t('core:mhFitProbeCompute').toLowerCase()})
          </Typography>
        );
      })}
    </Box>
  ) : null;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{ mt: 0.75, fontSize: '0.8em' }}
    >
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {t('core:mhFitProbeSummaryLabel')}
      </Typography>
      {probing && (
        <>
          <CircularProgress size={10} />
          <Typography variant="caption" color="text.secondary">
            {t('core:mhFitProbing')}
          </Typography>
        </>
      )}
      {!probing && error && (
        <Tooltip title={error} placement="top">
          <Typography
            variant="caption"
            color="error"
            sx={{ cursor: 'help', textDecoration: 'underline dotted' }}
          >
            {t('core:mhFitProbeFailed')}
          </Typography>
        </Tooltip>
      )}
      {!probing && !error && probe && (
        <Tooltip title={detailTooltip ?? ''} placement="top">
          <Typography
            variant="caption"
            sx={{
              fontFamily: 'monospace',
              cursor: 'help',
              textDecoration: 'underline dotted',
            }}
          >
            {summary}
          </Typography>
        </Tooltip>
      )}
      {!probing && !error && !probe && (
        <Typography variant="caption" color="text.secondary">
          {t('core:mhFitProbeWaiting')}
        </Typography>
      )}
      {runnerLabel && (
        <Typography variant="caption" color="text.secondary">
          · {runnerLabel}
        </Typography>
      )}
      <Box sx={{ flex: 1 }} />
      <Tooltip
        title={fresh ? t('core:mhFitProbeFresh') : t('core:mhFitProbeRefresh')}
      >
        <span>
          <IconButton
            size="small"
            onClick={onRefresh}
            disabled={probing}
            sx={{ p: 0.25 }}
          >
            <RefreshIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

interface RationaleTooltipProps {
  rationale?: string[];
  /**
   * When set, llama-fit-params owns these fields — drop the autotune
   * rationale lines for them (they'd contradict the displayed value)
   * and add an explicit "from llama-fit-params" header instead.
   */
  probeOverrodeFields?: {
    ngl?: number;
    ctx?: number;
    batchSize?: number;
  };
}

/**
 * "Pourquoi ces estimations ?" pop-over. Filters out autotune lines for
 * fields the probe has overridden — surfacing the heuristic for `ngl`
 * after llama-fit-params already gave us a different number would
 * read as a contradiction. Adds a leading line when the probe owns
 * any field so the user knows where those numbers came from.
 */
function RationaleTooltip({
  rationale,
  probeOverrodeFields,
}: RationaleTooltipProps): JSX.Element | null {
  const { t } = useTranslation();
  const probeOwnsAny =
    !!probeOverrodeFields &&
    (probeOverrodeFields.ngl !== undefined ||
      probeOverrodeFields.ctx !== undefined ||
      probeOverrodeFields.batchSize !== undefined);
  const filtered = useMemo(() => {
    if (!rationale) return [] as string[];
    return rationale.filter((line) => {
      // Drop the `fit:` line entirely — that decision is owned by the
      // Auto-fit checkbox state, not by the heuristic.
      if (/^fit:/i.test(line)) return false;
      if (probeOverrodeFields?.ngl !== undefined && /^ngl:/i.test(line))
        return false;
      if (probeOverrodeFields?.ctx !== undefined && /^ctx:/i.test(line))
        return false;
      if (
        probeOverrodeFields?.batchSize !== undefined &&
        /^batch.size:/i.test(line)
      )
        return false;
      return true;
    });
  }, [rationale, probeOverrodeFields]);

  if (filtered.length === 0 && !probeOwnsAny) return null;
  return (
    <Tooltip
      title={
        <Box>
          {probeOwnsAny && (
            <Typography
              variant="caption"
              sx={{ display: 'block', fontWeight: 600, mb: 0.25 }}
            >
              {t('core:mhRationaleProbe')}
            </Typography>
          )}
          {filtered.map((r, i) => (
            <Typography key={i} variant="caption" sx={{ display: 'block' }}>
              • {r}
            </Typography>
          ))}
        </Box>
      }
      placement="top-start"
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'block',
          mt: 0.75,
          cursor: 'help',
          textDecoration: 'underline dotted',
        }}
      >
        {t('core:mhWhyEstimates')}
      </Typography>
    </Tooltip>
  );
}
