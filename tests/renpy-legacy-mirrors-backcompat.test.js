const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const Renpy = require("../src/modules/renpy/main"), Sdk = require("../src/modules/renpy/runtime/sdk");
const Steam = require("../src/modules/renpy/steam-consumer");
const Backcompat = require("../src/modules/renpy/backcompat");
const { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION: KEY } = require("../src/core/backcompat/data-migrations");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "renpy-legacy-mirrors-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), source = path.join(root, "original");
  fs.mkdirSync(path.join(source, "game"), { recursive: true });
  fs.writeFileSync(path.join(source, "game/script.rpy"), "label start:\n    return\n");
  const entry = { gameId: "fixture", moduleId: "renpy", gamePath: source, contentRootDir: source,
    runtimeId: "sdk", runtimeData: { sdk: { version: "8.5.3" } }, moduleData: { major: 8 } };
  const moduleRoot = path.join(userDataDir, "games/fixture/modules/renpy");
  function project(version, original = source) {
    const mirror = Sdk.resolveWrapperDir(userDataDir, entry.gameId, version);
    fs.mkdirSync(path.join(mirror, "game"), { recursive: true });
    fs.writeFileSync(path.join(mirror, ".maclauncher-renpy-wrapper.json"), JSON.stringify({ source: original, sdkVersion: version }));
    return mirror;
  }
  return { root, userDataDir, source, entry, moduleRoot, project };
}

function compiledPython(source) {
  const text = value => { const bytes = Buffer.from(value), size = Buffer.alloc(4);size.writeUInt32LE(bytes.length);return Buffer.concat([Buffer.from("X"), size, bytes]); };
  const global = name => Buffer.from(`crenpy.ast\n${name}\n`);
  const code = Buffer.concat([global("PyCode"), Buffer.from(")\x81(N", "latin1"), text(source), Buffer.from("tb")]);
  const python = Buffer.concat([global("Python"), Buffer.from(")\x81}(", "latin1"), text("code"), code, Buffer.from("ub")]);
  const init = Buffer.concat([global("Init"), Buffer.from(")\x81}(", "latin1"), text("block"), Buffer.from("]("), python, Buffer.from("eub")]);
  const ast = Buffer.concat([Buffer.from("\x80\x02(}", "latin1"), Buffer.from("]("), init, Buffer.from("et.")]);
  return zlib.deflateSync(ast);
}

async function migrate(f) {
  let settings = {}, saved;
  const result = await runDataMigrations({ settings, games: [f.entry], registry: { getModule: () => Backcompat }, userDataDir: f.userDataDir,
    saveSettings: next => { settings = next; }, saveEntry: entry => { saved = structuredClone(entry); } });
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);
  assert.equal(settings.dataMigrations[KEY].complete, true);
  return { saved, settings };
}

test("Ren'Py legacy mirrors enumerate all old Play versions and retain explicit build workspaces and current helpers", t => {
  const f = fixture(t), first = f.project("8.5.2"), second = f.project("7.8.7"), patched = f.project("patched-8.5.2");
  const built = f.project("8.5.3");
  fs.mkdirSync(path.join(f.moduleRoot, "builds"), { recursive: true });
  fs.writeFileSync(path.join(f.moduleRoot, "builds/builds.json"), JSON.stringify({ builds: [{ sdkVersion: "8.5.3" }] }));
  const helper = Sdk.resolveBootstrapDir(f.userDataDir, f.entry.gameId, "8.5.3");
  fs.mkdirSync(path.join(helper, "game"), { recursive: true });fs.writeFileSync(path.join(helper, "game/helper.rpy"), "owned helper");
  const rows = Backcompat.legacyGameMirrors(f.entry, f), projects = rows.filter(row => row.mirrorRoot.includes(path.sep + "projects" + path.sep));
  assert.deepEqual(projects.map(row => row.mirrorRoot).sort(), [first, second, patched, built].sort());
  assert.equal(projects.find(row => row.mirrorRoot === built).retainMirror, true);
  assert.ok(projects.filter(row => row.mirrorRoot !== built).every(row => row.retainMirror === undefined));
  assert.ok(projects.every(row => row.sourceRoot === f.source));
  assert.ok(projects.filter(row => !row.retainMirror).every(row => row.generated.includes(".maclauncher-renpy-wrapper.json")));
  assert.ok(!projects.find(row => row.retainMirror).generated.includes(".maclauncher-renpy-wrapper.json"));
  assert.ok(!rows.some(row => row.mirrorRoot.startsWith(path.join(f.moduleRoot, "builds")) || row.mirrorRoot.startsWith(helper)));
  assert.equal(fs.readFileSync(path.join(helper, "game/helper.rpy"), "utf8"), "owned helper");
  assert.ok(fs.existsSync(path.join(built, ".maclauncher-renpy-wrapper.json")), "The descriptor hook never retires anything");
});

