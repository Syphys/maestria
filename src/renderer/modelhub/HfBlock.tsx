/**
 * Read-only summary of the Hugging Face enrichment for a model file.
 *
 * Lifted out of ModelHubPanel so it can also be rendered inside the
 * Description tab (EditDescription) for parity with where users naturally
 * look for descriptive metadata.
 */

import React from 'react';
import { Box, Typography } from '@mui/material';
import type { HfMeta } from './types';

export function HfBlock({ hf }: { hf: HfMeta }): JSX.Element {
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
    </Box>
  );
}

export default HfBlock;
