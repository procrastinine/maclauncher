const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Backcompat = require("../src/modules/nscripter/backcompat");
const Module = require("../src/modules/nscripter/main");
const Manager = require("../src/modules/nscripter/runtime/onscripter-en-manager");
const Arguments = require("../src/modules/shared/runtime/launch-arguments");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
const gameFont = require("./helpers/nscripter-game-font.cjs");

function fixture(t, runtimeId = "onsyuri_mac") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nscripter-released-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), gamePath = path.join(root, "original"), home = path.join(root, "home");
  fs.mkdirSync(gamePath); fs.mkdirSync(path.join(home, "Library", "Application Support"), { recursive: true });
  gameFont(gamePath);
  t.mock.method(os, "homedir", () => home);
  const entry = { gameId: "released-game", moduleId: "nscripter", runtimeId, gamePath, contentRootDir: gamePath,
    defaultSaveDir: path.join(userDataDir, "games/released-game/modules/nscripter/saves") };
  const moduleRoot = path.dirname(entry.defaultSaveDir);
  fs.mkdirSync(entry.defaultSaveDir, { recursive: true });
  fs.writeFileSync(path.join(gamePath, "0.txt"), "*define\ngame\n*start\nend\n");
  return { root, userDataDir, gamePath, home, entry, moduleRoot };
}

test("released Yuri saves and cwd configuration reach the current original root with conflicts preserved", async t => {
  const { userDataDir, gamePath, entry, moduleRoot } = fixture(t);
  fs.writeFileSync(path.join(entry.defaultSaveDir, "save1.dat"), "released private progress");
  fs.writeFileSync(path.join(entry.defaultSaveDir, "envdata"), "released private settings");
  fs.writeFileSync(path.join(gamePath, "envdata"), "current original settings");
  fs.writeFileSync(path.join(gamePath, "ons.cfg"), "original config");
  for (const name of ["yuri", "onscripter-en"]) {
    fs.mkdirSync(path.join(moduleRoot, name));
    fs.writeFileSync(path.join(moduleRoot, name, "ons.cfg"), name + " released config");
  }
  let persisted;
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings() {}, saveEntry: working => { persisted = structuredClone(working); } });
  assert.deepEqual(result.pendingIds, []);
  assert.equal(fs.readFileSync(path.join(gamePath, "save1.dat"), "utf8"), "released private progress");
  assert.equal(fs.readFileSync(path.join(gamePath, "envdata"), "utf8"), "current original settings");
  assert.equal(fs.readFileSync(path.join(gamePath, "ons.cfg"), "utf8"), "original config");
  assert.ok(fs.readdirSync(gamePath).some(name => name.startsWith("envdata.MacLauncher-conflict-")));
  assert.equal(fs.readdirSync(gamePath).filter(name => name.startsWith("ons.cfg.MacLauncher-conflict-")).length, 2);
  assert.equal(persisted.defaultSaveDir, gamePath);
  assert.equal(persisted.saveLocations[0].directory, gamePath);
  fs.rmSync(userDataDir, { recursive: true });
  assert.equal(fs.readFileSync(path.join(Module.resolveSaveLocations(persisted).primaryDirectory, "save1.dat"), "utf8"), "released private progress");
});

test("released EN identity is persisted as ordinary argument text and its native save root is initialized once", async t => {
  const { root, userDataDir, gamePath, home, entry } = fixture(t, "onscripter_en");
  entry.launchArguments = '--fullscreen "authored argument"';
  fs.writeFileSync(path.join(entry.defaultSaveDir, "save1.dat"), "released EN progress");
  const nativeRoot = path.join(home, "Library", "Application Support", entry.gameId);
  assert.equal(fs.existsSync(nativeRoot), false);
  const before = JSON.stringify(entry), descriptors = Backcompat.legacyGameMirrors(entry, { userDataDir });
  assert.equal(JSON.stringify(entry), before, "collection must not change the record before recovery succeeds");
  assert.equal(descriptors[0].sourceRoot, nativeRoot);
  assert.equal(descriptors[0].createSourceWithin, path.dirname(nativeRoot));
  let settings;
  const record = path.join(root, "persisted-record.json");
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings: value => { settings = value; }, saveEntry: working => fs.writeFileSync(record, JSON.stringify(working)) });
  assert.deepEqual(result.pendingIds, []);
  const persisted = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(Arguments.parse(persisted.launchArguments), ["--fullscreen", "authored argument", "--gameid", entry.gameId]);
  assert.equal(persisted.defaultSaveDir, nativeRoot);
  assert.equal(persisted.saveLocations[0].directory, nativeRoot);
  assert.equal(persisted.saveDirOverride, undefined, "ordinary upstream identity remains in control");
  t.mock.method(Manager, "resolveSelection", () => ({ ready: true, install: { executablePath: "/stub/onscripter-en" } }));
  let launch;
  await Module.launchRuntime("onscripter_en", persisted, { userDataDir, settings: {}, runtimeSettings: {},
    gameArguments: Arguments.parse(persisted.launchArguments), spawnDetachedChecked: (...args) => { launch = args; return {}; } });
  assert.equal(launch[2].cwd, gamePath);
  assert.equal(launch[1].includes("--save"), false);
  const identity = launch[1][launch[1].lastIndexOf("--gameid") + 1];
  assert.equal(fs.readFileSync(path.join(home, "Library", "Application Support", identity, "save1.dat"), "utf8"), "released EN progress");
  await runDataMigrations({ settings, games: [persisted], userDataDir, registry: { getModule: () => assert.fail("must not revisit a completed game") },
    saveSettings: () => assert.fail("completed migration must not persist again") });
});

