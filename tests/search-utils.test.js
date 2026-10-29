const assert = require("node:assert/strict");
const test = require("node:test");

async function loadUtils() {
  return import("../src/renderer/src/ui/search-utils.mjs");
}

const games = [
  {
    name: "Example A",
    gamePath: "/Games/MZ_Example A",
    moduleId: "mz"
  },
  {
    name: "Example B",
    gamePath: "/Games/MV_ExampleB",
    moduleId: "mv"
  },
  {
    name: "ExampleC",
    gamePath: "/Games/Renpy/ExampleC",
    moduleId: "renpy"
  }
];

test("filterGames matches name and path", async () => {
  const { filterGames } = await loadUtils();
  assert.equal(filterGames(games, "example a", null).length, 1);
  assert.equal(filterGames(games, "  example a  ", null).length, 1);
  assert.equal(filterGames(games, "RENpy", null).length, 1);
});

test("filterGames respects type filters", async () => {
  const { filterGames } = await loadUtils();
  assert.equal(filterGames(games, "", ["mz"]).length, 1);
  assert.equal(filterGames(games, "example b", ["mz", "mv"]).length, 1);
  assert.equal(filterGames(games, "", new Set(["renpy"])).length, 1);
});

test("filterGames returns empty when no types are selected", async () => {
  const { filterGames } = await loadUtils();
  assert.equal(filterGames(games, "", []).length, 0);
});

test("game type options use detection declarations and retain labels and sort order", async () => {
  const { gameTypeOptionsForModules } = await loadUtils();
  const modules = [
    { id: "z-game", label: "Zed game", shortLabel: "Zed", detection: { inputKinds: ["file"] } },
    { id: "future-provider", label: "Future runtime", gameType: "console", runtime: { supported: ["future"] } },
    { id: "a-game", label: "Alpha game", detection: { inputKinds: ["directory"] } },
    { id: "bare-game", detection: { inputKinds: ["app"] } }
  ];
  assert.deepEqual(gameTypeOptionsForModules(modules), [
    { id: "a-game", label: "Alpha game", title: "Alpha game" },
    { id: "bare-game", label: "bare-game", title: "bare-game" },
    { id: "z-game", label: "Zed", title: "Zed game" }
  ]);
  assert.deepEqual(modules.map(mod => mod.id), ["z-game", "future-provider", "a-game", "bare-game"]);
});

test("registered game types retain Mac and PS5 without duplicating their providers", async () => {
  const Modules = require("../src/modules/registry");
  const { gameTypeOptionsForModules, filterGames } = await loadUtils();
  const ids = gameTypeOptionsForModules(Modules.listModules()).map(option => option.id);
  for (const id of ["generic-app", "anyps5", "nxnative", "crossover", "mv", "android"]) assert.ok(ids.includes(id), id);
  for (const id of ["prosper", "mac32"]) assert.equal(ids.includes(id), false, id);
  for (const id of ids) {
    const mod = Modules.getModule(id);
    assert.ok(typeof mod.detectGame === "function" || typeof mod.detectGameAsync === "function", id);
  }
  const entries = [
    { moduleId: "generic-app", runtimeId: "mac32" },
    { moduleId: "anyps5", runtimeId: "prosper" },
    { moduleId: "nxnative", runtimeId: "mac32" }
  ];
  assert.deepEqual(filterGames(entries, "", ids), entries, "Runtime choices do not change game ownership");
  assert.deepEqual(filterGames(entries, "", ["generic-app"]), [entries[0]]);
  assert.deepEqual(filterGames(entries, "", ["anyps5"]), [entries[1]]);
});
