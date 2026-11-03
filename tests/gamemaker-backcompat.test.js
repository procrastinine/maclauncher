const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Backcompat = require("../src/modules/gamemaker/backcompat");
const { CURRENT_RECORD_SCHEMA_VERSION } = require("../src/core/game-store");
const GameMaker = require("../src/modules/gamemaker/main");
const Official = require("../src/modules/gamemaker/runtime/official");
const OfficialLaunch = require("../src/modules/gamemaker/runtime/official-launch");
const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");

test("GameMaker released save-route facts match only the recorded Butterscotch or Classic route", t => {
  const root = temporary(t), userDataDir = path.join(root, "profile"), dataPath = path.join(root, "original/data.win");
  for (const [runtimeId, relative] of [["butterscotch", "saves"], ["opengmk", "classic/writable"]]) {
    const gameId = runtimeId, oldSaves = path.join(moduleRoot(userDataDir, gameId), relative);
    fs.mkdirSync(oldSaves, { recursive: true });
    const entry = { gameId, runtimeId, defaultSaveDir: oldSaves, moduleData: { dataPath } }, before = structuredClone(entry);
    const route = game => Backcompat.legacyGameMirrors(game, { userDataDir }).find(row => row.mirrorRoot === oldSaves).releasedSaveRoute;
    assert.deepEqual(route(entry), { directory: oldSaves, entryPatch: { saveDirOverride: oldSaves }, proven: true, explicit: false });
    assert.equal(route({ ...entry, defaultSaveDir: path.dirname(dataPath) }), undefined);
    assert.equal(route({ ...entry, saveDirOverride: path.join(root, "chosen") }).explicit, true);
    assert.equal(route({ ...entry, launchArguments: '--working-directory "chosen"' }).explicit, true);
    assert.equal(route({ ...entry, launchArguments: '"unclosed' }).explicit, true);
    const official = { ...entry, runtimeId: "official-studio", defaultSaveDir: path.join(moduleRoot(userDataDir, gameId), "official-saves") };
    assert.ok(Backcompat.legacyGameMirrors(official, { userDataDir }).every(row => row.releasedSaveRoute === undefined), "official bundle alias has no equivalent supported pending route");
    assert.deepEqual(entry, before);
  }
});

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gamemaker-backcompat-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function moduleRoot(userDataDir, gameId) { return path.join(userDataDir, "games", gameId, "modules/gamemaker"); }
function releasedAlias(root, userDataDir, gameId, destination) {
  const identifier = "com.maclauncher.gamemaker." + crypto.createHash("sha256")
    .update(path.resolve(userDataDir) + "\0" + gameId).digest("hex").slice(0, 24);
  const alias = path.join(root, "home/Library/Application Support", identifier);
  fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.symlinkSync(destination, alias); return alias;
}

test("GameMaker backcompat probes only the owned released official root and creates no directories", t => {
  const root = temporary(t), dataPath = path.join(root, "original/data.win"), userDataDir = path.join(root, "launcher");
  const game = { gameId: "legacy", moduleData: { dataPath } }, sourceRoot = path.dirname(dataPath), oldRoot = moduleRoot(userDataDir, game.gameId);
  let probes = 0;
  t.mock.method(fs, "existsSync", file => { assert.equal(file, path.join(oldRoot, "official-saves")); probes++; return false; });
  for (const name of ["statSync", "lstatSync", "readdirSync", "readFileSync", "mkdirSync"]) {
    t.mock.method(fs, name, () => assert.fail(`one-time declaration must not create or inspect unrelated files: ${name}`));
  }
  const descriptors = Backcompat.legacyGameMirrors(game, { userDataDir });
  assert.deepEqual(descriptors.map(({ mirrorRoot, sourceRoot }) => ({ mirrorRoot, sourceRoot })), [
    { mirrorRoot: path.join(oldRoot, "saves"), sourceRoot },
    { mirrorRoot: path.join(oldRoot, "official-saves"), sourceRoot: null },
    { mirrorRoot: path.join(oldRoot, "classic/writable"), sourceRoot }
  ]);
  assert.equal(probes, 1); assert.equal(descriptors[0].entryPatch.defaultSaveDir, sourceRoot);
  game.saveDirOverride = path.join(oldRoot, "saves/custom");
  const active = Backcompat.legacyGameMirrors(game, { userDataDir });
  assert.equal(active.length, 2); assert.ok(active.every(row => row.sourceRoot === game.saveDirOverride));
  assert.ok(active.every(row => row.createSourceWithin === path.dirname(game.saveDirOverride)));
  game.saveDirOverride = oldRoot;
  assert.deepEqual(Backcompat.legacyGameMirrors(game, { userDataDir }), [], "an override containing obsolete roots remains active");
});

