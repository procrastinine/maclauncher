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
