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
import { RunParams } from './types';
import { autotuneFor, useRunners } from './runners/useRunners';
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
  onSaved?: (next: RunParams | undefined) => void;
  /**
   * Notifies the parent when the runner choice changes, so it can keep its
   * cached `meta` in sync (and therefore feed `RunModelButton` the same
   * value `pickRunnerFor` will use at launch).
   */
  onPreferredRunnerSaved?: (next: string | undefined) => void;
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
  onSaved,
  onPreferredRunnerSaved,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const { runners } = useRunners();
  const [estimated, setEstimated] = useState<RunParams | undefined>();
  const [user, setUser] = useState<Partial<RunParams>>(initialUserParams ?? {});
  const [preferredRunner, setPreferredRunner] = useState<string | undefined>(
    initialPreferredRunnerId,
  );
  const [loadingEst, setLoadingEst] = useState(true);
  const [estError, setEstError] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>('idle');
  const [saveErr, setSaveErr] = useState<string | undefined>();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const filePathRef = useRef(filePath);

  // Reset state when the user opens another file.
  useEffect(() => {
    filePathRef.current = filePath;
    setUser(initialUserParams ?? {});
    setPreferredRunner(initialPreferredRunnerId);
    setSave('idle');
    setSaveErr(undefined);
  }, [filePath, initialUserParams, initialPreferredRunnerId]);

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

  /** What'll actually be used at launch — user override falls back to estimated. */
  const effective: Partial<RunParams> = useMemo(
    () => ({ ...(estimated ?? {}), ...user }),
    [estimated, user],
  );

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

  const overrideCount = Object.keys(user).length;

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
            <Button
              size="small"
              variant="outlined"
              onClick={resetAll}
              startIcon={<RestartAltIcon sx={{ fontSize: 14 }} />}
              sx={{ minWidth: 0, px: 1, py: 0, fontSize: '0.7em' }}
            >
              {t('core:mhResetAll', { count: overrideCount })}
            </Button>
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
              const est = estimated?.[f.key];
              const userVal = user[f.key];
              const eff = effective[f.key];
              const isOverridden = userVal !== undefined;
              // `fit` on → llama-server picks ngl/ctx/batchSize itself.
              // Disable those rows so the user can't tune values that
              // the runner will ignore anyway.
              const disabled = !!f.managedByFit && effective.fit === true;
              return (
                <ParamRow
                  key={String(f.key)}
                  field={f}
                  est={est}
                  effective={eff}
                  isOverridden={isOverridden}
                  disabled={disabled}
                  onChange={(v) => setField(f.key, v)}
                  onReset={() => resetField(f.key)}
                />
              );
            })}
          </Box>

          {estimated?.rationale && estimated.rationale.length > 0 && (
            <Tooltip
              title={
                <Box>
                  {estimated.rationale.map((r, i) => (
                    <Typography
                      key={i}
                      variant="caption"
                      sx={{ display: 'block' }}
                    >
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
          )}
        </>
      )}
    </Box>
  );
}

interface ParamRowProps {
  field: FieldDef;
  est: unknown;
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
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontSize: '0.85em', fontFamily: 'monospace' }}
      >
        {formatVal(est)}
      </Typography>
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