test("GameMaker released Butterscotch and Classic saves return to original cwd with conflicts preserved", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), recovered = [];
  // Exact v0.5.1 locations: main.js:66–75 and classic-launch.js:33–70.
  for (const [gameId, relative, filename] of [["studio", "saves", "data.win"], ["classic", "classic/writable", "Game.exe"]]) {
    const sourceRoot = path.join(root, gameId), oldRoot = moduleRoot(userDataDir, gameId), mirrorRoot = path.join(oldRoot, relative);
    fs.mkdirSync(sourceRoot); fs.writeFileSync(path.join(sourceRoot, filename), "original game input");
    fs.mkdirSync(mirrorRoot, { recursive: true });
    const oldSave = Buffer.from([0, 0xff, 0x80, 0x47, 0x4d, 0x38, gameId.length]), original = Buffer.from("original player progress");
    fs.writeFileSync(path.join(mirrorRoot, "save0.bin"), oldSave);
    fs.writeFileSync(path.join(mirrorRoot, "save1.bin"), "released private progress");
    fs.writeFileSync(path.join(sourceRoot, "save1.bin"), original);
    const entry = { gameId, moduleData: { dataPath: path.join(sourceRoot, filename) } };
    const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
    assert.ok(descriptor); assert.equal(descriptor.sourceRoot, sourceRoot);
    const result = await retireLegacyGameMirror(descriptor, { userDataDir });
    assert.equal(result.complete, true, result.reason);
    assert.deepEqual(fs.readFileSync(path.join(sourceRoot, "save0.bin")), oldSave);
    assert.deepEqual(fs.readFileSync(path.join(sourceRoot, "save1.bin")), original);
    const conflicts = fs.readdirSync(sourceRoot).filter(name => name.startsWith("save1.bin.MacLauncher-conflict-"));
    assert.equal(conflicts.length, 1);
    assert.equal(fs.readFileSync(path.join(sourceRoot, conflicts[0]), "utf8"), "released private progress");
    assert.equal(fs.existsSync(mirrorRoot), false);
    recovered.push({ file: path.join(sourceRoot, "save0.bin"), bytes: oldSave, conflict: path.join(sourceRoot, conflicts[0]) });
  }
  fs.rmSync(userDataDir, { recursive: true });
  for (const item of recovered) {
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
    assert.equal(fs.readFileSync(item.conflict, "utf8"), "released private progress");
  }
});

test("GameMaker released official saves with genuinely unavailable host identity remain explicitly blocked", async t => {
  t.mock.method(Official.manager, "resolveSelection", () => ({ install: null }));
  const root = temporary(t), userDataDir = path.join(root, "launcher"), sourceRoot = path.join(root, "original");
  fs.mkdirSync(sourceRoot); const dataPath = path.join(sourceRoot, "data.win"); fs.writeFileSync(dataPath, "original game data");
  const entry = { gameId: "official", moduleId: "gamemaker", runtimeId: "official-studio", moduleData: { dataPath } }, mirrorRoot = path.join(moduleRoot(userDataDir, entry.gameId), "official-saves");
  const save = Buffer.from([0x47, 0x4d, 0x53, 0, 0xff, 0x80]); fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "save.bin"), save);
  const alias = releasedAlias(root, userDataDir, entry.gameId, mirrorRoot);
  const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(descriptor.sourceRoot, null, "game data's cwd does not establish the official runner's save root");
  const { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION } = require("../src/core/backcompat/data-migrations");
  const first = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir, saveSettings: async () => {} });
  assert.equal(first.complete, true); assert.deepEqual(first.pendingIds, [entry.gameId]);
  const state = first.settings.dataMigrations[ORIGINAL_GAME_MIRRORS_MIGRATION];
  assert.ok(state.retained[0].failures.some(row => row.mirrorRoot === mirrorRoot && row.sourceRoot === null && /original game folder for these files is unknown/.test(row.reason)));
  assert.deepEqual(fs.readFileSync(path.join(mirrorRoot, "save.bin")), save);
  assert.equal(fs.readlinkSync(alias), mirrorRoot); assert.equal(fs.existsSync(path.join(sourceRoot, "save.bin")), false);
  await runDataMigrations({ settings: first.settings, games: [entry], registry: { getModule: () => assert.fail("completed diagnostics do not retry") }, userDataDir,
    saveSettings: async () => assert.fail("completed diagnostics do not persist again") });
});

