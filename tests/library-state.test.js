const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeLibraryState,
  buildOrderedGames,
  syncLibraryStateWithGames,
  bumpLibraryOrder,
  applyOrderToEntries
} = require("../src/main/library-state");

const games = [
  { gameId: "a", order: 2, createdAt: 100, gamePath: "/Games/A" },
  { gameId: "b", order: 0, createdAt: 200, gamePath: "/Games/B" },
  { gameId: "c", order: 1, createdAt: 300, gamePath: "/Games/C" }
];

test("normalizeLibraryState defaults and dedupes", () => {
  const library = normalizeLibraryState({
    order: [" a ", "a", 5, "", "b"],
    favorites: ["b", "b", "  "],
    sort: { mode: "custom", direction: "asc" }
  });
  assert.deepEqual(library.order, ["a", "b"]);
  assert.deepEqual(library.favorites, ["b"]);
  assert.equal(library.sort.mode, "custom");
  assert.equal(library.sort.direction, "asc");
});

test("unused version 1 sort metadata migrates to Default without changing manual order or favorites", () => {
  const legacy = normalizeLibraryState({ version: 1, order: ['b', 'a'], favorites: ['a'], sort: { mode: 'recent', direction: 'desc' } });
  assert.equal(legacy.version, 2);
  assert.deepEqual(legacy.order, ['b', 'a']);
  assert.deepEqual(legacy.favorites, ['a']);
  assert.deepEqual(legacy.sort, { mode: 'custom', direction: 'asc' });
  assert.deepEqual(normalizeLibraryState({ ...legacy, sort: { mode: 'recent', direction: 'desc' } }).sort, { mode: 'recent', direction: 'desc' });
});

test("library view sorts without mutating manual order and groups favorites only in Default", () => {
  const { sortLibraryGames } = require("../src/core/library-view.mjs");
  const entries = [
    { gameId: "a", name: "Game 10", createdAt: 100, lastPlayedAt: 300, moduleLabel: "Zebra" },
    { gameId: "b", name: "game 2", createdAt: 300, lastPlayedAt: null, moduleLabel: "Alpha" },
    { gameId: "c", name: "Alpha", createdAt: 200, lastPlayedAt: 100, moduleLabel: "Zebra" }
  ];
  const ids = (mode, direction) => sortLibraryGames(entries, { mode, direction }, ["b"]).map(game => game.gameId);
  assert.deepEqual(ids("custom"), ["b", "a", "c"]);
  assert.deepEqual(ids("recent", "desc"), ["a", "c", "b"]);
  assert.deepEqual(ids("recent", "asc"), ["c", "a", "b"]);
  assert.deepEqual(ids("added", "desc"), ["b", "c", "a"]);
  assert.deepEqual(ids("alphabetical", "asc"), ["c", "b", "a"]);
  assert.deepEqual(ids("alphabetical", "desc"), ["a", "b", "c"]);
  assert.deepEqual(ids("type", "asc"), ["b", "c", "a"]);
  assert.deepEqual(entries.map(game => game.gameId), ["a", "b", "c"]);
});

test("library view resolves tied dates by manual order and unknown dates last", () => {
  const { sortLibraryGames } = require("../src/core/library-view.mjs");
  const entries = [{ gameId: "a", createdAt: null }, { gameId: "b", createdAt: 10 }, { gameId: "c", createdAt: 10 }, { gameId: "d", createdAt: NaN }];
  for (const direction of ["asc", "desc"]) {
    assert.deepEqual(sortLibraryGames(entries, { mode: "added", direction }).map(game => game.gameId), ["b", "c", "a", "d"]);
  }
});

test("library state saves favorites and sort independently of manual order", () => {
  const { setLibraryFavorite, setLibrarySort, removeFromLibrary } = require("../src/core/library-state");
  const initial = normalizeLibraryState({ order: ["a", "b", "c"] });
  const favorite = setLibraryFavorite(initial, "b", true);
  const sorted = setLibrarySort(favorite, { mode: "alphabetical", direction: "desc" });
  const reloaded = normalizeLibraryState(JSON.parse(JSON.stringify(sorted)));
  assert.deepEqual(reloaded.favorites, ["b"]);
  assert.deepEqual(reloaded.order, initial.order);
  assert.deepEqual(reloaded.sort, { mode: "alphabetical", direction: "desc" });
  assert.deepEqual(initial.favorites, []);
  assert.deepEqual(setLibraryFavorite(reloaded, "b", false).favorites, []);
  assert.deepEqual(removeFromLibrary(reloaded, "b").library.favorites, []);
  assert.deepEqual(normalizeLibraryState({ sort: { mode: "invalid" } }).sort, { mode: "custom", direction: "asc" });
});

test("updating or playing existing games preserves dragged order, while new games start at the top", () => {
  const { upsertLibraryEntry } = require("../src/core/library-state");
  const entries = games.map(game => ({ ...game }));
  const played = upsertLibraryEntry(entries, { ...entries[1], lastPlayedAt: Date.now() });
  assert.deepEqual(played.map(game => game.gameId), ["a", "b", "c"]);
  const added = upsertLibraryEntry(played, { gameId: "new", gamePath: "/Games/New" });
  assert.deepEqual(added.map(game => game.gameId), ["new", "a", "b", "c"]);
});

test("Default drag indices respect favorite groups and preserve the other group's manual slots", () => {
  const { reorderLibraryEntry, sortLibraryGames } = require("../src/core/library-state");
  const entries = [...games.map(game => ({ ...game })), { gameId: "d", gamePath: "/Games/D" }];
  const library = { order: ["a", "b", "c", "d"], favorites: ["b", "d"] };
  const moved = reorderLibraryEntry(entries, library, "/Games/D", 0);
  assert.deepEqual(moved.library.order, ["a", "d", "c", "b"]);
  assert.deepEqual(sortLibraryGames(moved.ordered, { mode: "custom" }, moved.library.favorites).map(game => game.gameId), ["d", "b", "a", "c"]);
  const clamped = reorderLibraryEntry(moved.ordered, moved.library, "/Games/C", 0);
  assert.deepEqual(clamped.library.order, ["c", "d", "a", "b"]);
  assert.deepEqual(library.order, ["a", "b", "c", "d"]);
});

test("syncLibraryStateWithGames seeds and trims order/favorites", () => {
  const { library } = syncLibraryStateWithGames(
    { order: ["missing", "b"], favorites: ["b", "missing"] },
    games
  );
  assert.deepEqual(library.order, ["b", "c", "a"]);
  assert.deepEqual(library.favorites, ["b"]);
});

test("buildOrderedGames respects library order and appends remainder", () => {
  const { ordered } = buildOrderedGames(games, { order: ["c", "a"] });
  assert.deepEqual(
    ordered.map(entry => entry.gameId),
    ["c", "a", "b"]
  );
});

test("bumpLibraryOrder moves entries to the front", () => {
  const { library } = bumpLibraryOrder({ order: ["b", "c", "a"] }, "a");
  assert.deepEqual(library.order, ["a", "b", "c"]);
});

test("applyOrderToEntries writes sequential order indices", () => {
  const entries = [{ gameId: "a" }, { gameId: "b" }];
  applyOrderToEntries(entries);
  assert.equal(entries[0].order, 0);
  assert.equal(entries[1].order, 1);
});