test("Ren'Py legacy mirrors map game-only wrappers and old shared input paths to the actual original tree", t => {
  const f = fixture(t), view = path.join(f.moduleRoot, "writable-input/files");
  f.entry.moduleData.writableInput = { schemaVersion: 1, root: view, sourceRoot: f.source };
  f.entry.contentRootDir = view;
  const mirror = f.project("8.5.2", view);
  let rows = Backcompat.legacyGameMirrors(f.entry, f);
  assert.deepEqual(rows.find(row => row.mirrorRoot === view), { mirrorRoot: view, sourceRoot: f.source,
    entryPatch: { contentRootDir: f.source } });
  assert.equal(f.entry.contentRootDir, view, "Describing recovery cannot rewrite the live record before copying");
  assert.equal(rows.find(row => row.mirrorRoot === mirror).sourceRoot, f.source);
  const gameOnly = path.join(f.source, "game");
  f.entry.contentRootDir = gameOnly;f.entry.moduleData = { major: 8, gameOnly: true };
  fs.writeFileSync(path.join(mirror, ".maclauncher-renpy-wrapper.json"), JSON.stringify({ source: gameOnly }));
  rows = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(rows.find(row => row.mirrorRoot === mirror).sourceRoot, f.source,
    "A mirrored game/file maps to original-project/game/file rather than game/game/file");
});

test("Ren'Py legacy mirrors mark old Steam generated files only when their owned receipt validates", t => {
  const f = fixture(t), mirror = f.project("8.5.2");
  const bootstrap = Steam.ensureBootstrap(mirror, { gameRoot: f.source, python: path.join(f.root, "python"),
    runtimeExecutable: path.join(f.root, "renpy"), libraryPath: path.join(f.root, "libsteam_api.dylib"), appId: 264380 });
  const body = fs.readFileSync(bootstrap.script, "utf8").split("init -1500 python in _maclauncher_steam:\n")[1].split("\n").map(line => line.startsWith("    ") ? line.slice(4) : line).join("\n");
  fs.writeFileSync(bootstrap.script + "c", compiledPython(body));
  let row = Backcompat.legacyGameMirrors(f.entry, f).find(row => row.mirrorRoot === mirror);
  assert.ok(row.generated.includes("game/00_maclauncher_steam.rpy"));
  assert.ok(row.generated.includes("game/00_maclauncher_steam.rpyc"));
  assert.ok(row.generated.includes(".maclauncher-renpy-steam/steam_appid.txt"));
  fs.appendFileSync(bootstrap.script, "# changed private bytes\n");
  row = Backcompat.legacyGameMirrors(f.entry, f).find(row => row.mirrorRoot === mirror);
  assert.deepEqual(row.generated, [".maclauncher-renpy-wrapper.json"]);
  assert.match(fs.readFileSync(bootstrap.script, "utf8"), /changed private bytes/);
});

