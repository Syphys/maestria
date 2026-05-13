/**
 * "Advanced parameters" dialog — 2-column launch-flag editor.
 *
 *   Left   →  structured form: every flag the binary advertises gets a
 *             row with checkbox + value input. Pre-fills with the
 *             default parsed from `--help`. Tooltip shows the flag's
 *             description, env var, and default value. The 8 curated
 *             flags (ngl, ctx, batch, threads, port, flashAttn, mlock,
 *             fit) are filtered out since they're already in the main
 *             editor.
 *   Right  →  free-form textarea (raw customArgs). Mirrors the form:
 *             checking a row appends a "--flag value" line; editing
 *             the textarea reparses the active set. Comments and
 *             unknown flags are preserved as-is.
 *
 * The dialog auto-probes the runner on open when no snapshot is on
 * file (so the form has something to render). A 🔄 button in the
 * title bar forces a fresh probe — useful when the user updated the
 * binary in place.
 *
 * Saved verbatim to `modelMeta.userRunParams.customArgs` as the raw
 * textarea content. `buildCommand` parses it line-by-line at launch.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { RunnerConfig } from './types';
import { parseHelpText, ParsedFlag } from './helpParser';

/** Flags already exposed as dedicated rows in the main editor — kept
 * out of the structured form so the user doesn't see them twice. */
const CURATED_FLAGS = new Set([
  '--fit',
  '--n-gpu-layers',
  '--ctx-size',
  '--batch-size',
  '--threads',
  '--port',
  '--flash-attn',
  '--mlock',
]);

interface Props {
  open: boolean;
  runner?: RunnerConfig;
  initial: string;
  onClose: () => void;
  onSave: (next: string) => void;
  onReprobe?: (runnerId: string) => Promise<void>;
}

/** Parse the raw textarea content into a Map<flagLower, value> of
 * currently-active flags. Preserves nothing else — used as a quick
 * lookup for "is this row checked / what's its current value". */
function parseActiveFlags(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const ws = line.search(/\s/);
    const flag = (ws === -1 ? line : line.slice(0, ws)).toLowerCase();
    if (!flag.startsWith('-')) continue;
    const value = ws === -1 ? '' : line.slice(ws).trim();
    map.set(flag, value);
  }
  return map;
}

/**
 * Surgically toggle / update a flag inside the raw textarea content.
 * Preserves user comments + ordering + flags we don't know about.
 * Returns the new text.
 */
function applyFlagChange(
  text: string,
  flag: string,
  enabled: boolean,
  value: string,
): string {
  const target = flag.toLowerCase();
  const lines = text.split(/\r?\n/);
  let existingIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ws = trimmed.search(/\s/);
    const f = (ws === -1 ? trimmed : trimmed.slice(0, ws)).toLowerCase();
    if (f === target) {
      existingIdx = i;
      break;
    }
  }
  const newLine = value ? `${flag} ${value}` : flag;
  if (enabled) {
    if (existingIdx >= 0) {
      lines[existingIdx] = newLine;
    } else {
      // Append, ensuring a leading newline if the previous content
      // didn't end with one. Drop a trailing empty line first to
      // avoid stacking blank lines.
      while (lines.length > 0 && !lines[lines.length - 1].trim()) {
        lines.pop();
      }
      lines.push(newLine);
    }
  } else if (existingIdx >= 0) {
    lines.splice(existingIdx, 1);
  }
  return lines.join('\n');
}

interface FlagRowProps {
  parsed: ParsedFlag;
  active: boolean;
  currentValue: string;
  onToggle: (enabled: boolean) => void;
  onValueChange: (value: string) => void;
}

