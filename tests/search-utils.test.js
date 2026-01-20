const assert = require("node:assert/strict");
const test = require("node:test");

async function loadUtils() {
  return import("../src/renderer/src/ui/search-utils.mjs");
}

const games = [
  {
    name: "Haven",
    gamePath: "/Games/MZ_Haven",
    moduleId: "mz"
  },
  {
    name: "Dead Plate",
    gamePath: "/Games/MV_Dead_Plate",
    moduleId: "mv"
  },
  {
    name: "Memory",
    gamePath: "/Games/Renpy/Memory",
    moduleId: "renpy"
  }
];

test("filterGames matches name and path", async () => {
  const { filterGames } = await loadUtils();
  assert.equal(filterGames(games, "haven", null).length, 1);
  assert.equal(filterGames(games, "  haven  ", null).length, 1);
  assert.equal(filterGames(games, "RENpy", null).length, 1);
});

test("filterGames respects type filters", async () => {
  const { filterGames } = await loadUtils();
  assert.equal(filterGames(games, "", ["mz"]).length, 1);
  assert.equal(filterGames(games, "plate", ["mz", "mv"]).length, 1);
  assert.equal(filterGames(games, "", new Set(["renpy"])).length, 1);
});

test("filterGames returns empty when no types are selected", async () => {
  const { filterGames } = await loadUtils();
  assert.equal(filterGames(games, "", []).length, 0);
});
