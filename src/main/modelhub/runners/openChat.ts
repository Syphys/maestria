/**
 * "Open chat" for an active runner entry.
 *
 * Since the Models Hub fork standardised on `llama-server` (and its
 * ik_llama.cpp / koboldcpp siblings) — every supported runner ships a
 * built-in web UI on its HTTP port. So this routes universally: open
 * the URL in the user's default browser. No more Ollama-specific
 * terminal hop, no clipboard fallback.
 */

import { shell } from 'electron';
import { ActiveEntry } from './launch';

export interface OpenChatResult {
  ok: boolean;
  /** Drives the renderer's notification text. */
  action?: 'browser' | 'noop';
  error?: string;
}

export async function openChatFor(entry: ActiveEntry): Promise<OpenChatResult> {
  if (entry.url) {
    try {
      await shell.openExternal(entry.url);
      return { ok: true, action: 'browser' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  return {
    ok: false,
    action: 'noop',
    error: 'no URL available for this runner',
  };
}
