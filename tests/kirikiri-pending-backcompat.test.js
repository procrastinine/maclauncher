const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Kiri = require("../src/modules/kirikiri/main");
const Backcompat = require("../src/modules/kirikiri/backcompat");
const Native = require("../src/modules/shared/runtime/local-native");
const GameStore = require("../src/core/game-store");
const { parse } = require("../src/modules/shared/runtime/launch-arguments");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
const KEY = "original-game-mirrors-v1";

function fixture(t, expression = "chooseSaveLocation()") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kiri-pending $(literal)-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), home = path.join(root, "home"), game = path.join(root, "original");
  fs.mkdirSync(home); fs.mkdirSync(game);
  t.mock.method(os, "homedir", () => home);
  fs.writeFileSync(path.join(game, "startup.tjs"), 'var kagVersion = "3.24";');
  fs.writeFileSync(path.join(game, "Config.tjs"), `;saveDataLocation = ${expression};\n;dataName = "authored";`);
  const entry = { schemaVersion: 2, gameId: "released-kiri", moduleId: "kirikiri", runtimeId: "krkrsdl2",
    gamePath: game, importPath: game, contentRootDir: game, moduleData: { sourceKind: "project", kagVersion: "3.24" },
    launchArguments: '-windowed -title="$(literal) title"', notes: "authored notes" };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "kirikiri", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true });
  fs.writeFileSync(path.join(mirrorRoot, "authoredsc.ksd"), "released save bytes");
  // Released v0.5.1 main.js:97–100,143–155 persisted this forced default.
  entry.defaultSaveDir = mirrorRoot;
  entry.saveLocations = [{ directory: mirrorRoot, label: "KiriKiri saves" }];
  return { root, home, userDataDir, entry, mirrorRoot };
}

async function migrate(f, settings = {}, checkBeforeSave) {
  GameStore.writeGameRecord(f.userDataDir, f.entry);
  let savedSettings;
  const settingsFile = path.join(f.userDataDir, "settings.json");
  const result = await runDataMigrations({ userDataDir: f.userDataDir, games: [f.entry], settings,
    registry: { getModule: () => Backcompat },
    saveSettings(next) { savedSettings = next; fs.writeFileSync(settingsFile, JSON.stringify(next)); },
    saveEntry(next, baseline) {
      checkBeforeSave?.(next, baseline);
      GameStore.writeGameRecord(f.userDataDir, next);
    } });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)), savedSettings);
  return { result, settings: savedSettings, persisted: GameStore.readGameRecord(f.userDataDir, f.entry.gameId) };
}

async function assertPlayRoute(t, f, entry, expected, runtimeSettings = {}) {
  const manager = Kiri.runtimeManagers.find(row => row.id === "krkrsdl2");
  t.mock.method(manager, "resolveSelection", () => ({ ready: true, version: "fixture", install: {
    runtimePath: path.join(f.root, "never-executed"), version: "fixture" } }));
  t.mock.method(manager.core, "listCatalog", () => []);
  t.mock.method(Native, "launchLocalRuntime", options => options);
  const launch = await Kiri.launchRuntime("krkrsdl2", entry, { userDataDir: f.userDataDir,
    settings: {}, runtimeSettings, gameArguments: parse(entry.launchArguments) });
  const paths = launch.args.filter(arg => /^-datapath=/i.test(arg));
  assert.deepEqual(paths, expected ? [`-datapath=${expected}${path.sep}`] : []);
  assert.equal(launch.cwd, f.entry.contentRootDir);
  assert.ok(launch.args.includes("-title=$(literal) title"), "authored arguments remain literal");
  assert.equal(launch.args.at(-1), f.entry.contentRootDir);
}

test("ambiguous released saves persist a visible pending route once and actual Play uses it literally", async t => {
  const f = fixture(t);
  assert.equal(Kiri.resolveSaveIdentity(f.entry), null, "the actual current source has no provable normal save location");
  assert.equal(Backcompat.migrateLegacyGameData({ ...f.entry, saveDirOverride: path.join(f.home, "unrecovered-collision") },
    { userDataDir: f.userDataDir, games: [f.entry], ownerFailedDescriptors: [{ mirrorRoot: f.mirrorRoot }] }).entryPatch.saveDirOverride,
    f.mirrorRoot, "a migration-generated collision destination cannot replace the still-pending released route");
  const { result, settings, persisted } = await migrate(f, {}, (next, baseline) => {
    assert.equal(f.entry.saveDirOverride, undefined, "runner context still exposes the original record until save");
    assert.equal(baseline.defaultSaveDir, f.mirrorRoot);
    assert.equal(next.saveDirOverride, f.mirrorRoot);
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.pendingIds, [f.entry.gameId]);
  assert.match(result.retained[0].failures[0].reason, /dynamic or unavailable/);
  assert.equal(settings.dataMigrations[KEY].complete, true);
  assert.equal(persisted.saveDirOverride, f.mirrorRoot);
  assert.equal(persisted.defaultSaveDir, f.mirrorRoot);
  assert.equal(persisted.launchArguments, f.entry.launchArguments);
  assert.equal(persisted.notes, "authored notes");
  assert.equal(fs.readFileSync(path.join(f.mirrorRoot, "authoredsc.ksd"), "utf8"), "released save bytes");
  await assertPlayRoute(t, f, persisted, f.mirrorRoot);
  t.mock.method(Backcompat, "legacyGameMirrors", () => assert.fail("no repeated recovery"));
  t.mock.method(Backcompat, "migrateLegacyGameData", () => assert.fail("no repeated pending-route scan"));
  const second = await runDataMigrations({ settings, games: [persisted], userDataDir: f.userDataDir,
    registry: { getModule: () => assert.fail("completed migration does not load modules") },
    saveSettings: () => assert.fail("no second completion write"), saveEntry: () => assert.fail("no second record write") });
  assert.deepEqual(second.pendingIds, result.pendingIds);
});

test("failed descriptor recovery keeps released bytes readable while preserving its diagnostic", async t => {
  const f = fixture(t, "System.dataPath");
  const standardParent = path.join(f.home, "Library", "Application Support"), outside = path.join(f.root, "other");
  fs.mkdirSync(standardParent, { recursive: true }); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(standardParent, "krkrsdl2"));
  const { result, persisted } = await migrate(f);
  assert.deepEqual(result.pendingIds, [f.entry.gameId]);
  assert.ok(result.retained[0].failures.some(row => row.mirrorRoot === f.mirrorRoot));
  assert.equal(persisted.saveDirOverride, f.mirrorRoot);
  assert.equal(persisted.defaultSaveDir, f.mirrorRoot);
  assert.equal(fs.readFileSync(path.join(f.mirrorRoot, "authoredsc.ksd"), "utf8"), "released save bytes");
  assert.deepEqual(fs.readdirSync(outside), [], "failed recovery does not write through the destination link");
  await assertPlayRoute(t, f, persisted, f.mirrorRoot);
});

