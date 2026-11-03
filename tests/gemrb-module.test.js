const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/gemrb/main");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemrb-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function game(root) {
  fs.mkdirSync(root, { recursive: true });
  const key = Buffer.alloc(38); key.write("KEY V1  "); key.writeUInt32LE(1, 12); key.writeUInt32LE(24, 20);
  fs.writeFileSync(path.join(root, "CHITIN.KEY"), key);
  fs.writeFileSync(path.join(root, "DIALOG.TLK"), "TLK V1  ");
  return Module.detectGame({ rootDir: root, inputPath: root, stat: fs.statSync(root) });
}

test("GemRB requires both valid resource and dialog signatures, preserving unknown format versions", t => {
  const root = temporary(t), detected = game(root);
  assert.equal(detected.moduleId, "gemrb"); assert.equal(detected.moduleData.resourceCount, 1);
  assert.equal(detected.moduleData.detectedVersion, null);
  assert.equal(detected.moduleData.detectedVersionConfidence, "unknown");
  fs.writeFileSync(path.join(root, "CHITIN.KEY"), "KEY V1  ");
  assert.equal(Module.detectGame({ rootDir: root, inputPath: root, stat: fs.statSync(root) }), null);
});

test("GemRB detects GAME format version and family indicators without conflating them with runner version", t => {
  const root = temporary(t); game(root);
  fs.writeFileSync(path.join(root, "BALDUR.GAM"), "GAMEV2.1");
  let detected = Module.detectGame({ rootDir: root, inputPath: root, stat: fs.statSync(root) });
  assert.equal(detected.moduleData.detectedVersion, "GAMEV2.1");
  assert.equal(detected.moduleData.gameType, "bg2");
  assert.equal(detected.moduleData.versionKind, "game-data-format");
  fs.rmSync(path.join(root, "BALDUR.GAM")); fs.writeFileSync(path.join(root, "icewind2.ini"), "[Game Options]\n");
  detected = Module.detectGame({ rootDir: root, inputPath: root, stat: fs.statSync(root) });
  assert.equal(detected.moduleData.gameType, "iwd2"); assert.equal(detected.moduleData.detectedVersion, null);
});

test("GemRB uses original game and save paths with only configuration and cache in launcher storage", t => {
  const root = temporary(t), gameRoot = path.join(root, "game"), data = path.join(root, "data");
  const entry = { ...game(gameRoot), gameId: "fixture" };
  fs.writeFileSync(path.join(gameRoot, "baldur.ini"), "Original settings");
  const context = { userDataDir: data, runtimeSettings: { width: 1024, height: 768, enableCheatKeys: true } };
  const prepared = Module.__test.prepareLaunch(entry, context);
  assert.match(fs.readFileSync(prepared.configPath, "utf8"), /Width=1024\nHeight=768/);
  assert.equal(prepared.config.GamePath, gameRoot);assert.equal(prepared.config.SavePath, gameRoot);
  assert.equal(entry.defaultSaveDir, gameRoot);assert.equal(prepared.root, gameRoot);
  assert.deepEqual(fs.readdirSync(prepared.directory).sort(), ["GemRB.cfg", "cache"]);
  assert.equal(fs.readFileSync(path.join(gameRoot, "baldur.ini"), "utf8"), "Original settings");
  const override = path.join(root, "portable-saves");
  assert.equal(Module.__test.prepareLaunch({...entry, saveDirOverride: override}, context).config.SavePath, override);
  assert.throws(() => Module.__test.configValue("path\nGameType=bad"), /newlines/);
  fs.writeFileSync(path.join(gameRoot, "baldur.gam"), "GAMEV9.9");
  assert.throws(() => Module.__test.prepareLaunch(entry, context), /unsupported/);
});

test("GemRB launch uses versioned registered CLI runtime and explicit configuration", { skip: process.platform !== "darwin" }, async t => {
  const focus = require("../src/modules/shared/runtime/native-focus"), spawnForeground = focus.spawnForegroundNativeGame;
  t.mock.method(focus, "spawnForegroundNativeGame", options => spawnForeground(options, { focus: async () => ({ activated: true }) }));
  const root = temporary(t), gameRoot = path.join(root, "game"), executable = path.join(root, "gemrb");
  const entry = { ...game(gameRoot), gameId: "fixture" };
  const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf);
  binary.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); binary.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, binary, { mode: 0o755 });
  let runtimeChanges = 0;
  Module.actions.registerRuntime(entry, { version: "0.9.5-cli-v2", runtimePath: executable }, {
    userDataDir: root, onRuntimeStateChange: () => { runtimeChanges += 1; }
  });
  assert.equal(entry.runtimeData.gemrb.version, "0.9.5-cli-v2"); assert.equal(runtimeChanges, 1);
  let call;
  await Module.launchRuntime("gemrb", entry, { userDataDir: root, settings: {}, gameArguments: ["--title", "A quoted game", "", "$(literal)"], spawnDetachedChecked: async (...args) => { call = args; return {}; } });
  assert.equal(call[0], executable); assert.equal(call[1][0], "-c");
  assert.ok(call[1][1].endsWith("GemRB.cfg")); assert.equal(call[2].cwd, gameRoot);
  assert.deepEqual(call[1].slice(2), ["--title", "A quoted game", "", "$(literal)"]);
  assert.equal(call[2].env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(call[2].env.SDL_MAC_BACKGROUND_APP, "0");
});