function FlagRow({
  parsed,
  active,
  currentValue,
  onToggle,
  onValueChange,
}: FlagRowProps): JSX.Element {
  const displayValue = active ? currentValue : (parsed.defaultValue ?? '');
  const valueInput = (() => {
    switch (parsed.kind) {
      case 'bool-bare':
        return null;
      case 'bool-on-off':
      case 'bool-on-off-auto': {
        const opts = parsed.choices ?? ['on', 'off'];
        return (
          <Select
            size="small"
            value={displayValue || opts[0]}
            disabled={!active}
            onChange={(e) => onValueChange(String(e.target.value))}
            sx={{ flex: 1, fontSize: '0.8em' }}
          >
            {opts.map((o) => (
              <MenuItem key={o} value={o}>
                {o}
              </MenuItem>
            ))}
          </Select>
        );
      }
      case 'string':
        if (parsed.choices && parsed.choices.length >= 2) {
          return (
            <Select
              size="small"
              value={displayValue || parsed.choices[0]}
              disabled={!active}
              onChange={(e) => onValueChange(String(e.target.value))}
              sx={{ flex: 1, fontSize: '0.8em' }}
            >
              {parsed.choices.map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
            </Select>
          );
        }
        return (
          <TextField
            size="small"
            value={displayValue}
            disabled={!active}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={parsed.valueDescriptor}
            slotProps={{
              input: { sx: { fontSize: '0.8em', fontFamily: 'monospace' } },
            }}
            sx={{ flex: 1 }}
          />
        );
      case 'number':
        return (
          <TextField
            size="small"
            type="number"
            value={displayValue}
            disabled={!active}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={parsed.valueDescriptor}
            slotProps={{
              input: { sx: { fontSize: '0.8em', fontFamily: 'monospace' } },
            }}
            sx={{ flex: 1 }}
          />
        );
      case 'unknown':
      default:
        return (
          <TextField
            size="small"
            value={displayValue}
            disabled={!active}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={parsed.valueDescriptor ?? ''}
            slotProps={{
              input: { sx: { fontSize: '0.8em', fontFamily: 'monospace' } },
            }}
            sx={{ flex: 1 }}
          />
        );
    }
  })();

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{ minHeight: 32 }}
    >
      <Checkbox
        size="small"
        checked={active}
        onChange={(e) => onToggle(e.target.checked)}
        sx={{ p: 0.25 }}
      />
      <Tooltip
        title={
          <Box>
            <Typography variant="caption" sx={{ display: 'block' }}>
              {parsed.description}
            </Typography>
            {parsed.envVar && (
              <Typography
                variant="caption"
                sx={{ display: 'block', fontFamily: 'monospace', mt: 0.5 }}
              >
                env: {parsed.envVar}
              </Typography>
            )}
            {parsed.defaultValue && (
              <Typography
                variant="caption"
                sx={{ display: 'block', fontFamily: 'monospace', mt: 0.5 }}
              >
                default: {parsed.defaultValue}
              </Typography>
            )}
          </Box>
        }
        placement="left"
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: 'monospace',
            fontSize: '0.75em',
            minWidth: 0,
            flex: 1,
            cursor: 'help',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: active ? 'text.primary' : 'text.secondary',
          }}
        >
          {parsed.flag}
        </Typography>
      </Tooltip>
      <Box sx={{ flex: 1, minWidth: 80 }}>{valueInput}</Box>
    </Stack>
  );
}

