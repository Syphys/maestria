/**
 * Opens the bundled routing-questions folder (probe-anchors / tree-v0 /
 * v1-30 / mcq-v1 / qcm-v0 / embedding-triplets) inside Maestria as a
 * read-only « Maestria Tests » location. Mounted from the
 * « Voir les questions sources » buttons in CharacterizeAllPanel and
 * CompetenceSection so the user can inspect the source-of-truth JSON
 * for every QCM / anchor without leaving the app.
 *
 * Idempotent: if a location already points at the resolved path, we
 * just `openLocation` it (no duplicate entry). Else a new read-only
 * local location is added and opened. The path is fetched once per
 * call from the main process — it differs between dev (repo source)
 * and packaged builds (asar-extracted resources dir).
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { locationType } from '@tagspaces/tagspaces-common/misc';
import { CommonLocation } from '-/utils/CommonLocation';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { MODELHUB_IPC } from './types';

/**
 * Stable UUID of the auto-managed « Maestria Tests » location. Used both
 * to detect an existing entry (skip duplicate creation) and to opt out
 * of the global modelhub listing filter: the questions folder holds
 * `.json` files, which the default `modelsAndNotes` mode would hide.
 * Keeping it deterministic means the bypass works even after a restart
 * (the location is persisted in Redux/storage with this exact uuid).
 */
export const MAESTRIA_TESTS_LOCATION_UUID = 'maestria-tests-questions-v1';

/** Same shape as every other modelhub IPC response. */
interface GetQuestionsDirResult {
  ok: boolean;
  path?: string;
  error?: string;
}

type IpcLite = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

function ipc(): IpcLite | undefined {
  return window.electronIO?.ipcRenderer as unknown as IpcLite | undefined;
}

/** Normalise for path equality (trailing-separator + slash direction). */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function useOpenQuestionsLocation(): () => Promise<void> {
  const { t } = useTranslation();
  const { locations, addLocation, openLocation, deleteLocation, editLocation } =
    useCurrentLocationContext();
  const { showNotification } = useNotificationContext();

  return useCallback(async () => {
    const i = ipc();
    if (!i?.invoke) {
      showNotification(t('core:mhQuestionsOpenFailed'), 'warning', true);
      return;
    }
    let dir: string;
    try {
      const res = (await i.invoke(
        MODELHUB_IPC.getQuestionsDir,
      )) as GetQuestionsDirResult;
      if (!res.ok || !res.path) {
        showNotification(
          res.error ?? t('core:mhQuestionsOpenFailed'),
          'warning',
          true,
        );
        return;
      }
      dir = res.path;
    } catch (e) {
      showNotification((e as Error).message, 'error', true);
      return;
    }

    // Reuse the location with the well-known uuid when possible — it
    // survives path drift (dev vs packaged) and keeps the filter bypass
    // in DirectoryContentContextProvider working.
    const canonical = locations.find(
      (l) => l.uuid === MAESTRIA_TESTS_LOCATION_UUID,
    );
    if (canonical) {
      // Migrate legacy state in two cases:
      //   - the resolved path drifted (asar-unpack moved on upgrade,
      //     dev/prod switch on the same install, or a previous buggy
      //     path got persisted);
      //   - the entry was created when this location was read-only
      //     (early version) and the user now expects to edit.
      const pathDrifted =
        !!canonical.path && norm(canonical.path) !== norm(dir);
      const wasReadOnly = canonical.isReadOnly === true;
      if (pathDrifted || wasReadOnly) {
        const patched = new CommonLocation({
          ...canonical,
          path: dir,
          isReadOnly: false,
        });
        editLocation(patched, true);
        return;
      }
      openLocation(canonical);
      return;
    }

    // Legacy: an entry created before this fix had a random uuid, so it
    // wouldn't get the filter bypass and would look empty. Replace it
    // by deleting + recreating with the deterministic uuid.
    const legacy = locations.find((l) => l.path && norm(l.path) === norm(dir));
    if (legacy?.uuid && deleteLocation) {
      deleteLocation(legacy.uuid);
    }

    const newLoc = new CommonLocation({
      uuid: MAESTRIA_TESTS_LOCATION_UUID,
      type: locationType.TYPE_LOCAL,
      name: t('core:mhQuestionsLocationName'),
      path: dir,
      isDefault: false,
      // Editable on purpose: the user explicitly asked to be able to
      // tweak the QCM/anchor JSON. Caveats they must know:
      //   - in `npm run dev` they modify the repo source (git diff
      //     will see it, commit if intended);
      //   - in a packaged build they modify the asar-unpacked copy,
      //     which gets overwritten on the next Maestria upgrade;
      //   - the routing engine loads these JSON at main-process start
      //     (static imports in characterize*.ts), so a restart of
      //     `npm run dev` is required before the modified content
      //     reaches the next characterization.
      isReadOnly: false,
      // disableIndexing left at default (false): the questions folder is
      // tiny, indexing helps the in-app search work over the JSON files
      // the user is browsing.
    });
    addLocation(newLoc, true);
  }, [
    t,
    locations,
    addLocation,
    openLocation,
    deleteLocation,
    editLocation,
    showNotification,
  ]);
}
