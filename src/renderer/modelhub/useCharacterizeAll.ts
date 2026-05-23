/**
 * Slice 5 — renderer hook for the bulk "Characterize all models" encart.
 *
 * The bulk run lives in the main process; per-step progress is broadcast
 * on `characterizeAllProgress`. The encart is always mounted (it sits
 * above the Console), so a plain mount-time subscription is enough — no
 * re-attach dance like the per-model hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODELHUB_IPC } from './types';
import type { CharacterizeRunStatus } from './useCharacterize';

export interface CharacterizeAllProgress {
  /**
   * Single-pass protocol (2026-05-23 rev.) — `running` covers both the
   * per-model test phase and its optional projection step. `enumerating`
   * is the file-listing pre-step; `done` / `cancelled` are terminal.
   */
  phase: 'enumerating' | 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  ok: number;
  errors: number;
  skipped: number;
  /** Projections successfully written this run. */
  projected: number;
  currentIndex: number;
  currentFile?: string;
  currentName?: string;
  modelStatus?: CharacterizeRunStatus;
  errorSamples: { file: string; error: string }[];
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

export interface UseCharacterizeAllState {
  running: boolean;
  progress?: CharacterizeAllProgress;
  /**
   * Start a bulk run.
   *  - `force` (slice 6b) ⇒ `skipExisting = false`, re-characterize every
   *    model (complete + failed). Default false keeps resumable behaviour.
   *  - `freegen` (« Parler libre ») ⇒ make each model talk for ~600-800
   *    words. Default true; false skips both the monologue AND projection.
   *  - `skipProjection` (« Sans calcul vectoriel ») ⇒ generate and save
   *    the monologue but skip the embedder projection step. Useful when
   *    the user wants the texts now and will project later, or when no
   *    embedder is configured (the main process applies the same
   *    fallback silently if the embedder fails to resolve).
   */
  start: (
    rootDir: string,
    skipWrite?: boolean,
    force?: boolean,
    freegen?: boolean,
    skipProjection?: boolean,
  ) => Promise<void>;
  cancel: () => void;
}

export function useCharacterizeAll(): UseCharacterizeAllState {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CharacterizeAllProgress>();
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const i = ipc();
    if (!i) return undefined;
    const off = i.on(MODELHUB_IPC.characterizeAllProgress, (payload) => {
      if (!aliveRef.current) return;
      const p = payload as CharacterizeAllProgress;
      setProgress(p);
      setRunning(p.phase === 'enumerating' || p.phase === 'running');
    });
    return () => {
      aliveRef.current = false;
      off();
    };
  }, []);

  const start = useCallback(
    async (
      rootDir: string,
      skipWrite?: boolean,
      force?: boolean,
      freegen?: boolean,
      skipProjection?: boolean,
    ): Promise<void> => {
      const i = ipc();
      if (!i?.invoke || running) return;
      setRunning(true);
      try {
        const res = (await i.invoke(
          MODELHUB_IPC.characterizeAllStart,
          rootDir,
          skipWrite,
          // Slice 6b: `force` ⇒ skipExisting=false (re-do complete + failed);
          // default keeps the resumable Slice-5 behaviour.
          !force,
          // « Parler libre » — make each model talk. Default true.
          freegen,
          // « Sans calcul vectoriel » — defer the embedder step.
          skipProjection,
        )) as StartResult;
        if (!res.ok && aliveRef.current) {
          setProgress((prev) =>
            prev
              ? { ...prev, phase: 'cancelled' }
              : {
                  phase: 'cancelled',
                  total: 0,
                  done: 0,
                  ok: 0,
                  errors: 0,
                  skipped: 0,
                  projected: 0,
                  currentIndex: 0,
                  errorSamples: [],
                },
          );
        }
      } finally {
        if (aliveRef.current) setRunning(false);
      }
    },
    [running],
  );

  const cancel = useCallback(() => {
    const i = ipc();
    void i?.invoke(MODELHUB_IPC.characterizeAllCancel);
  }, []);

  return { running, progress, start, cancel };
}
