const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Profiles = require("../src/modules/crossover/backcompat/profiles");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
const { retainedGameDataRemoval, assertRetainedGameDataRemoval } = require("../src/core/backcompat/game-removal");

test("retained divergent and blocked Windows profiles persist once and require explicit removal confirmation", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-retained-backcompat-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), gameRoot = path.join(userDataDir, "games", "one");
  const bottles = path.join(gameRoot, "runtimes", "crossover", "bottles");
  const chosen = path.join(bottles, "local-1111111111111111-win10_64");
  const divergent = path.join(bottles, "local-2222222222222222-win10_64");
  const adopted = path.join(bottles, "win10_64");
  const blocked = path.join(gameRoot, "runtimes", "sikarugir", "prefixes", "11111111111111111111-win10");
  for (const [directory, bytes] of [[chosen, "chosen saves"], [divergent, "divergent saves"], [blocked, "blocked saves"]]) {
    fs.mkdirSync(directory, { recursive: true });fs.writeFileSync(path.join(directory, "user.reg"), bytes);
  }
  const entry = { gameId: "one", moduleId: "unity", gamePath: path.join(root, "original"),
    defaultSaveDir: path.join(chosen, "drive_c", "users"),
    runtimeData: { crossover: { bottlePath: chosen }, sikarugir: { prefixPath: blocked } } };
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from === blocked) throw Error("controlled blocked adoption");
    return rename(from, to);
  });
  let persisted, settings;
  const result = await runDataMigrations({ settings: {}, games: [entry], userDataDir,
    registry: { getModule: () => ({}), listRuntimeProviderModules: () => [Profiles] },
    saveEntry: value => { persisted = structuredClone(value); },
    saveSettings: value => { settings = structuredClone(value); } });
  assert.equal(result.complete, true, "the one-time attempt completes despite retained diagnostics");
  assert.equal(persisted.runtimeData.crossover.bottlePath, adopted);
  assert.equal(persisted.defaultSaveDir, path.join(adopted, "drive_c", "users"));
  assert.equal(persisted.runtimeData.sikarugir.prefixPath, blocked);
  for (const [directory, bytes] of [[adopted, "chosen saves"], [divergent, "divergent saves"], [blocked, "blocked saves"]])
    assert.equal(fs.readFileSync(path.join(directory, "user.reg"), "utf8"), bytes);
  const removal = retainedGameDataRemoval(entry, settings, userDataDir);
  assert.ok(removal);
  assert.deepEqual([...new Set(removal.retained.map(row => row.mirrorRoot))].sort(), [divergent, blocked].sort());
  assert.ok(removal.retained.every(row => row.reason));
  assert.throws(() => assertRetainedGameDataRemoval(entry, settings, userDataDir), { code: "GAME_DATA_RETAINED" });
  assert.doesNotThrow(() => assertRetainedGameDataRemoval(entry, settings, userDataDir, removal));
  t.mock.method(fs, "opendirSync", () => assert.fail("completed migration must not inspect old environments again"));
  const again = await runDataMigrations({ settings, games: [entry], userDataDir,
    registry: { getModule: () => assert.fail("completed migration must not load module hooks") },
    saveSettings: () => assert.fail("completed migration must not rewrite settings"),
    saveEntry: () => assert.fail("completed migration must not rewrite game records") });
  assert.equal(again.complete, true);
  assert.deepEqual(retainedGameDataRemoval(entry, again.settings, userDataDir), removal);
});