test("GameMaker released official bytes restore into an existing explicit override with conflicts preserved", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), override = path.join(root, "chosen-saves"), sourceRoot = path.join(root, "game");
  fs.mkdirSync(sourceRoot); fs.mkdirSync(override);
  const entry = { gameId: "official-override", moduleId: "gamemaker", runtimeId: "official-studio", saveDirOverride: override, moduleData: { dataPath: path.join(sourceRoot, "data.win") } };
  const mirrorRoot = path.join(moduleRoot(userDataDir, entry.gameId), "official-saves"), bytes = Buffer.from([0, 0x80, 0xff, 1, 2, 3]);
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "save0.bin"), bytes);
  fs.writeFileSync(path.join(mirrorRoot, "save1.bin"), "released progress"); fs.writeFileSync(path.join(override, "save1.bin"), "existing chosen progress");
  const alias = releasedAlias(root, userDataDir, entry.gameId, mirrorRoot);
  const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(descriptor.sourceRoot, override); assert.equal(descriptor.createSourceWithin, root);
  const result = await retireLegacyGameMirror(descriptor, { userDataDir }); assert.equal(result.complete, true, result.reason);
  assert.deepEqual(fs.readFileSync(path.join(override, "save0.bin")), bytes);
  assert.equal(fs.readFileSync(path.join(override, "save1.bin"), "utf8"), "existing chosen progress");
  const conflicts = fs.readdirSync(override).filter(name => name.startsWith("save1.bin.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1); assert.equal(fs.readFileSync(path.join(override, conflicts[0]), "utf8"), "released progress");
  assert.equal(fs.readlinkSync(alias), mirrorRoot, "the old home alias is preserved, not followed or mistaken for byte recovery");
  fs.rmSync(userDataDir, { recursive: true }); assert.deepEqual(fs.readFileSync(path.join(override, "save0.bin")), bytes);
});

test("GameMaker released official state gains the shared host-identity patch only after successful recovery", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), sourceRoot = path.join(root, "original");
  fs.mkdirSync(sourceRoot); const dataPath = path.join(sourceRoot, "data.win"); fs.writeFileSync(dataPath, "original input");
  const host = path.join(root, "Vendor.app"); fs.mkdirSync(path.join(host, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(host, "Contents/Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>com.vendor.shared-runner</string></dict></plist>");
  t.mock.method(Official.manager, "resolveSelection", () => ({ install: { runnerAppPath: host } }));
  const entry = { gameId: "restored-official", moduleId: "gamemaker", runtimeId: "official-studio", launchArguments: "--unchanged",
    runtimeData: { "official-studio": { version: "chosen-version", keep: true }, butterscotch: { version: "keep-too" } },
    moduleData: { dataPath, keep: "metadata" } };
  const mirrorRoot = path.join(moduleRoot(userDataDir, entry.gameId), "official-saves"), bytes = Buffer.from([0, 0x47, 0x4d, 0xff, 0x80]);
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "save.bin"), bytes);
  const before = structuredClone(entry), descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  const restoredRoot = path.join(sourceRoot, "saves", entry.gameId);
  assert.equal(descriptor.sourceRoot, restoredRoot); assert.equal(descriptor.createSourceWithin, sourceRoot);
  assert.deepEqual(entry, before, "describing recovery must not publish settings before copying succeeds");
  assert.equal(fs.existsSync(restoredRoot), false);
  const { runDataMigrations } = require("../src/core/backcompat/data-migrations"), saved = [];
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings: async () => {}, saveEntry: async record => saved.push(structuredClone(record)) });
  assert.equal(result.complete, true); assert.deepEqual(result.pendingIds, []); assert.equal(saved.length, 1);
  assert.equal(saved[0].runtimeData["official-studio"].saveDirOverride, restoredRoot);
  assert.equal(saved[0].defaultSaveDir, restoredRoot); assert.equal(saved[0].saveLocations[0].directory, restoredRoot);
  assert.equal(OfficialLaunch.saveDirectory(entry), restoredRoot); assert.deepEqual(GameMaker.resolveSaveLocations(entry).primaryDirectory, restoredRoot);
  assert.equal(entry.runtimeData["official-studio"].version, "chosen-version"); assert.equal(entry.runtimeData["official-studio"].keep, true);
  assert.deepEqual(entry.runtimeData.butterscotch, before.runtimeData.butterscotch); assert.deepEqual(entry.moduleData, before.moduleData);
  assert.equal(entry.launchArguments, before.launchArguments);
  assert.deepEqual(fs.readFileSync(path.join(restoredRoot, "save.bin")), bytes); assert.equal(fs.existsSync(mirrorRoot), false);
  fs.rmSync(userDataDir, { recursive: true }); assert.deepEqual(fs.readFileSync(path.join(OfficialLaunch.saveDirectory(entry), "save.bin")), bytes);
});

