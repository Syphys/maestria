/**
 * Replacement preview for model files (.gguf, .safetensors, …).
 *
 * The default TagSpaces FileView mounts an iframe + a viewer extension —
 * useless for a multi-GB binary. Showing the HF description instead
 * gives the preview area an actual purpose: the user lands on a model
 * file and sees what it is, not a blank "Binary model file" stub.
 *
 * Reads the cached `modelMeta` produced by enrichment. If no HF data is
 * present yet (user hasn't clicked "Fetch from HF" or auto-enrichment
 * is still running), we show a soft hint pointing at the panel; the
 * panel itself remains the source of truth for actions.
 */

import { useEffect, useState } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { fetchModelMeta } from './useModelMeta';
import { renderMarkdown } from './hfMarkdown';
import { ModelMeta } from './types';

interface Props {
  filePath: string;
}

export default function ModelFilePreview({ filePath }: Props): JSX.Element {
  const [meta, setMeta] = useState<ModelMeta | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMeta(undefined);
    fetchModelMeta(filePath)
      .then((m) => {
        if (alive) {
          setMeta(m);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  const hf = meta?.huggingface;
  const description = hf?.descriptionEN;

  if (loading) {
    return (
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ p: 3, color: 'text.secondary' }}
      >
        <CircularProgress size={14} />
        <Typography variant="body2">Loading model metadata…</Typography>
      </Stack>
    );
  }

  if (!description) {
    return (
      <Stack spacing={1} sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <AutoAwesomeIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          <Typography variant="subtitle1">
            {meta?.header?.name ?? meta?.header?.basename ?? 'Model file'}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          No Hugging Face description yet. Open the <strong>Models Hub</strong>{' '}
          panel on the right and click <strong>Fetch from HF</strong> to pull
          the model card.
        </Typography>
        {meta?.header?.warnings && meta.header.warnings.length > 0 && (
          <Typography variant="caption" color="warning.main">
            {meta.header.warnings.length} parser warning(s)
          </Typography>
        )}
      </Stack>
    );
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 2.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <Typography variant="subtitle1" sx={{ flex: 1 }}>
          {meta?.header?.name ?? meta?.header?.basename ?? 'Model'}
          {hf?.repo && (
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ ml: 1 }}
            >
              · {hf.repo}
            </Typography>
          )}
        </Typography>
      </Stack>
      <Box
        sx={(theme) => ({
          fontSize: '0.9em',
          color: 'text.primary',
          '& img': { maxWidth: '100%', height: 'auto' },
          '& pre': {
            overflowX: 'auto',
            backgroundColor:
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.06)'
                : 'rgba(0,0,0,0.04)',
            color: 'text.primary',
            p: 1,
            borderRadius: 0.5,
            fontSize: '0.9em',
          },
          '& code': {
            fontSize: '0.95em',
            backgroundColor:
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(0,0,0,0.05)',
            px: 0.5,
            borderRadius: 0.25,
          },
          '& pre code': { backgroundColor: 'transparent', p: 0 },
          '& a': { color: 'primary.main', textDecoration: 'underline' },
          '& table': { borderCollapse: 'collapse', my: 0.75 },
          '& th, & td': {
            border: 1,
            borderColor: 'divider',
            px: 0.75,
            py: 0.35,
            color: 'text.primary',
          },
          '& th': {
            backgroundColor:
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(0,0,0,0.05)',
            fontWeight: 600,
          },
          '& h1, & h2, & h3, & h4': {
            mt: 1.5,
            mb: 0.75,
            fontWeight: 600,
            color: 'text.primary',
          },
          '& h1': { fontSize: '1.4em' },
          '& h2': { fontSize: '1.2em' },
          '& h3': { fontSize: '1.05em' },
          '& p': { my: 0.75, color: 'text.primary', lineHeight: 1.55 },
          '& ul, & ol': { pl: 2.5, my: 0.5 },
          '& blockquote': {
            borderLeft: 3,
            borderColor: 'divider',
            pl: 1.25,
            ml: 0,
            color: 'text.secondary',
          },
        })}
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(description, hf?.repo).html,
        }}
      />
    </Box>
  );
}