test("Ren'Py legacy mirrors leave unknown links and ambiguous build records for safe retention", t => {
  const f = fixture(t), projects = path.join(f.moduleRoot, "projects");
  fs.mkdirSync(projects, { recursive: true });
  const mirror = path.join(projects, "unknown");fs.symlinkSync(f.source, mirror, "dir");
  t.mock.method(Steam, "hasPreparedBootstrap", () => assert.fail("A linked project must not be inspected"));
  const rows = Backcompat.legacyGameMirrors(f.entry, f);
  assert.ok(rows.some(row => row.mirrorRoot === mirror));
  assert.equal(fs.lstatSync(mirror).isSymbolicLink(), true);
  fs.mkdirSync(path.join(f.moduleRoot, "builds"));fs.writeFileSync(path.join(f.moduleRoot, "builds/builds.json"), "{}");
  assert.throws(() => Backcompat.legacyGameMirrors(f.entry, f), /build records/);
  assert.equal(fs.readFileSync(path.join(f.source, "game/script.rpy"), "utf8"), "label start:\n    return\n");
});

test("Ren'Py legacy mirrors are never probed by ordinary save-location discovery", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "game/options.rpy"), "define config.save_directory = None\n");
  t.mock.method(Sdk, "resolveWrapperDir", () => assert.fail("Save discovery must not resolve old projects"));
  t.mock.method(Steam, "hasPreparedBootstrap", () => assert.fail("Save discovery must not inspect old bootstrap state"));
  for (const method of ["statSync", "lstatSync", "existsSync", "readdirSync", "readFileSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => {
      assert.ok(!String(file).includes(path.sep + "projects" + path.sep), "No old project filesystem lookup");
      return original(file, ...args);
    });
  }
  for (let index = 0; index < 2; ++index) {
    const location = Renpy.resolveSaveLocations(f.entry, { userDataDir: f.userDataDir, env: {} });
    assert.equal(location.primaryDirectory, path.join(f.source, "game/saves"));
  }
});


for (const runtimeId of ["sdk", "patched"]) test(`released v0.5.1 Ren'Py ${runtimeId} save/config bytes reach original defaults and preserve conflicts`, async t => {
  const f = fixture(t), version = runtimeId === "sdk" ? "8.5.3" : "patched-8.5.3";
  f.entry.runtimeId = runtimeId;f.entry.moduleData.version = "8.5.3";
  const mirror = f.project(version), oldSaves = path.join(mirror, "game/saves"), newSaves = path.join(f.source, "game/saves");
  fs.mkdirSync(oldSaves);fs.writeFileSync(path.join(oldSaves, "slot.save"), "released private save");
  fs.writeFileSync(path.join(oldSaves, "persistent"), "released preferences");
  fs.writeFileSync(path.join(mirror, "settings.json"), "released cwd configuration");
  fs.writeFileSync(path.join(f.source, "game/options.rpy"), "define config.save_directory = None\n");
  f.entry.defaultSaveDir = oldSaves;f.entry.saveLocations = [{ directory: oldSaves, role: "primary" }];
  f.entry.moduleData.saveDirectories = [{ directory: oldSaves, role: "primary" }];
  assert.equal(fs.existsSync(newSaves), false, "The upstream default destination starts absent");
  const { saved } = await migrate(f);
  const location = Renpy.resolveSaveLocations(saved, { userDataDir: f.userDataDir, env: {} });
  assert.equal(location.primaryDirectory, newSaves);
  assert.equal(fs.readFileSync(path.join(location.primaryDirectory, "slot.save"), "utf8"), "released private save");
  assert.equal(fs.readFileSync(path.join(location.primaryDirectory, "persistent"), "utf8"), "released preferences");
  assert.equal(fs.readFileSync(path.join(f.source, "settings.json"), "utf8"), "released cwd configuration");
  assert.equal(saved.defaultSaveDir, newSaves);assert.equal(saved.saveLocations[0].directory, newSaves);
  assert.equal(saved.moduleData.saveDirectories[0].directory, newSaves);
  assert.equal(saved.gamePath, f.source);assert.equal(saved.gameId, f.entry.gameId);
  assert.equal(fs.existsSync(mirror), false);
  // A separate released profile meets an existing original save: preserve
  // that original and keep its private value as an independent sibling copy.
  const second = fixture(t), conflict = second.project(version), actual = path.join(second.source, "game/saves");
  fs.mkdirSync(actual);fs.writeFileSync(path.join(actual, "slot.save"), "existing original");
  fs.mkdirSync(path.join(conflict, "game/saves"));fs.writeFileSync(path.join(conflict, "game/saves/slot.save"), "released conflicting save");
  await migrate(second);
  assert.equal(fs.readFileSync(path.join(actual, "slot.save"), "utf8"), "existing original");
  const sibling = fs.readdirSync(actual).find(name => name.startsWith("slot.save.MacLauncher-conflict-"));
  assert.ok(sibling);assert.equal(fs.readFileSync(path.join(actual, sibling), "utf8"), "released conflicting save");
  assert.equal(fs.lstatSync(path.join(actual, sibling)).isSymbolicLink(), false);
});

