export type GameSearchEntry = {
  name?: string | null;
  gamePath?: string | null;
  moduleId?: string | null;
};

export function normalizeSearchQuery(query: string | null | undefined): string;
export function matchesGameQuery(
  game: GameSearchEntry,
  normalizedQuery: string
): boolean;
export function filterGames<T extends GameSearchEntry>(
  games: T[],
  query: string | null | undefined,
  allowedModuleIds?: Iterable<string> | null
): T[];