test("released EN authored identity wins, conflicts survive, and missing standard anchors do not adopt blank settings", async t => {
  const { userDataDir, home, entry } = fixture(t, "onscripter_en");
  entry.launchArguments = '--gameid "author identity" --window';
  const nativeRoot = path.join(home, "Library", "Application Support", "author identity");
  fs.mkdirSync(nativeRoot);
  fs.writeFileSync(path.join(entry.defaultSaveDir, "save1.dat"), "private conflicting progress");
  fs.writeFileSync(path.join(nativeRoot, "save1.dat"), "current native progress");
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings() {}, saveEntry() {} });
  assert.deepEqual(result.pendingIds, []);
  assert.equal(entry.launchArguments, '--gameid "author identity" --window');
  assert.equal(fs.readFileSync(path.join(nativeRoot, "save1.dat"), "utf8"), "current native progress");
  const conflict = fs.readdirSync(nativeRoot).find(name => name.startsWith("save1.dat.MacLauncher-conflict-"));
  assert.equal(fs.readFileSync(path.join(nativeRoot, conflict), "utf8"), "private conflicting progress");
  const blocked = { ...entry, gameId: "blocked-game", launchArguments: "--window", defaultSaveDir: path.join(userDataDir, "games/blocked-game/modules/nscripter/saves") };
  fs.mkdirSync(blocked.defaultSaveDir, { recursive: true });
  fs.writeFileSync(path.join(blocked.defaultSaveDir, "save1.dat"), "keep private slot");
  t.mock.method(os, "homedir", () => path.join(home, "absent-home"));
  const before = structuredClone(blocked);
  const failure = await runDataMigrations({ settings: {}, games: [blocked], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings() {}, saveEntry() {} });
  assert.deepEqual(failure.pendingIds, [blocked.gameId]);
  assert.deepEqual(blocked, { ...before, saveDirOverride: before.defaultSaveDir },
    "failed recovery preserves the released route through the ordinary visible setting without changing identity");
  assert.equal(fs.readFileSync(path.join(blocked.defaultSaveDir, "save1.dat"), "utf8"), "keep private slot");
});

test("native released-route facts preserve explicit arguments and require the exact released default", t => {
  for (const runtimeId of ["onsyuri_mac", "onscripter_en"]) {
    const { userDataDir, entry } = fixture(t, runtimeId);
    const baseline = structuredClone(entry);
    const collect = current => Backcompat.legacyGameMirrors(current, { userDataDir, games: [baseline] })[0];
    const facts = collect(entry).releasedSaveRoute;
    assert.deepEqual(facts, { directory: entry.defaultSaveDir, entryPatch: { saveDirOverride: entry.defaultSaveDir }, proven: true, explicit: false });
    assert.equal(collect({ ...entry, saveDirOverride: path.join(userDataDir, "generated-choice") }).releasedSaveRoute.explicit, false,
      "a failed generated choice is not an authored baseline setting");
    for (const launchArguments of ['--save "relative chosen"', '--save-dir="chosen"', '-s "chosen"', '--gameid "chosen"', '--gameid=../uncontained', '"unfinished']) {
      const explicit = { ...entry, launchArguments }, before = JSON.stringify(explicit);
      const descriptor = Backcompat.legacyGameMirrors(explicit, { userDataDir, games: [explicit] })[0];
      assert.equal(descriptor.releasedSaveRoute.proven, true);
      assert.equal(descriptor.releasedSaveRoute.explicit, true, launchArguments);
      assert.equal(JSON.stringify(explicit), before, "fact collection does not replace authored text");
      if (runtimeId === "onscripter_en" && ["--save \"relative chosen\"", "--gameid=../uncontained", '"unfinished'].includes(launchArguments))
        assert.equal(descriptor.sourceRoot, null, "ambiguous destination still returns pending facts");
    }
    const selected = { ...entry, saveDirOverride: path.join(userDataDir, "authored-choice") };
    assert.equal(Backcompat.legacyGameMirrors(selected, { userDataDir, games: [selected] })[0].releasedSaveRoute.explicit, true);
    const fresh = { ...entry, defaultSaveDir: entry.contentRootDir };
    assert.equal(Backcompat.legacyGameMirrors(fresh, { userDataDir })[0].releasedSaveRoute.proven, false);
    const offline = { ...entry, contentRootDir: null, gamePath: null };
    assert.equal(Backcompat.legacyGameMirrors(offline, { userDataDir })[0].sourceRoot, null);
    assert.equal(Backcompat.legacyGameMirrors(offline, { userDataDir })[0].releasedSaveRoute.proven, true);
    const web = { ...entry, runtimeId: "onsyuri_web" };
    assert.equal(Backcompat.legacyGameMirrors(web, { userDataDir })[0].releasedSaveRoute.proven, false);
  }
});