test("released v0.5.1 Ren'Py portable data restores its missing canonical destination and per-game identity", async t => {
  const f = fixture(t), view = path.join(f.moduleRoot, "writable-input/files"), oldPortable = path.join(view, "Ren'Py Data/Title-1234");
  fs.mkdirSync(oldPortable, { recursive: true });fs.writeFileSync(path.join(oldPortable, "persistent"), "released portable preferences");
  fs.writeFileSync(path.join(f.source, "game/options.rpy"), 'define config.save_directory = "Title-1234"\n');
  f.entry.runtimeId = "patched";f.entry.contentRootDir = view;f.entry.defaultSaveDir = oldPortable;
  f.entry.moduleData.writableInput = { schemaVersion: 1, root: view, sourceRoot: f.source };
  assert.equal(fs.existsSync(path.join(f.source, "Ren'Py Data")), false);
  const { saved } = await migrate(f);
  const location = Renpy.resolveSaveLocations(saved, { userDataDir: f.userDataDir, homeDir: path.join(f.root, "home"), env: {} });
  assert.equal(location.primaryDirectory, path.join(f.source, "Ren'Py Data/Title-1234"));
  assert.equal(saved.contentRootDir, f.source);assert.equal(saved.defaultSaveDir, location.primaryDirectory);
  assert.equal(fs.readFileSync(path.join(location.primaryDirectory, "persistent"), "utf8"), "released portable preferences");
});

test("released v0.5.1 Ren'Py Play plus build workspace recovers saves without retiring current build data", async t => {
  const f = fixture(t), mirror = f.project("8.5.3"), saves = path.join(mirror, "game/saves");
  fs.mkdirSync(saves);fs.writeFileSync(path.join(saves, "slot.save"), "released Play plus build save");
  const builds = path.join(f.moduleRoot, "builds"), output = path.join(builds, "8.5.3/date/Game.app/Contents/Resources");
  fs.mkdirSync(output, { recursive: true });fs.writeFileSync(path.join(output, "retained"), "explicit build output");
  fs.writeFileSync(path.join(builds, "builds.json"), JSON.stringify({ builds: [{ sdkVersion: "8.5.3" }] }));
  const receipt = fs.readFileSync(path.join(mirror, ".maclauncher-renpy-wrapper.json"));
  const bootstrap = Steam.ensureBootstrap(mirror, { gameRoot: f.source, python: path.join(f.root, "python"),
    runtimeExecutable: path.join(f.root, "renpy"), libraryPath: path.join(f.root, "libsteam_api.dylib"), appId: 264380 });
  const body = fs.readFileSync(bootstrap.script, "utf8").split("init -1500 python in _maclauncher_steam:\n")[1].split("\n").map(line => line.startsWith("    ") ? line.slice(4) : line).join("\n");
  fs.writeFileSync(bootstrap.script + "c", compiledPython(body));
  f.entry.defaultSaveDir = saves;
  const { saved } = await migrate(f);
  assert.equal(saved.defaultSaveDir, path.join(f.source, "game/saves"));
  assert.equal(Renpy.resolveSaveLocations(saved, { userDataDir: f.userDataDir, env: {} }).primaryDirectory, saved.defaultSaveDir);
  assert.equal(fs.readFileSync(path.join(saved.defaultSaveDir, "slot.save"), "utf8"), "released Play plus build save");
  assert.equal(fs.readFileSync(path.join(saves, "slot.save"), "utf8"), "released Play plus build save");
  assert.deepEqual(fs.readFileSync(path.join(mirror, ".maclauncher-renpy-wrapper.json")), receipt);
  assert.equal(fs.readFileSync(path.join(output, "retained"), "utf8"), "explicit build output");
  assert.equal(fs.existsSync(bootstrap.script), false);assert.equal(fs.existsSync(bootstrap.script + "c"), false);
  assert.equal(fs.existsSync(path.join(f.source, "game/00_maclauncher_steam.rpy")), false);
});


