/**
 * Onboarding + management dialog for the user's llama.cpp binaries.
 *
 * Models Hub launches every model through a llama.cpp `llama-server` (or
 * a fork like ik_llama.cpp that exposes the same CLI). The user typically
 * has one or two of those binaries on disk; this dialog lists them with
 * a delete button each.
 *
 * - "Re-scan" button retriggers PATH/known-dir detection.
 * - "Add manually…" reveals a small form to point at a binary by hand.
 * - "Edit" pencil per row reuses the same form to amend an existing
 *   entry without going through delete-then-re-add. The id is
 *   preserved so the entry keeps its place in the priority ordering.
 * - Links out to the upstream installer when the list is empty.
 *
 * The dialog is intentionally self-contained (no Redux dependency) so it
 * can be opened from any context that has access to a Material-UI provider.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { RunnerConfig } from '../types';
import { useRunners } from './useRunners';
import { selectLlamaServerBinaryDialog } from '-/services/utils-io';

interface Props {
  open: boolean;
  onClose: () => void;
}

const LLAMA_CPP_RELEASES = 'https://github.com/ggml-org/llama.cpp/releases';

function RunnerForm({
  initial,
  onSubmit,
  onCancel,
}: {
  /** When set, the form is in edit mode: preserves id + other fields. */
  initial?: RunnerConfig;
  onSubmit: (r: RunnerConfig) => void;
  onCancel: () => void;
}): JSX.Element {
  const [path, setPath] = useState(initial?.path ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const isEdit = !!initial;

  const submit = () => {
    if (!path.trim()) return;
    const basename = path.trim().split(/[\\/]/).pop() ?? 'llama-server';
    const finalLabel = label.trim() || `llama-server (${basename})`;
    if (initial) {
      // Edit mode: preserve everything else (id, version, capabilities,
      // autoDetected flag, priority — keeps the entry's place in the
      // priority ordering).
      onSubmit({ ...initial, label: finalLabel, path: path.trim() });
    } else {
      onSubmit({
        id: '', // main process assigns
        label: finalLabel,
        path: path.trim(),
        capabilities: { gguf: true, safetensors: false },
        autoDetected: false,
        priority: 50,
      });
    }
  };

  return (
    <Stack
      spacing={1.5}
      sx={{ mt: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}
    >
      <Typography variant="subtitle2">
        {isEdit ? 'Edit llama.cpp binary' : 'Add a llama.cpp binary'}
      </Typography>
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
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title="Browse…">
                <IconButton
                  size="small"
                  edge="end"
                  onClick={async () => {
                    const picked = await selectLlamaServerBinaryDialog();
                    if (Array.isArray(picked) && picked[0]) {
                      setPath(picked[0]);
                    }
                  }}
                  data-tid="browseRunnerBinaryTID"
                >
                  <FolderOpenIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        }}
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
          {isEdit ? 'Save' : 'Add'}
        </Button>
      </Stack>
    </Stack>
  );
}

export default function RunnerSetupDialog({
  open,
  onClose,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const { runners, loading, detect, save, remove } = useRunners();
  const [adding, setAdding] = useState(false);
  /** id of the runner currently being edited, or undefined when none. */
  const [editingId, setEditingId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const onSubmit = useCallback(
    async (r: RunnerConfig) => {
      try {
        setError(undefined);
        await save(r);
        setAdding(false);
        setEditingId(undefined);
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
        if (editingId === id) setEditingId(undefined);
        await remove(id);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [remove, editingId],
  );

  const onStartEdit = useCallback((id: string) => {
    setAdding(false);
    setEditingId(id);
  }, []);

  const editingRunner = editingId
    ? runners.find((r) => r.id === editingId)
    : undefined;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Your llama.cpp binaries</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            Models Hub launches each model through a llama.cpp{' '}
            <code>llama-server</code>. Binaries found in PATH or in the usual
            build dirs (<code>~/llama.cpp/build/bin</code>,{' '}
            <code>~/ik_llama.cpp/build/bin</code>, …) are detected
            automatically. You can add more by hand.
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
                No llama.cpp binary detected. Install one then click
                <strong> Re-scan</strong>:
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                  onClick={() => {
                    // `window.open()` in Electron pops a blank
                    // BrowserWindow instead of deferring to the OS
                    // browser (the renderer's setWindowOpenHandler
                    // path is flaky in prod builds). Go through the
                    // explicit IPC → `shell.openExternal` route.
                    window.electronIO?.ipcRenderer.sendMessage(
                      'openUrl',
                      LLAMA_CPP_RELEASES,
                    );
                  }}
                >
                  llama.cpp releases
                </Button>
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
              <Tooltip title="Edit">
                <IconButton
                  size="small"
                  onClick={() => onStartEdit(r.id)}
                  data-tid={`editRunner_${r.id}TID`}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
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

          {editingRunner ? (
            <RunnerForm
              // key forces a fresh mount when the user switches from
              // editing runner A to editing runner B — without it the
              // local useState in RunnerForm keeps A's values.
              key={`edit-${editingRunner.id}`}
              initial={editingRunner}
              onSubmit={onSubmit}
              onCancel={() => setEditingId(undefined)}
            />
          ) : adding ? (
            <RunnerForm
              key="add"
              onSubmit={onSubmit}
              onCancel={() => setAdding(false)}
            />
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
