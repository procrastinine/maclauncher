const { DEFAULT_LIBRARY_SORT, normalizeLibrarySort, sortLibraryGames, reorderLibraryGames } = require("./library-view.mjs");

const DEFAULT_LIBRARY_STATE = {
  version: 2,
  order: [],
  sort: DEFAULT_LIBRARY_SORT,
  favorites: []
};

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeLibraryState(input) {
  const raw = input && typeof input === "object" ? input : {};
  const legacySort = Number.isFinite(raw.version) && raw.version < 2;

  return {
    version: Math.max(DEFAULT_LIBRARY_STATE.version, Number.isFinite(raw.version) ? raw.version : DEFAULT_LIBRARY_STATE.version),
    order: dedupeStrings(raw.order),
    // Version 1 reserved an unused "recent" sort; first use keeps the manual view.
    sort: normalizeLibrarySort(legacySort ? null : raw.sort),
    favorites: dedupeStrings(raw.favorites)
  };
}

function compareLegacyOrder(a, b) {
  const ao = Number.isFinite(a?.order) ? a.order : null;
  const bo = Number.isFinite(b?.order) ? b.order : null;
  if (ao != null && bo != null) return ao - bo;
  if (ao != null) return -1;
  if (bo != null) return 1;
  const ac = Number.isFinite(a?.createdAt) ? a.createdAt : 0;
  const bc = Number.isFinite(b?.createdAt) ? b.createdAt : 0;
  if (ac !== bc) return bc - ac;
  return String(a?.gamePath || "").localeCompare(String(b?.gamePath || ""));
}

function buildOrderedGames(games, library) {
  const normalized = normalizeLibraryState(library);
  const entries = Array.isArray(games) ? games : [];
  const byId = new Map();
  const withoutId = [];
  for (const entry of entries) {
    if (entry?.gameId) byId.set(entry.gameId, entry);
    else withoutId.push(entry);
  }

  const ordered = [];
  for (const id of normalized.order) {
    const entry = byId.get(id);
    if (!entry) continue;
    ordered.push(entry);
    byId.delete(id);
  }

  const remainder = Array.from(byId.values());
  remainder.sort(compareLegacyOrder);
  if (remainder.length > 0) ordered.push(...remainder);
  if (withoutId.length > 0) {
    withoutId.sort(compareLegacyOrder);
    ordered.push(...withoutId);
  }

  const nextOrder = [];
  for (const entry of ordered) {
    if (entry?.gameId) nextOrder.push(entry.gameId);
  }

  return {
    ordered,
    nextOrder,
    library: normalized,
    changed: !arraysEqual(nextOrder, normalized.order)
  };
}

function syncLibraryStateWithGames(library, games) {
  const { ordered, nextOrder, library: normalized, changed } = buildOrderedGames(games, library);
  const valid = new Set(nextOrder);
  const nextFavorites = normalized.favorites.filter(id => valid.has(id));
  const favoritesChanged = !arraysEqual(nextFavorites, normalized.favorites);
  if (changed || favoritesChanged) {
    normalized.order = nextOrder;
    normalized.favorites = nextFavorites;
  }
  return { ordered, library: normalized, changed: changed || favoritesChanged };
}

function bumpLibraryOrder(library, gameId) {
  const normalized = normalizeLibraryState(library);
  if (!gameId) return { library: normalized, changed: false };
  const nextOrder = [gameId, ...normalized.order.filter(id => id !== gameId)];
  const changed = !arraysEqual(nextOrder, normalized.order);
  if (changed) normalized.order = nextOrder;
  return { library: normalized, changed };
}

function setLibraryOrder(library, orderIds) {
  const normalized = normalizeLibraryState(library);
  const nextOrder = dedupeStrings(orderIds);
  const changed = !arraysEqual(nextOrder, normalized.order);
  if (changed) normalized.order = nextOrder;
  return { library: normalized, changed };
}

function removeFromLibrary(library, gameId) {
  const normalized = normalizeLibraryState(library);
  if (!gameId) return { library: normalized, changed: false };
  const nextOrder = normalized.order.filter(id => id !== gameId);
  const nextFavorites = normalized.favorites.filter(id => id !== gameId);
  const changed =
    !arraysEqual(nextOrder, normalized.order) || !arraysEqual(nextFavorites, normalized.favorites);
  if (changed) {
    normalized.order = nextOrder;
    normalized.favorites = nextFavorites;
  }
  return { library: normalized, changed };
}

function applyOrderToEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  list.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") return;
    entry.order = idx;
  });
  return list;
}

function setLibraryFavorite(library, gameId, favorite) {
  const normalized = normalizeLibraryState(library);
  if (!gameId) return normalized;
  normalized.favorites = normalized.favorites.filter(id => id !== gameId);
  if (favorite) normalized.favorites.push(gameId);
  return normalized;
}

function setLibrarySort(library, sort) {
  const normalized = normalizeLibraryState(library);
  normalized.sort = normalizeLibrarySort(sort);
  return normalized;
}

function upsertLibraryEntry(entries, entry) {
  const next = entries.slice();
  const index = next.findIndex(game => game.gameId === entry.gameId);
  if (index < 0) next.unshift(entry);
  else next[index] = entry;
  return applyOrderToEntries(next);
}

function reorderLibraryEntry(games, library, gamePath, toIndex) {
  const { ordered, library: normalized } = buildOrderedGames(games, library);
  if (!ordered.some(game => game.gamePath === gamePath)) throw new Error("Game not found in library");
  const display = reorderLibraryGames(ordered, normalized.favorites, gamePath, toIndex);
  // Preserve the other group's slots in the underlying manual order.
  const favoriteIds = new Set(normalized.favorites);
  const moving = ordered.find(game => game.gamePath === gamePath);
  const favorite = favoriteIds.has(moving.gameId);
  const group = display.filter(game => favoriteIds.has(game.gameId) === favorite);
  let index = 0;
  const next = ordered.map(game => favoriteIds.has(game.gameId) === favorite ? group[index++] : game);
  normalized.order = next.map(game => game.gameId);
  return { ordered: applyOrderToEntries(next), library: normalized };
}

module.exports = {
  DEFAULT_LIBRARY_STATE,
  normalizeLibraryState,
  compareLegacyOrder,
  buildOrderedGames,
  syncLibraryStateWithGames,
  bumpLibraryOrder,
  setLibraryOrder,
  removeFromLibrary,
  applyOrderToEntries,
  setLibraryFavorite,
  setLibrarySort,
  upsertLibraryEntry,
  reorderLibraryEntry,
  sortLibraryGames
};