test("released v0.5.1 Ren'Py game-only SDK saves map to the original game directory without a second game level", async t => {
  const f = fixture(t), game = path.join(f.source, "game"), mirror = f.project("8.5.3", game);
  f.entry.contentRootDir = game;f.entry.moduleData.gameOnly = true;
  fs.writeFileSync(path.join(game, "options.rpy"), "define config.save_directory = None\n");
  const actual = path.join(game, "saves"), old = path.join(mirror, "game/saves");
  fs.mkdirSync(actual);fs.writeFileSync(path.join(actual, "conflict.save"), "original game-only save");
  fs.mkdirSync(old);fs.writeFileSync(path.join(old, "slot.save"), "released game-only save");
  fs.writeFileSync(path.join(old, "conflict.save"), "private game-only conflict");
  f.entry.defaultSaveDir = old;
  const { saved } = await migrate(f);
  const location = Renpy.resolveSaveLocations(saved, { userDataDir: f.userDataDir, env: {} });
  assert.equal(location.primaryDirectory, actual);assert.equal(saved.defaultSaveDir, actual);
  assert.equal(fs.readFileSync(path.join(actual, "slot.save"), "utf8"), "released game-only save");
  assert.equal(fs.readFileSync(path.join(actual, "conflict.save"), "utf8"), "original game-only save");
  const sibling = fs.readdirSync(actual).find(name => name.startsWith("conflict.save.MacLauncher-conflict-"));
  assert.ok(sibling);assert.equal(fs.readFileSync(path.join(actual, sibling), "utf8"), "private game-only conflict");
  assert.equal(fs.existsSync(path.join(game, "game/saves")), false);
});

test("released v0.5.1 Ren'Py authored save identity remains unchanged while its private local copy returns", async t => {
  const f = fixture(t), mirror = f.project("8.5.3"), home = path.join(f.root, "Home"), primary = path.join(home, "Library/RenPy/AuthoredGame-1234");
  fs.mkdirSync(primary, { recursive: true });fs.writeFileSync(path.join(primary, "persistent"), "authored primary preferences");
  fs.writeFileSync(path.join(f.source, "game/options.rpy"), 'define config.save_directory = "AuthoredGame-1234"\n');
  fs.mkdirSync(path.join(mirror, "game/saves"));fs.writeFileSync(path.join(mirror, "game/saves/slot.save"), "released local copy");
  f.entry.defaultSaveDir = primary;
  const { saved } = await migrate(f);
  const location = Renpy.resolveSaveLocations(saved, { userDataDir: f.userDataDir, homeDir: home, env: {} });
  assert.equal(location.primaryDirectory, primary);assert.equal(saved.defaultSaveDir, primary);
  assert.equal(fs.readFileSync(path.join(primary, "persistent"), "utf8"), "authored primary preferences");
  assert.equal(fs.readFileSync(path.join(f.source, "game/saves/slot.save"), "utf8"), "released local copy");
});