test("successful recovery, missing released saves and fresh records receive no pending override", async t => {
  for (const mode of ["recovered", "missing", "fresh"]) {
    const f = fixture(t, mode === "recovered" ? "System.dataPath" : "chooseSaveLocation()");
    if (mode === "missing") fs.rmSync(f.mirrorRoot, { recursive: true });
    if (mode === "fresh") { delete f.entry.defaultSaveDir; f.entry.saveLocations = []; }
    const { result, persisted } = await migrate(f);
    assert.equal(persisted.saveDirOverride, undefined, mode);
    if (mode === "recovered") {
      assert.deepEqual(result.pendingIds, []);
      const actual = path.join(f.home, "Library", "Application Support", "krkrsdl2");
      assert.equal(persisted.defaultSaveDir, actual);
      assert.equal(fs.readFileSync(path.join(actual, "authoredsc.ksd"), "utf8"), "released save bytes");
      assert.equal(fs.existsSync(f.mirrorRoot), false);
    } else if (mode === "fresh") assert.deepEqual(result.pendingIds, [f.entry.gameId], "a folder alone does not prove a released forced setting");
    else assert.deepEqual(result.pendingIds, []);
  }
});

test("pending conversion preserves explicit overrides and game, per-game-runtime and global datapath arguments", async t => {
  for (const mode of ["override", "game-equals", "game-split", "runtime", "global", "global-with-empty-local"]) {
    const f = fixture(t), chosen = path.join(f.root, "chosen"), settings = {};
    if (mode === "override") f.entry.saveDirOverride = chosen;
    if (mode === "game-equals") f.entry.launchArguments += ` -datapath="${chosen}"`;
    if (mode === "game-split") f.entry.launchArguments += ` -datapath "${chosen}"`;
    if (mode === "runtime") f.entry.runtimeSettings = { krkrsdl2: { args: [`-datapath=${chosen}`] } };
    if (mode.startsWith("global")) settings.modules = { kirikiri: { runtimeSettings: { krkrsdl2: { args: [`-datapath=${chosen}`] } } } };
    if (mode === "global-with-empty-local") f.entry.runtimeSettings = { krkrsdl2: { args: [] } };
    const before = structuredClone(f.entry), beforeSettings = structuredClone(settings);
    const { result, persisted, settings: afterSettings } = await migrate(f, settings);
    assert.deepEqual(result.pendingIds, [f.entry.gameId]);
    assert.equal(persisted.saveDirOverride, before.saveDirOverride, mode);
    assert.equal(persisted.launchArguments, before.launchArguments, mode);
    assert.deepEqual(persisted.runtimeSettings, before.runtimeSettings, mode);
    assert.deepEqual(afterSettings.modules, beforeSettings.modules, mode);
    assert.equal(fs.readFileSync(path.join(f.mirrorRoot, "authoredsc.ksd"), "utf8"), "released save bytes");
  }
});

test("pending fallback refuses linked or non-directory roots and invalid game bounds", async t => {
  for (const mode of ["link", "file", "parent-link"]) {
    const f = fixture(t), preserved = path.join(f.root, "retained");
    if (mode === "parent-link") {
      fs.renameSync(path.dirname(f.mirrorRoot), preserved);
      fs.symlinkSync(preserved, path.dirname(f.mirrorRoot));
    } else {
      fs.renameSync(f.mirrorRoot, preserved);
      if (mode === "link") fs.symlinkSync(preserved, f.mirrorRoot);
      else fs.writeFileSync(f.mirrorRoot, "not a save directory");
    }
    const { result, persisted } = await migrate(f);
    assert.deepEqual(result.pendingIds, [f.entry.gameId]);
    assert.equal(persisted.saveDirOverride, undefined, mode);
    assert.ok(result.retained[0].failures.some(row => /plain existing directory/.test(row.reason)));
  }
  const f = fixture(t);
  assert.equal(Backcompat.migrateLegacyGameData({ ...f.entry, gameId: "../escape" }, { userDataDir: f.userDataDir, games: [f.entry] }), null);
});
