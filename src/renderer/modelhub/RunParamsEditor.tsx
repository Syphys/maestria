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
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { RunParams } from './types';
import { autotuneFor } from './runners/useRunners';
import { patchModelMeta } from './useModelMeta';

interface Props {
  filePath: string;
  /** Initial user override loaded from sidecar (if any). */
  initialUserParams?: RunParams;
  onSaved?: (next: RunParams | undefined) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
const SAVE_DEBOUNCE_MS = 800;

interface FieldDef {
  key: keyof RunParams;
  label: string;
  /** Brief help shown in tooltip. */
  help: string;
  type: 'number' | 'boolean';
  min?: number;
  max?: number;
}

const FIELDS: FieldDef[] = [
  {
    key: 'ngl',
    label: 'GPU layers (-ngl)',
    help: 'How many model layers to offload to GPU. -1 = all, 0 = pure CPU.',
    type: 'number',
    min: -1,
  },
  {
    key: 'ctx',
    label: 'Context size (-c)',
    help: 'Max prompt + response tokens. Larger = more KV cache memory.',
    type: 'number',
    min: 128,
  },
  {
    key: 'threads',
    label: 'Threads (-t)',
    help: 'CPU worker threads. ≈ physical cores − 1 for best throughput.',
    type: 'number',
    min: 1,
  },
  {
    key: 'batchSize',
    label: 'Batch size (-b)',
    help: 'Logical prompt-processing batch. Bigger benefits GPU runs, hurts CPU.',
    type: 'number',
    min: 1,
  },
  {
    key: 'port',
    label: 'Server port',
    help: 'Local HTTP port for runners that expose an OpenAI-compatible API.',
    type: 'number',
    min: 1,
    max: 65535,
  },
  {
    key: 'flashAttn',
    label: 'Flash attention',
    help: 'Faster + lower memory attention. Requires GPU build with FA enabled.',
    type: 'boolean',
  },
  {
    key: 'mlock',
    label: 'mlock (lock in RAM)',
    help: 'Prevents the OS from swapping the model out. Good for desktops, risky for laptops on battery.',
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
  onSaved,
}: Props): JSX.Element {
  const [estimated, setEstimated] = useState<RunParams | undefined>();
  const [user, setUser] = useState<Partial<RunParams>>(initialUserParams ?? {});
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
    setSave('idle');
    setSaveErr(undefined);
  }, [filePath, initialUserParams]);

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
        <Typography variant="subtitle2">Run parameters</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {save === 'saving' && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <CircularProgress size={10} />
              <Typography variant="caption" color="text.secondary">
                Saving…
              </Typography>
            </Stack>
          )}
          {save === 'saved' && (
            <Typography variant="caption" color="success.main">
              Saved
            </Typography>
          )}
          {save === 'error' && (
            <Typography variant="caption" color="error">
              {saveErr ?? 'save failed'}
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
              Reset all ({overrideCount})
            </Button>
          )}
        </Stack>
      </Stack>

      {loadingEst ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary">
            Estimating…
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
              Parameter
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontWeight: 600 }}
            >
              Estimated
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontWeight: 600 }}
            >
              Used
            </Typography>
            <Box />

            {FIELDS.map((f) => {
              const est = estimated?.[f.key];
              const userVal = user[f.key];
              const eff = effective[f.key];
              const isOverridden = userVal !== undefined;
              return (
                <ParamRow
                  key={String(f.key)}
                  field={f}
                  est={est}
                  effective={eff}
                  isOverridden={isOverridden}
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
                Why these estimates? (hover for breakdown)
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
  onChange: (v: number | boolean | undefined) => void;
  onReset: () => void;
}

function ParamRow({
  field,
  est,
  effective,
  isOverridden,
  onChange,
  onReset,
}: ParamRowProps): JSX.Element {
  return (
    <>
      <Tooltip title={field.help} placement="left">
        <Typography
          variant="body2"
          sx={{ fontSize: '0.85em', cursor: 'help', color: 'text.primary' }}
        >
          {field.label}
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
            onChange={(e) => onChange(e.target.checked)}
            size="small"
            sx={{ p: 0.25 }}
          />
        </Box>
      )}
      {isOverridden ? (
        <Tooltip title="Reset to estimated">
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
