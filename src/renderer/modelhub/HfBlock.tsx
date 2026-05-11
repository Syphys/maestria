/**
 * Hugging Face encart shown at the top of the Description tab.
 *
 * Two sections inside a single bordered Box:
 *  1. Metadata — repo / license / pipeline / downloads / last_modified / tags
 *     in a monospace YAML code block.
 *  2. Model card — `descriptionEN` rendered as sanitized markdown HTML
 *     (same renderer as the in-app chat). Relative `src` / `href` are
 *     absolutized against `huggingface.co/<repo>` so images load correctly.
 *
 * Read-only and visually distinct from the manual description editor that
 * sits below it.
 */

import {
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { HfMeta } from './types';
import { renderMarkdown } from './hfMarkdown';

function buildYaml(hf: HfMeta): string {
  const lines: string[] = [];
  lines.push(`repo: ${hf.repo}`);
  if (hf.license) lines.push(`license: ${hf.license}`);
  if (hf.pipelineTag) lines.push(`pipeline: ${hf.pipelineTag}`);
  if (typeof hf.downloads === 'number') {
    lines.push(`downloads: ${hf.downloads.toLocaleString()}`);
  }
  if (typeof hf.likes === 'number') lines.push(`likes: ${hf.likes}`);
  if (hf.lastModified) {
    lines.push(
      `last_modified: ${new Date(hf.lastModified).toLocaleDateString()}`,
    );
  }
  if (hf.tags && hf.tags.length > 0) {
    lines.push(`tags: [${hf.tags.join(', ')}]`);
  }
  return lines.join('\n');
}

export interface HfBlockProps {
  hf: HfMeta;
  /** Re-runs the HF enrichment (re-fetch model card + metadata). */
  onRefresh?: () => void;
  /** Removes the HF block from the sidecar — the encart disappears. */
  onRemove?: () => void;
  /** When non-idle, the in-header action buttons spin / disable. */
  busy?: 'idle' | 'hf' | 'resetHf' | string;
  /** Refresh / remove tooltips (i18n strings, passed in from caller). */
  refreshLabel?: string;
  removeLabel?: string;
}

export function HfBlock({
  hf,
  onRefresh,
  onRemove,
  busy = 'idle',
  refreshLabel,
  removeLabel,
}: HfBlockProps): JSX.Element {
  const description = hf.descriptionEN?.trim();
  const html = description
    ? renderMarkdown(description, hf.repo).html
    : undefined;
  const refreshing = busy === 'hf';
  const removing = busy === 'resetHf';
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.25,
        mb: 1,
        bgcolor: 'action.hover',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 0.5 }}
      >
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}
        >
          Hugging Face
        </Typography>
        {(onRefresh || onRemove) && (
          <Stack direction="row" spacing={0.25}>
            {onRefresh && (
              <Tooltip title={refreshLabel ?? 'Refresh'} arrow>
                <span>
                  <IconButton
                    size="small"
                    onClick={onRefresh}
                    disabled={busy !== 'idle'}
                  >
                    {refreshing ? (
                      <CircularProgress size={14} />
                    ) : (
                      <RefreshIcon fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {onRemove && (
              <Tooltip title={removeLabel ?? 'Remove'} arrow>
                <span>
                  <IconButton
                    size="small"
                    onClick={onRemove}
                    disabled={busy !== 'idle'}
                  >
                    {removing ? (
                      <CircularProgress size={14} />
                    ) : (
                      <DeleteOutlineIcon fontSize="small" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Stack>
        )}
      </Stack>
      <Box
        component="pre"
        sx={{
          m: 0,
          fontFamily: 'monospace',
          fontSize: '0.8em',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'text.primary',
        }}
      >
        <Box component="code">
          <Box
            component="a"
            href={`https://huggingface.co/${hf.repo}`}
            target="_blank"
            rel="noreferrer noopener"
            sx={{ color: 'primary.main', textDecoration: 'none' }}
          >
            # huggingface.co/{hf.repo}
          </Box>
          {'\n'}
          {buildYaml(hf)}
        </Box>
      </Box>
      {html && (
        <>
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              mt: 1.5,
              mb: 0.5,
              color: 'text.secondary',
              fontWeight: 600,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Model card
          </Typography>
          <Box
            sx={(theme) => ({
              fontSize: '0.9em',
              color: 'text.primary',
              maxHeight: 480,
              overflowY: 'auto',
              borderTop: 1,
              borderColor: 'divider',
              pt: 1,
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
              },
              '& h1': { fontSize: '1.4em' },
              '& h2': { fontSize: '1.2em' },
              '& h3': { fontSize: '1.05em' },
              '& p': { my: 0.75, lineHeight: 1.55 },
              '& ul, & ol': { pl: 2.5, my: 0.5 },
              '& blockquote': {
                borderLeft: 3,
                borderColor: 'divider',
                pl: 1.25,
                ml: 0,
                color: 'text.secondary',
              },
            })}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      )}
    </Box>
  );
}

export default HfBlock;
