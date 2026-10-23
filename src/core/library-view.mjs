// UI-safe library ordering shared by the Electron shell and renderer.
export const DEFAULT_LIBRARY_SORT = { mode: "custom", direction: "asc" };
export const LIBRARY_SORT_MODES = ["custom", "recent", "added", "alphabetical", "type"];

export function normalizeLibrarySort(sort) {
  const mode = LIBRARY_SORT_MODES.includes(sort?.mode) ? sort.mode : DEFAULT_LIBRARY_SORT.mode;
  return {
    mode,
    direction: mode === "custom" ? "asc" : sort?.direction === "asc" || sort?.direction === "desc"
      ? sort.direction : mode === "recent" || mode === "added" ? "desc" : "asc"
  };
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortLibraryGames(games, sort, favorites = []) {
  const list = Array.isArray(games) ? games.slice() : [];
  const { mode, direction } = normalizeLibrarySort(sort);
  const favoriteIds = new Set(favorites);
  const sign = direction === "asc" ? 1 : -1;
  return list.sort((a, b) => {
    if (mode === "custom") return Number(favoriteIds.has(b.gameId)) - Number(favoriteIds.has(a.gameId));
    if (mode === "recent" || mode === "added") {
      const key = mode === "recent" ? "lastPlayedAt" : "createdAt";
      const av = Number.isFinite(a[key]) && a[key] > 0 ? a[key] : null;
      const bv = Number.isFinite(b[key]) && b[key] > 0 ? b[key] : null;
      // Unknown dates and never-played games stay at the end in either direction.
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
      return (av - bv) * sign;
    }
    if (mode === "type") {
      const byType = names.compare(a.moduleLabel || a.moduleId || "", b.moduleLabel || b.moduleId || "");
      if (byType) return byType * sign;
    }
    return names.compare(a.name || "", b.name || "") * sign;
  });
}

// Drop indices refer to the displayed Default order. Keep drags in their group.
export function reorderLibraryGames(games, favorites, gamePath, toIndex) {
  const display = sortLibraryGames(games, DEFAULT_LIBRARY_SORT, favorites);
  const from = display.findIndex(game => game.gamePath === gamePath);
  if (from < 0) return display;
  const ids = new Set(favorites);
  const count = display.filter(game => ids.has(game.gameId)).length;
  const favorite = ids.has(display[from].gameId);
  const min = favorite ? 0 : count;
  const max = favorite ? count - 1 : display.length - 1;
  const target = Math.max(min, Math.min(max, Number.isFinite(toIndex) ? toIndex : from));
  display.splice(target, 0, display.splice(from, 1)[0]);
  return display;
}
