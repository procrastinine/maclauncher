export type LibrarySortMode = "custom" | "recent" | "added" | "alphabetical" | "type";
export type LibrarySort = { mode: LibrarySortMode; direction: "asc" | "desc" };
export type LibraryViewGame = {
  gameId?: string; gamePath: string; name?: string; moduleLabel?: string; moduleId?: string;
  lastPlayedAt?: number | null; createdAt?: number | null;
};
export const DEFAULT_LIBRARY_SORT: LibrarySort;
export const LIBRARY_SORT_MODES: LibrarySortMode[];
export function normalizeLibrarySort(sort?: Partial<LibrarySort> | null): LibrarySort;
export function sortLibraryGames<T extends LibraryViewGame>(games: T[], sort?: Partial<LibrarySort> | null, favorites?: string[]): T[];
export function reorderLibraryGames<T extends LibraryViewGame>(games: T[], favorites: string[], gamePath: string, toIndex: number): T[];