test("GameMaker released official explicit override creates only its missing anchored destination", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), override = path.join(root, "chosen-saves");
  const sourceRoot = path.join(root, "original"); fs.mkdirSync(sourceRoot);
  const entry = { gameId: "missing-override", moduleId: "gamemaker", runtimeId: "official-studio", saveDirOverride: override,
    runtimeData: { "official-studio": { version: "selected" } }, moduleData: { dataPath: path.join(sourceRoot, "data.win") } };
  const mirrorRoot = path.join(moduleRoot(userDataDir, entry.gameId), "official-saves"), bytes = Buffer.from("released save bytes");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "save.bin"), bytes);
  const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(descriptor.createSourceWithin, root); assert.equal(fs.existsSync(override), false);
  const { runDataMigrations } = require("../src/core/backcompat/data-migrations"), saved = [];
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings: async () => {}, saveEntry: async record => saved.push(structuredClone(record)) });
  assert.deepEqual(result.pendingIds, []); assert.equal(saved[0].defaultSaveDir, override); assert.equal(OfficialLaunch.saveDirectory(saved[0]), override);
  assert.deepEqual(fs.readFileSync(path.join(override, "save.bin")), bytes); assert.equal(fs.existsSync(mirrorRoot), false);
  fs.rmSync(userDataDir, { recursive: true }); assert.deepEqual(fs.readFileSync(path.join(override, "save.bin")), bytes);
});

test("GameMaker released official failed anchored recovery does not publish the identity patch", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), original = path.join(root, "original"), outside = path.join(root, "outside");
  fs.mkdirSync(original); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(original, "saves"));
  const host = path.join(root, "Host.app"); fs.mkdirSync(path.join(host, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(host, "Contents/Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>com.vendor.host</string></dict></plist>");
  t.mock.method(Official.manager, "resolveSelection", () => ({ install: { runnerAppPath: host } }));
  const entry = { gameId: "unsafe", moduleId: "gamemaker", runtimeId: "official-studio",
    runtimeData: { "official-studio": { version: "keep" } }, moduleData: { dataPath: path.join(original, "data.win") } };
  const mirrorRoot = path.join(moduleRoot(userDataDir, entry.gameId), "official-saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "save.bin"), "only private progress");
  const before = structuredClone(entry), saved = [], { runDataMigrations } = require("../src/core/backcompat/data-migrations");
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings: async () => {}, saveEntry: async record => saved.push(structuredClone(record)) });
  const expected = { ...before, schemaVersion: CURRENT_RECORD_SCHEMA_VERSION };
  assert.deepEqual(result.pendingIds, [entry.gameId]); assert.deepEqual(entry, expected); assert.deepEqual(saved, [expected]);
  assert.equal(fs.readFileSync(path.join(mirrorRoot, "save.bin"), "utf8"), "only private progress");
  assert.deepEqual(fs.readdirSync(outside), []);
});
