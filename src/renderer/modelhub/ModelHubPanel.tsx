/**
 * Side-panel section displayed inside EntryProperties for model files.
 * Renders parsed header info, auto-tags, and HF enrichment status, with
 * action buttons to trigger local + HF enrichment.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { isSupportedModelFile } from './parsers';
import {
  enrichModelMeta,
  enrichModelMetaHf,
  fetchModelMeta,
} from './useModelMeta';
import { ModelMeta, HeaderMeta, HfMeta } from './types';
import RunModelButton from './runners/RunModelButton';
import { canonicalShardName, detectShardInfo, isCanonicalShard } from './shard';
import ModelNotesEditor from './ModelNotesEditor';
import RunParamsEditor from './RunParamsEditor';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || n <= 0) return '—';
  const GB = 1_000_000_000;
  const MB = 1_000_000;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
  return `${n} B`;
}

interface Props {
  filePath?: string;
  /** When true, sidecar writes are skipped (read-only location). */
  readOnly?: boolean;
}

function formatNumber(n: number | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function HeaderBlock({ header }: { header: HeaderMeta }): JSX.Element {
  const rows: Array<[string, React.ReactNode]> = [];
  rows.push(['Format', header.format]);
  if (header.architecture && header.architecture !== 'unknown')
    rows.push(['Architecture', String(header.architecture)]);
  if (header.name) rows.push(['Name', header.name]);
  if (header.basename && header.basename !== header.name)
    rows.push(['Basename', header.basename]);
  if (header.author) rows.push(['Author', header.author]);
  // Parameters = abstract model size (capability tier). `sizeLabel` from the
  // GGUF author wins; fall back to derived `paramCount`.
  if (header.sizeLabel) {
    rows.push(['Parameters', header.sizeLabel]);
  } else if (header.paramCount) {
    rows.push(['Parameters', formatNumber(header.paramCount)]);
  }
  if (header.quantization) rows.push(['Quantization', header.quantization]);
  // Disk = physical bytes on disk. For sharded sets we want the aggregate;
  // single-file fall back to the lone file size. The shard banner above
  // already shows the same number when sharded — this row is the single
  // source for the non-sharded case.
  const physicalBytes = header.totalBytes ?? header.fileSize;
  if (physicalBytes && (!header.shardCount || header.shardCount <= 1)) {
    rows.push(['Disk', formatBytes(physicalBytes)]);
  }
  if (header.contextMax)
    rows.push(['Context max', header.contextMax.toLocaleString()]);
  if (header.embeddingDim)
    rows.push(['Embedding dim', header.embeddingDim.toLocaleString()]);
  if (header.blockCount) rows.push(['Blocks', header.blockCount]);
  if (header.headCount) rows.push(['Attn heads', header.headCount]);
  if (header.modality) rows.push(['Modality', header.modality]);
  if (header.isLora) rows.push(['Type', 'LoRA / adapter']);

  const isSharded = !!header.shardCount && header.shardCount > 1;
  const expectedTotal = header.shardInfo?.total;
  const incomplete =
    isSharded && expectedTotal && (header.shardCount ?? 0) < expectedTotal;

  return (
    <Box>
      {isSharded && (
        <Box
          sx={{
            mb: 0.75,
            p: 0.75,
            borderRadius: 1,
            bgcolor: incomplete ? 'warning.light' : 'action.hover',
            color: incomplete ? 'warning.contrastText' : 'text.primary',
            fontSize: '0.85em',
          }}
        >
          {header.shardCount} shard{header.shardCount === 1 ? '' : 's'}
          {expectedTotal && expectedTotal !== header.shardCount
            ? ` / ${expectedTotal} expected`
            : ''}
          {' · '}
          {formatBytes(header.totalBytes)} total
          {incomplete && ' · ⚠ incomplete set'}
        </Box>
      )}
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        File header
      </Typography>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 1.5,
          rowGap: 0.25,
          fontSize: '0.85em',
        }}
      >
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <Box component="dt" sx={{ color: 'text.secondary' }}>
              {k}
            </Box>
            <Box component="dd" sx={{ m: 0, color: 'text.primary' }}>
              {v}
            </Box>
          </React.Fragment>
        ))}
      </Box>
      {header.warnings && header.warnings.length > 0 && (
        <Typography
          variant="caption"
          color="warning.main"
          sx={{ display: 'block', mt: 0.5 }}
        >
          {header.warnings.length} parser warning(s)
        </Typography>
      )}
    </Box>
  );
}

