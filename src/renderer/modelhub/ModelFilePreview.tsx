/**
 * Minimal placeholder for the central preview area on model files
 * (.gguf, .safetensors, …).
 *
 * The earlier version rendered the full HF model card here, which made
 * HF content visible across every right-panel tab (Properties / Description
 * / Revisions). HF info now lives in the Description tab only — see
 * `EditDescription.tsx` + `HfBlock.tsx`. This placeholder just signals
 * "binary model file" and points the user at the Description tab.
 *
 * The Models Hub side panel (right) still drives all actions
 * (Run, Parse header, Fetch from HF, run params).
 */

import { Box, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

interface Props {
  filePath: string;
}

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}

export default function ModelFilePreview({ filePath }: Props): JSX.Element {
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <AutoAwesomeIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
        <Typography variant="subtitle1">{basename(filePath)}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Binary model file. Open the <strong>Description</strong> tab on the
        right for the Hugging Face metadata + model card, and the{' '}
        <strong>Properties</strong> tab for the file header (architecture,
        parameters, quantization, …).
      </Typography>
    </Box>
  );
}
