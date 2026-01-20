function normalizeSearchQuery(query) {
  if (query == null) return "";
  return String(query).trim().toLowerCase();
}

function matchesGameQuery(game, normalizedQuery) {
  if (!normalizedQuery) return true;
  const name = typeof game?.name === "string" ? game.name.toLowerCase() : "";
  const path = typeof game?.gamePath === "string" ? game.gamePath.toLowerCase() : "";
  return name.includes(normalizedQuery) || path.includes(normalizedQuery);
}

function filterGames(games, query, allowedModuleIds) {
  const list = Array.isArray(games) ? games : [];
  const normalized = normalizeSearchQuery(query);
  const allowed =
    allowedModuleIds && typeof allowedModuleIds[Symbol.iterator] === "function"
      ? new Set(allowedModuleIds)
      : null;
  const enforceTypeFilter = Boolean(allowed);
  if (enforceTypeFilter && allowed.size === 0) return [];
  return list.filter(game => {
    if (enforceTypeFilter) {
      const moduleId = typeof game?.moduleId === "string" ? game.moduleId : "";
      if (!allowed.has(moduleId)) return false;
    }
    if (!normalized) return true;
    return matchesGameQuery(game, normalized);
  });
}

export { normalizeSearchQuery, matchesGameQuery, filterGames };
