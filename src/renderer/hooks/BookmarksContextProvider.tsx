/**
 * Open-source bookmarks provider — reimplemented to replace the Pro
 * `Pro.contextProviders.BookmarksContextProvider` so the bookmark
 * toggle in EntryContainerNav and the bookmarks section in the Quick
 * Access panel work without a Pro license.
 *
 * Storage: localStorage under `tagspaces.bookmarks`. Plain JSON array of
 * `TS.BookmarkItem` keyed implicitly by `path`. We chose localStorage
 * over the file sidecar because bookmarks are a UI affordance, not file
 * metadata — they shouldn't follow the file across machines or sync
 * with the file via the .ts/ sidecar.
 *
 * Behaviour mirrors the Pro contract published in
 * `tagspaces.namespace.d.ts` (`TS.BookmarksContextData`) — `bookmarks`
 * is a live snapshot, mutator methods (`setBookmark`, `delBookmark`,
 * `delAllBookmarks`) update both the in-memory list and persist;
 * `haveBookmark(path)` is a sync read.
 */

import { TS } from '-/tagspaces.namespace';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

const STORAGE_KEY = 'tagspaces.bookmarks';

/** Stable string referenced by RenderHistory / StoredSearches to tell
 * the bookmark code path apart from regular history keys. Used to be
 * `Pro.keys.bookmarksKey`. */
export const BOOKMARKS_KEY = 'bookmarks';

function readFromStorage(): TS.BookmarkItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b: any) =>
        b &&
        typeof b.path === 'string' &&
        typeof b.url === 'string' &&
        typeof b.creationTimeStamp === 'number',
    );
  } catch {
    return [];
  }
}

function writeToStorage(items: TS.BookmarkItem[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota exceeded or storage disabled — surface only via missing persistence */
  }
}

export const BookmarksContext = createContext<TS.BookmarksContextData>({
  bookmarks: [],
  setBookmark: () => {},
  haveBookmark: () => false,
  delAllBookmarks: () => {},
  delBookmark: () => {},
});

export const BookmarksContextProvider: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const [bookmarks, setBookmarks] = useState<TS.BookmarkItem[]>(() =>
    readFromStorage(),
  );

  const setBookmark = useCallback((filePath: string, url: string) => {
    setBookmarks((prev) => {
      // Existing bookmark on this path → refresh its url + timestamp
      // (path is the natural primary key; a re-bookmark on the same
      // file shouldn't pile up duplicates).
      const idx = prev.findIndex((b) => b.path === filePath);
      const item: TS.BookmarkItem = {
        path: filePath,
        url,
        creationTimeStamp: Date.now(),
      };
      const next =
        idx >= 0 ? prev.map((b, i) => (i === idx ? item : b)) : [item, ...prev];
      writeToStorage(next);
      return next;
    });
  }, []);

  const delBookmark = useCallback((filePath: string) => {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.path !== filePath);
      writeToStorage(next);
      return next;
    });
  }, []);

  const delAllBookmarks = useCallback(() => {
    setBookmarks([]);
    writeToStorage([]);
  }, []);

  const haveBookmark = useCallback(
    (filePath: string) => bookmarks.some((b) => b.path === filePath),
    [bookmarks],
  );

  const value = useMemo<TS.BookmarksContextData>(
    () => ({
      bookmarks,
      setBookmark,
      haveBookmark,
      delAllBookmarks,
      delBookmark,
    }),
    [bookmarks, setBookmark, haveBookmark, delAllBookmarks, delBookmark],
  );

  return (
    <BookmarksContext.Provider value={value}>
      {children}
    </BookmarksContext.Provider>
  );
};

export const useBookmarksContext = (): TS.BookmarksContextData =>
  useContext(BookmarksContext);