test("GemRB supports an explicit custom game profile without accepting config injection", t => {
  const root = temporary(t), gameRoot = path.join(root, "game");
  const entry = { ...game(gameRoot), gameId: "custom-profile" };
  const context = { userDataDir: path.join(root, "data"), runtimeSettings: { customGameType: "example" } };
  assert.equal(Module.__test.prepareLaunch(entry, context).config.GameType, "example");
  for (const customGameType of ["../example", "example\nPluginsPath=elsewhere", "Example", "a".repeat(65)]) {
    assert.throws(() => Module.__test.prepareLaunch(entry, { ...context, runtimeSettings: { customGameType } }), /safe lowercase/);
  }
});

test("GemRB imports standalone game folders and prepares their unique bundled profile automatically", t => {
  const root = temporary(t), source = path.join(root, "original"), gameRoot = path.join(source, "game"); game(gameRoot);
  const scripts = path.join(source, "GUIScripts", "example"); fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "Start.py"), "# author profile\n");
  fs.writeFileSync(path.join(gameRoot, "assets.bif"), "large immutable archive");
  fs.writeFileSync(path.join(gameRoot, "area.png"), "large immutable image");
  const detected = Module.detectGame({ inputPath: source, rootDir: source, stat: fs.statSync(source) });
  assert.equal(require("../src/modules/registry").explainDetection(source).selectedModuleId, "gemrb");
  assert.equal(detected.contentRootDir, gameRoot); assert.equal(detected.moduleData.bundledGameProfile, "example");
  const entry = { ...detected, gameId: "standalone" }, context = { userDataDir: path.join(root, "data"), settings: {} };
  const requirement = Module.ensureRuntime(entry, context), selected = Module.runtimeManagers[0].resolveSelection(entry, context.settings, context.userDataDir);
  assert.equal(selected.version, null, "An empty offline catalog defers version discovery to consented Play");
  assert.equal(requirement.managerId, "gemrb"); assert.equal(requirement.selectionRequired, undefined);
  assert.equal(requirement.discoveryRequired, true);
  assert.equal(fs.existsSync(path.join(context.userDataDir, "runtimes")), false);
  const explicitPrevious = { ...entry, runtimeData: { gemrb: { version: "0.9.5-cli-v4" } } };
  assert.equal(Module.runtimeManagers[0].resolveSelection(explicitPrevious, context.settings, context.userDataDir).version, "0.9.5-cli-v4");
  const launch = Module.__test.prepareLaunch(entry, context);
  assert.equal(launch.config.GameType, "example"); assert.equal(launch.config.GUIScriptsPath, source);
  assert.equal(launch.config.GamePath, gameRoot);
  assert.equal(fs.lstatSync(path.join(gameRoot, "assets.bif")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(scripts, "Start.py"), "utf8"), "# author profile\n");
  assert.equal(fs.existsSync(path.join(launch.directory, "scripts")), false);
  entry.runtimeData = { gemrb: { version: "0.9.5-cli-v1" } };
  assert.throws(() => Module.ensureRuntime(entry, context), /CLI v1 can crash while loading scripts/);
});

test("GemRB preparation leaves legacy private views and their player bytes untouched", t => {
  const root = temporary(t), gameRoot = path.join(root, "game"), entry = { ...game(gameRoot), gameId: "legacy" };
  const userDataDir = path.join(root, "data"), directory = path.join(userDataDir, "games", entry.gameId, "modules", "gemrb");
  const old = path.join(directory, "game");fs.mkdirSync(old, {recursive:true});
  fs.writeFileSync(path.join(old, "player-save.gam"), "private player state");
  const marker = path.join(directory, "game-root.json"), bytes = JSON.stringify({layoutVersion:3,source:gameRoot});fs.writeFileSync(marker, bytes);
  const launch = Module.__test.prepareLaunch(entry, {userDataDir});
  assert.equal(launch.root, gameRoot);assert.equal(fs.readFileSync(marker, "utf8"), bytes);
  assert.equal(fs.readFileSync(path.join(old, "player-save.gam"), "utf8"), "private player state");
  const before = fs.readdirSync(gameRoot);Module.onImport(entry, {userDataDir});
  assert.equal(entry.defaultSaveDir, gameRoot);assert.deepEqual(fs.readdirSync(gameRoot), before);
});

test("GemRB reuses unchanged generated configuration and resolves old save defaults to the original root", t => {
  const root = temporary(t), gameRoot = path.join(root, "game"), entry = { ...game(gameRoot), gameId: "warm" };
  const context = {userDataDir:path.join(root,"data")}, first = Module.__test.prepareLaunch(entry,context);
  const initial = fs.statSync(first.configPath,{bigint:true});
  Module.__test.prepareLaunch(entry,context);
  const repeated = fs.statSync(first.configPath,{bigint:true});
  assert.equal(repeated.ino,initial.ino);assert.equal(repeated.mtimeNs,initial.mtimeNs);
  const oldDefault = {...entry,defaultSaveDir:path.join(first.directory,"saves"),saveDirOverride:path.join(root,"override")};
  assert.equal(Module.resolveSaveLocations(oldDefault).primaryDirectory,gameRoot);
  Module.__test.prepareLaunch(oldDefault,context);assert.equal(oldDefault.defaultSaveDir,gameRoot);
});
