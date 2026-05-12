/**
 * Onboarding + management dialog for model runners.
 *
 * - Lists detected + manually configured runners with a delete button each.
 * - "Re-scan" button retriggers PATH/known-dir detection.
 * - "Add manually…" reveals a small form to point at a binary by hand.
 * - Links out to upstream installers when the list is empty.
 *
 * The dialog is intentionally self-contained (no Redux dependency) so it can
 * be opened from any context that has access to a Material-UI provider.
 */

import { useCallback, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { RunnerConfig, RunnerKind } from '../types';
import { useRunners } from './useRunners';

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_OPTIONS: { value: RunnerKind; label: string; help: string }[] = [
  {
    value: 'llama.cpp',
    label: 'llama.cpp',
    help: 'C++ inference engine, GGUF',
  },
  {
    value: 'ik_llama.cpp',
    label: 'ik_llama.cpp',
    help: 'llama.cpp fork with extra optimizations',
  },
  { value: 'koboldcpp', label: 'KoboldCpp', help: 'GGUF + KoboldAI HTTP API' },
  { value: 'custom', label: 'Custom', help: 'Anything else with a CLI' },
];

const INSTALL_LINKS: Partial<Record<RunnerKind, string>> = {
  'llama.cpp': 'https://github.com/ggml-org/llama.cpp/releases',
  koboldcpp: 'https://github.com/LostRuins/koboldcpp/releases',
};

function ManualForm({
  onAdd,
  onCancel,
}: {
  onAdd: (r: RunnerConfig) => void;
  onCancel: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<RunnerKind>('llama.cpp');
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');

  const submit = () => {
    if (!path.trim()) return;
    onAdd({
      id: '', // main process assigns
      kind,
      label: label.trim() || `${kind} (${path.split(/[\\/]/).pop()})`,
      path: path.trim(),
      capabilities: {
        chat: true,
        server: true,
        gguf: true,
        safetensors: kind === 'llama.cpp' || kind === 'ik_llama.cpp',
      },
      autoDetected: false,
      priority: 50,
    });
  };

  return (
    <Stack
      spacing={1.5}
      sx={{ mt: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}
    >
      <Typography variant="subtitle2">Add a runner manually</Typography>
      <TextField
        select
        size="small"
        label="Kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as RunnerKind)}
      >
        {KIND_OPTIONS.map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label} — <span style={{ opacity: 0.6 }}>{o.help}</span>
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        label="Binary path"
        placeholder={
          // navigator.platform is the renderer-safe platform sniff;
          // `process` isn't injected into the renderer bundle.
          /^Win/i.test(navigator.platform)
            ? 'C:\\llama.cpp\\build\\bin\\llama-server.exe'
            : '/usr/local/bin/llama-server'
        }
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <TextField
        size="small"
        label="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={submit}
          disabled={!path.trim()}
        >
          Add
        </Button>
      </Stack>
    </Stack>
  );
}

export default function RunnerSetupDialog({
  open,
  onClose,
}: Props): JSX.Element {
  const { runners, loading, detect, save, remove } = useRunners();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const onAdd = useCallback(
    async (r: RunnerConfig) => {
      try {
        setError(undefined);
        await save(r);
        setAdding(false);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [save],
  );

  const onRemove = useCallback(
    async (id: string) => {
      try {
        setError(undefined);
        await remove(id);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [remove],
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Configure model runners</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            Models Hub launches your models through an external runner
            (llama.cpp, Ollama, …). Runners installed in PATH or in standard
            locations are detected automatically. You can add more by hand.
          </Typography>

          {runners.length === 0 && !loading && (
            <Box
              sx={{
                p: 1.5,
                borderRadius: 1,
                bgcolor: 'warning.light',
                color: 'warning.contrastText',
              }}
            >
              <Typography variant="body2">
                No runner detected. Install one of the following, then click
                <strong> Re-scan</strong>:
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
                {Object.entries(INSTALL_LINKS).map(([k, url]) => (
                  <Button
                    key={k}
                    size="small"
                    variant="outlined"
                    endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                    onClick={() => window.open(url, '_blank', 'noopener')}
                  >
                    {k}
                  </Button>
                ))}
              </Stack>
            </Box>
          )}

          {runners.map((r) => (
            <Stack
              key={r.id}
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{
                p: 1,
                borderRadius: 1,
                border: 1,
                borderColor: 'divider',
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Typography variant="subtitle2">{r.label}</Typography>
                  {r.autoDetected && (
                    <Chip
                      size="small"
                      label="auto"
                      sx={{ height: 18, fontSize: '0.65em' }}
                    />
                  )}
                </Stack>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.path}
                </Typography>
              </Box>
              <Tooltip title="Remove">
                <IconButton size="small" onClick={() => onRemove(r.id)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}

          {error && (
            <Typography variant="caption" color="error">
              {error}
            </Typography>
          )}

          {adding ? (
            <ManualForm onAdd={onAdd} onCancel={() => setAdding(false)} />
          ) : (
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={detect}
                disabled={loading}
              >
                Re-scan
              </Button>
              <Button size="small" onClick={() => setAdding(true)}>
                Add manually…
              </Button>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