test("Ren'Py no-authored-id fallback is per original game path even when titles and directory names match", t => {
  const f = fixture(t), roots = [path.join(f.root, "First/SameTitle"), path.join(f.root, "Second/SameTitle")];
  const locations = roots.map((root, index) => {
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    fs.writeFileSync(path.join(root, "game/options.rpy"), "define config.save_directory = None\n");
    return Renpy.resolveSaveLocations({ ...f.entry, gameId: "game" + index, gamePath: root, contentRootDir: root,
      moduleData: { major: 8 } }, { userDataDir: f.userDataDir, env: {} }).primaryDirectory;
  });
  assert.deepEqual(locations, roots.map(root => path.join(root, "game/saves")));
  assert.notEqual(locations[0], locations[1]);
});

test("Ren'Py failed recovery retains private bytes and persisted paths while successful roots remap cumulatively", async t => {
  const f = fixture(t), missing = path.join(f.root, "unavailable-original");
  const failed = f.project("7.8.7", missing), first = f.project("8.5.2"), second = f.project("8.5.3");
  const roots = [failed, first, second];
  for (const [index, mirror] of roots.entries()) {
    fs.mkdirSync(path.join(mirror, "game/saves"));
    fs.writeFileSync(path.join(mirror, `game/saves/slot-${index}.save`), `private bytes ${index}`);
  }
  const oldSave = path.join(failed, "game/saves"), external = path.join(f.root, "user-override");
  Object.assign(f.entry, { contentRootDir: failed, indexDir: path.join(failed, "game"),
    indexHtml: path.join(failed, "game/index.html"), defaultSaveDir: oldSave, saveDirOverride: external,
    saveLocations: roots.map((root, index) => ({ id: String(index), directory: path.join(root, "game/saves"), role: "secondary" })) });
  f.entry.moduleData.saveDirectories = structuredClone(f.entry.saveLocations);
  f.entry.moduleData.unrelated = { preserve: true };
  const original = structuredClone(f.entry);
  const descriptors = Backcompat.legacyGameMirrors(f.entry, f);
  assert.deepEqual(f.entry, original, "Discovery must never publish proposed restored paths");
  assert.deepEqual(descriptors.find(row => row.mirrorRoot === failed).entryPatch,
    { contentRootDir: missing, indexDir: path.join(missing, "game"), indexHtml: path.join(missing, "game/index.html") });
  let saved, settings = {}, calls = 0;
  const options = { games: [f.entry], registry: { getModule: () => ({ ...Backcompat,
    legacyGameMirrors: (...args) => { calls++;return Backcompat.legacyGameMirrors(...args); } }) }, userDataDir: f.userDataDir,
    saveSettings: next => { settings = next; }, saveEntry: entry => { saved = structuredClone(entry); } };
  const result = await runDataMigrations({ ...options, settings });
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, [f.entry.gameId]);
  assert.ok(result.retained[0].failures.some(row => row.mirrorRoot === failed));
  for (const key of ["gameId", "gamePath", "contentRootDir", "indexDir", "indexHtml", "defaultSaveDir", "saveDirOverride"])
    assert.equal(saved[key], original[key], key + " must survive the failed root unchanged");
  const expected = [oldSave, path.join(f.source, "game/saves"), path.join(f.source, "game/saves")];
  assert.deepEqual(saved.saveLocations.map(row => row.directory), expected);
  assert.deepEqual(saved.moduleData.saveDirectories.map(row => row.directory), expected);
  assert.deepEqual(saved.moduleData.unrelated, { preserve: true });
  assert.equal(fs.readFileSync(path.join(oldSave, "slot-0.save"), "utf8"), "private bytes 0");
  assert.equal(fs.existsSync(missing), false);
  for (const index of [1, 2]) {
    assert.equal(fs.readFileSync(path.join(f.source, `game/saves/slot-${index}.save`), "utf8"), `private bytes ${index}`);
    assert.equal(fs.existsSync(roots[index]), false);
  }
  await runDataMigrations({ ...options, settings });
  assert.equal(calls, 1, "A retained failure must never automatically probe or retry on later startups");
});
