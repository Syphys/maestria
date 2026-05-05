/**
 * Tiny pub/sub on `window` so non-React code (e.g. the file-context-menu
 * "Run model" handler) can ask the always-mounted RunningModelsPanel to
 * open the in-app ChatDialog without dragging in a global state library.
 *
 * Producer: `dispatchModelhubChatOpen({ pid })` after a successful launch.
 * Consumer: `RunningModelsPanel` listens for `modelhub:open-chat` and
 * resolves the pid to an entry from its polling cache.
 */

export const MODELHUB_CHAT_OPEN_EVENT = 'modelhub:open-chat';

export interface ModelhubChatOpenDetail {
  pid: number;
}

export function dispatchModelhubChatOpen(detail: ModelhubChatOpenDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ModelhubChatOpenDetail>(MODELHUB_CHAT_OPEN_EVENT, {
      detail,
    }),
  );
}