export default function AdvancedParamsDialog({
  open,
  runner,
  initial,
  onClose,
  onSave,
  onReprobe,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [formFilter, setFormFilter] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setText(initial);
      setFormFilter('');
      setProbeError(undefined);
    }
  }, [open, initial]);

  const helpText = runner?.probed?.helpText ?? '';
  const parsedFlags = useMemo(() => {
    if (!helpText) return [] as ParsedFlag[];
    return parseHelpText(helpText).filter((f) => !CURATED_FLAGS.has(f.flag));
  }, [helpText]);

  const filteredFlags = useMemo(() => {
    if (!formFilter.trim()) return parsedFlags;
    const needle = formFilter.toLowerCase();
    return parsedFlags.filter(
      (f) =>
        f.flag.includes(needle) || f.description.toLowerCase().includes(needle),
    );
  }, [parsedFlags, formFilter]);

  const activeFlags = useMemo(() => parseActiveFlags(text), [text]);
  const activeCount = activeFlags.size;

  const needsProbe = open && !!runner && !helpText && !!onReprobe;
  useEffect(() => {
    if (!needsProbe || !runner || !onReprobe) return;
    let alive = true;
    setProbing(true);
    setProbeError(undefined);
    onReprobe(runner.id)
      .catch((e: Error) => {
        if (alive) setProbeError(e.message);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [needsProbe, runner, onReprobe]);

  const onManualReprobe = useCallback(async () => {
    if (!runner || !onReprobe) return;
    setProbing(true);
    setProbeError(undefined);
    try {
      await onReprobe(runner.id);
    } catch (e) {
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
    }
  }, [runner, onReprobe]);

  const onSubmit = useCallback(() => {
    onSave(text.trim());
    onClose();
  }, [onSave, onClose, text]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <span>{t('core:mhAdvParamsTitle')}</span>
          {runner && (
            <Typography variant="caption" color="text.secondary">
              · {runner.label}
            </Typography>
          )}
          {activeCount > 0 && (
            <Chip
              size="small"
              label={t('core:mhAdvParamsActiveCount', { count: activeCount })}
              color="primary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7em' }}
            />
          )}
          {probing && <CircularProgress size={12} />}
          <Box sx={{ flex: 1 }} />
          {onReprobe && (
            <Tooltip title={t('core:mhAdvParamsReprobe')}>
              <span>
                <IconButton
                  size="small"
                  onClick={onManualReprobe}
                  disabled={probing}
                  sx={{ p: 0.25 }}
                >
                  <RefreshIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {probeError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {probeError}
          </Alert>
        )}
        {probing && parsedFlags.length === 0 && (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ p: 2, justifyContent: 'center' }}
          >
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              {t('core:mhAdvParamsProbing')}
            </Typography>
          </Stack>
        )}
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{ minHeight: 520 }}
        >
          {/* LEFT: structured form */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ mb: 0.5 }}
            >
              <Typography variant="subtitle2">
                {t('core:mhAdvParamsFormTitle')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t('core:mhAdvParamsFormCount', {
                  count: parsedFlags.length,
                })}
              </Typography>
            </Stack>
            <TextField
              size="small"
              placeholder={t('core:mhAdvParamsFormFilterPlaceholder')}
              value={formFilter}
              onChange={(e) => setFormFilter(e.target.value)}
              disabled={parsedFlags.length === 0}
              sx={{ mb: 0.5 }}
            />
            {parsedFlags.length === 0 ? (
              <Alert severity="info" sx={{ mt: 0.5 }}>
                {t('core:mhAdvParamsFormEmpty')}
              </Alert>
            ) : (
              <Box
                sx={{
                  flex: 1,
                  maxHeight: 520,
                  overflowY: 'auto',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 0.5,
                  p: 0.5,
                  backgroundColor: 'background.default',
                }}
              >
                <Stack spacing={0.25}>
                  {filteredFlags.map((pf) => {
                    const active = activeFlags.has(pf.flag);
                    const currentValue = activeFlags.get(pf.flag) ?? '';
                    return (
                      <FlagRow
                        key={pf.flag}
                        parsed={pf}
                        active={active}
                        currentValue={currentValue}
                        onToggle={(enabled) => {
                          const v = currentValue || pf.defaultValue || '';
                          setText(applyFlagChange(text, pf.flag, enabled, v));
                        }}
                        onValueChange={(v) => {
                          setText(applyFlagChange(text, pf.flag, true, v));
                        }}
                      />
                    );
                  })}
                  {filteredFlags.length === 0 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontStyle: 'italic', p: 1 }}
                    >
                      {t('core:mhAdvParamsFormNoMatch')}
                    </Typography>
                  )}
                </Stack>
              </Box>
            )}
          </Box>

          {/* RIGHT: free-form textarea */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {t('core:mhAdvParamsCustomTitle')}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mb: 0.5 }}
            >
              {t('core:mhAdvParamsCustomHint')}
            </Typography>
            <TextField
              multiline
              minRows={20}
              maxRows={24}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('core:mhAdvParamsCustomPlaceholder')}
              slotProps={{
                input: {
                  sx: {
                    fontFamily: 'monospace',
                    fontSize: '0.85em',
                    alignItems: 'flex-start',
                  },
                },
              }}
              sx={{ flex: 1 }}
            />
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('core:cancel')}</Button>
        <Button variant="contained" onClick={onSubmit}>
          {t('core:save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