function HfBlock({ hf }: { hf: HfMeta }): JSX.Element {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Hugging Face
      </Typography>
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 1.5,
          rowGap: 0.25,
          fontSize: '0.85em',
        }}
      >
        <Box component="dt" sx={{ color: 'text.secondary' }}>
          Repo
        </Box>
        <Box component="dd" sx={{ m: 0, color: 'text.primary' }}>
          <a
            href={`https://huggingface.co/${hf.repo}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {hf.repo}
          </a>
        </Box>
        {hf.license && (
          <>
            <Box component="dt" sx={{ color: 'text.secondary' }}>
              License
            </Box>
            <Box component="dd" sx={{ m: 0, color: 'text.primary' }}>
              {hf.license}
            </Box>
          </>
        )}
        {hf.pipelineTag && (
          <>
            <Box component="dt" sx={{ color: 'text.secondary' }}>
              Pipeline
            </Box>
            <Box component="dd" sx={{ m: 0, color: 'text.primary' }}>
              {hf.pipelineTag}
            </Box>
          </>
        )}
        {typeof hf.downloads === 'number' && (
          <>
            <Box component="dt" sx={{ color: 'text.secondary' }}>
              Downloads
            </Box>
            <Box component="dd" sx={{ m: 0, color: 'text.primary' }}>
              {hf.downloads.toLocaleString()}
            </Box>
          </>
        )}
        {hf.lastModified && (
          <>
            <Box component="dt" sx={{ color: 'text.secondary' }}>
              Last modified
            </Box>
            <Box component="dd" sx={{ m: 0, color: 'text.primary' }}>
              {new Date(hf.lastModified).toLocaleDateString()}
            </Box>
          </>
        )}
      </Box>
      {/* Description used to live here too, but it's now rendered as the
          full preview surface (ModelFilePreview, replacing FileView in
          EntryContainer). Keeping it in both places duplicates a couple
          hundred kB of model-card HTML in the layout for no reason. */}
    </Box>
  );
}

export function ModelHubPanel({
  filePath,
  readOnly,
}: Props): JSX.Element | null {
  const [meta, setMeta] = useState<ModelMeta | undefined>();
  const [busy, setBusy] = useState<'idle' | 'local' | 'hf'>('idle');
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();

  const supported = !!filePath && isSupportedModelFile(filePath);

  useEffect(() => {
    let cancelled = false;
    setMeta(undefined);
    setError(undefined);
    setInfo(undefined);
    if (!supported || !filePath) return;
    fetchModelMeta(filePath)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message ?? 'load failed');
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, supported]);

  const { reloadOpenedFile } = useOpenedEntryContext();

  const onEnrichLocal = useCallback(async () => {
    if (!filePath) return;
    setBusy('local');
    setError(undefined);
    setInfo(undefined);
    try {
      const result = await enrichModelMeta(filePath, { skipWrite: !!readOnly });
      if (result.ok && result.modelMeta) {
        setMeta(result.modelMeta);
        setInfo(
          result.written
            ? 'Sidecar updated with header + auto-tags.'
            : 'Computed in memory (read-only or skipWrite).',
        );
        // Refresh `openedEntry` from disk so the standard TagSpaces tag
        // area picks up the new system tags written to the sidecar.
        // Without this, the panel state updates but the tags above the
        // panel stay stuck on the pre-write snapshot — that's how the
        // user kept seeing duplicates after Parse Header.
        if (result.written) {
          try {
            await reloadOpenedFile();
          } catch {
            /* non-fatal */
          }
        }
      } else {
        setError(result.error ?? 'enrich failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  const onEnrichHf = useCallback(async () => {
    if (!filePath) return;
    setBusy('hf');
    setError(undefined);
    setInfo(undefined);
    try {
      const result = await enrichModelMetaHf(filePath, {
        skipWrite: !!readOnly,
      });
      if (result.ok && result.modelMeta) {
        setMeta(result.modelMeta);
        const cached = result.fromCache ? ' (cached)' : '';
        setInfo(
          `Matched ${result.matchedRepo}${cached}.${
            result.written ? ' Sidecar updated.' : ''
          }`,
        );
        if (result.written) {
          try {
            await reloadOpenedFile();
          } catch {
            /* non-fatal */
          }
        }
      } else {
        setError(result.error ?? 'HF enrich failed');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('idle');
    }
  }, [filePath, readOnly, reloadOpenedFile]);

  if (!supported) return null;

  // When the user opens a non-canonical shard (e.g. shard 7/12), surface a
  // pointer to the canonical entry so they understand why the metadata + Run
  // button are tied to a different file. We don't auto-navigate — the
  // location/file manager is the user's, not ours to pilot.
  const fileBase = filePath ? basename(filePath) : '';
  const nonCanonical =
    !!fileBase && !!detectShardInfo(fileBase) && !isCanonicalShard(fileBase);
  const canonicalSibling = nonCanonical ? canonicalShardName(fileBase) : '';

  const header = meta?.header;
  const hf = meta?.huggingface;

  return (
    <Box
      data-tid="modelhubPanel"
      sx={{
        mt: 2,
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 1 }}
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="subtitle1">Models Hub</Typography>
        {nonCanonical && (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ width: '100%', display: 'block', mt: -0.5 }}
          >
            This is a non-canonical shard. Metadata + Run apply to the canonical
            sibling: <code>{canonicalSibling}</code>.
          </Typography>
        )}
        <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
          {filePath && <RunModelButton filePath={filePath} />}
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== 'idle'}
            onClick={onEnrichLocal}
            startIcon={
              busy === 'local' ? <CircularProgress size={14} /> : undefined
            }
          >
            Parse header
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== 'idle'}
            onClick={onEnrichHf}
            startIcon={
              busy === 'hf' ? <CircularProgress size={14} /> : undefined
            }
          >
            Fetch from HF
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Typography
          variant="caption"
          color="error"
          sx={{ display: 'block', mb: 1 }}
        >
          {error}
        </Typography>
      )}
      {info && (
        <Typography
          variant="caption"
          color="success.main"
          sx={{ display: 'block', mb: 1 }}
        >
          {info}
        </Typography>
      )}

      {!header && !hf && busy === 'idle' && (
        <Typography variant="body2" color="text.secondary">
          No metadata yet. Click <strong>Parse header</strong> for instant
          offline metadata, or <strong>Fetch from HF</strong> to enrich with
          Hugging Face description, license, and dates.
        </Typography>
      )}

      <Stack spacing={1.5} divider={<Divider flexItem />}>
        {/* Auto-tags row removed: the same tags are already rendered as
            locked system chips in the standard TagSpaces tag area above
            the panel — duplicating them here was just visual noise. */}
        {header && <HeaderBlock header={header} />}
        {hf && <HfBlock hf={hf} />}
        {filePath && (
          <RunParamsEditor
            filePath={filePath}
            initialUserParams={meta?.userRunParams}
            onSaved={(next) =>
              setMeta((prev) =>
                prev ? { ...prev, userRunParams: next } : prev,
              )
            }
          />
        )}
        {filePath && (
          <ModelNotesEditor
            filePath={filePath}
            initialNotes={meta?.userNotes}
            onSaved={(notes) =>
              setMeta((prev) =>
                prev
                  ? {
                      ...prev,
                      userNotes: notes,
                      userNotesUpdatedAt: new Date().toISOString(),
                    }
                  : prev,
              )
            }
          />
        )}
      </Stack>
    </Box>
  );
}

export default ModelHubPanel;
