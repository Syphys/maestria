/**
 * Slice 4 (+ re-attach) — renderer hook driving the characterization
 * trigger and surfacing a run that's already in flight.
 *
 * The run lives in the main process; progress is broadcast globally as
 * `{ filePath, status }`. This hook subscribes on mount (not only after
 * the user clicks) and seeds itself from a one-shot status snapshot, so
 * navigating away and back to a model re-attaches its progress bar and
 * the radar still refreshes on completion. It also exposes whether some
 * OTHER model is being characterized, so the button can be disabled with
 * a tooltip everywhere (the main process allows one run at a time).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODELHUB_IPC } from './types';
import { invalidateSignature } from './useSignature';
import { canonicalShardName } from './shard';
import type { CharacterizationProgress } from '../../shared/RoutingTypes';

export type CharacterizeRunStatus =
  | { stage: 'preparing'; detail: 'reuse' | 'launching' | 'waiting_ready' }
  | { stage: 'running'; progress: CharacterizationProgress }
  | { stage: 'done' }
  | { stage: 'error'; error: string };

interface ProgressPayload {
  filePath?: string;
  status: CharacterizeRunStatus;
}
interface StatusSnapshot {
  ok: boolean;
  run?: { filePath: string; status: CharacterizeRunStatus } | null;
}
interface StartResult {
  ok: boolean;
  error?: string;
}

type IpcLite = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (...args: unknown[]) => void) => () => void;
};

function ipc(): IpcLite | undefined {
  return window.electronIO?.ipcRenderer as unknown as IpcLite | undefined;
}

function baseOf(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}
function dirOf(p: string): string {
  return p
    .replace(/[\\/][^\\/]*$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}
/** Same logical model (canonical shard, same dir) despite shard suffix. */
function sameModel(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return (
    dirOf(a) === dirOf(b) &&
    canonicalShardName(baseOf(a)).toLowerCase() ===
      canonicalShardName(baseOf(b)).toLowerCase()
  );
}

function isActive(s: CharacterizeRunStatus): boolean {
  return s.stage === 'preparing' || s.stage === 'running';
}

export interface UseCharacterizeState {
  /** A run for THIS model is in flight. */
  running: boolean;
  /** A run for a DIFFERENT model is in flight (button should be disabled). */
  otherRunning: boolean;
  status?: CharacterizeRunStatus;
  start: (skipWrite?: boolean) => Promise<boolean>;
}

export function useCharacterize(
  filePath: string,
  onDone?: (filePath: string) => void,
): UseCharacterizeState {
  const [running, setRunning] = useState(false);
  const [otherRunning, setOtherRunning] = useState(false);
  const [status, setStatus] = useState<CharacterizeRunStatus | undefined>();
  const aliveRef = useRef(true);

  // Mount: subscribe to the global progress stream + seed from a snapshot
  // so a run already in flight (possibly started before this mount) shows.
  useEffect(() => {
    aliveRef.current = true;
    const i = ipc();
    if (!i) return undefined;

    const apply = (fp: string | undefined, s: CharacterizeRunStatus) => {
      if (!aliveRef.current) return;
      if (sameModel(fp, filePath)) {
        setStatus(s);
        if (s.stage === 'done') {
          setRunning(false);
          invalidateSignature(filePath);
          onDone?.(filePath);
        } else if (s.stage === 'error') {
          setRunning(false);
        } else {
          setRunning(true);
        }
        setOtherRunning(false);
      } else {
        // An event for another model → only the busy/idle bit matters here.
        setOtherRunning(isActive(s));
      }
    };

    const off = i.on(MODELHUB_IPC.characterizeProgress, (payload) => {
      const p = payload as ProgressPayload;
      apply(p?.filePath, p?.status);
    });

    i.invoke(MODELHUB_IPC.characterizeStatus)
      .then((r) => {
        if (!aliveRef.current) return;
        const run = (r as StatusSnapshot)?.run;
        if (!run) {
          setOtherRunning(false);
          return;
        }
        apply(run.filePath, run.status);
      })
      .catch(() => undefined);

    return () => {
      aliveRef.current = false;
      off();
    };
  }, [filePath, onDone]);

  const start = useCallback(
    async (skipWrite?: boolean): Promise<boolean> => {
      const i = ipc();
      if (!i?.invoke) {
        setStatus({ stage: 'error', error: 'IPC not available (web build?)' });
        return false;
      }
      if (running) return false;

      setRunning(true);
      setStatus({ stage: 'preparing', detail: 'launching' });
      try {
        const res = (await i.invoke(
          MODELHUB_IPC.characterizeStart,
          filePath,
          skipWrite,
        )) as StartResult;
        if (res.ok) {
          // The terminal `done` event also handles this; doing it here too
          // is an idempotent fallback if the event was missed.
          invalidateSignature(filePath);
          onDone?.(filePath);
          return true;
        }
        if (aliveRef.current) {
          setStatus({ stage: 'error', error: res.error || 'failed' });
          setRunning(false);
        }
        return false;
      } catch (e) {
        if (aliveRef.current) {
          setStatus({ stage: 'error', error: (e as Error).message });
          setRunning(false);
        }
        return false;
      }
    },
    [running, filePath, onDone],
  );

  return { running, otherRunning, status, start };
}
