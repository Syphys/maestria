/**
 * Inférence tab — hosts the model-launch UI (`ModelHubPanel`) for any
 * file the modelhub parsers recognise (.gguf / .safetensors / .bin / …).
 *
 * The panel itself is unchanged; this wrapper exists only to keep the
 * tab-routing layer in `EntryContainerTabs` consistent (every tab is one
 * lazy-loaded React component) and to gate on the read-only location
 * flag — sidecar writes that the editor would do (preferredRunnerId,
 * userRunParams, fitProbe) must be skipped on read-only locations.
 */

import ModelHubPanel from '-/modelhub/ModelHubPanel';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { Box } from '@mui/material';

function TabInference() {
  const { openedEntry } = useOpenedEntryContext();
  const { findLocation } = useCurrentLocationContext();
  if (!openedEntry?.isFile || !openedEntry.path) return null;
  const location = findLocation(openedEntry.locationID);
  return (
    <Box sx={{ p: 1.5 }}>
      <ModelHubPanel
        filePath={openedEntry.path}
        readOnly={location?.isReadOnly}
      />
    </Box>
  );
}

export default TabInference;
