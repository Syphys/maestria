/**
 * Compact code-block summary of the Hugging Face enrichment for a model.
 *
 * Rendered at the top of the Description tab — the canonical place for
 * "what is this model" content. The earlier dl/dt/dd version was visually
 * heavy and competed with the Properties tab. A monospace YAML-ish code
 * block keeps the same data dense and scannable.
 */

import { Box } from '@mui/material';
import type { HfMeta } from './types';

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
  if (hf.tags && hf.tags.length > 0)
    lines.push(`tags: [${hf.tags.join(', ')}]`);
  return lines.join('\n');
}

export function HfBlock({ hf }: { hf: HfMeta }): JSX.Element {
  const yaml = buildYaml(hf);
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        borderRadius: 1,
        bgcolor: 'action.hover',
        fontFamily: 'monospace',
        fontSize: '0.85em',
        lineHeight: 1.4,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowX: 'auto',
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
        {yaml}
      </Box>
    </Box>
  );
}

export default HfBlock;
