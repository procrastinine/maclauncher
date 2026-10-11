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

test("GemRB isolates configurations, caches and saves and rejects unsupported GAME formats", t => {
  const root = temporary(t), gameRoot = path.join(root, "game"), data = path.join(root, "data");
  const entry = { ...game(gameRoot), gameId: "fixture" };
  const original = fs.readdirSync(gameRoot);
  fs.writeFileSync(path.join(gameRoot, "baldur.ini"), "Original settings");
  fs.writeFileSync(path.join(gameRoot, "GemRB.log"), "Original log");
  fs.writeFileSync(path.join(gameRoot, "gemrb_path.txt"), "Original paths");
  original.push("baldur.ini", "GemRB.log", "gemrb_path.txt"); original.sort();
  const context = { userDataDir: data, runtimeSettings: { width: 1024, height: 768, enableCheatKeys: true } };
  const prepared = Module.__test.prepareLaunch(entry, context);
  const config = fs.readFileSync(prepared.configPath, "utf8");
  assert.match(config, /Width=1024\nHeight=768/); assert.match(config, /EnableCheatKeys=1/);
  assert.ok(prepared.saveRoot.startsWith(path.join(data, "games", "fixture", "modules", "gemrb")));
  assert.deepEqual(fs.readdirSync(gameRoot), original);
  assert.equal(prepared.config.GamePath, prepared.stagedRoot);
  fs.writeFileSync(path.join(prepared.stagedRoot, "baldur.ini"), "Runtime settings");
  fs.writeFileSync(path.join(prepared.stagedRoot, "GemRB.log"), "Runtime log");
  fs.writeFileSync(path.join(prepared.stagedRoot, "gemrb_path.txt"), "Runtime paths");
  assert.equal(fs.readFileSync(path.join(gameRoot, "baldur.ini"), "utf8"), "Original settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "GemRB.log"), "utf8"), "Original log");
  assert.equal(fs.readFileSync(path.join(gameRoot, "gemrb_path.txt"), "utf8"), "Original paths");
  assert.equal(fs.readFileSync(Module.__test.prepareLaunch(entry, context).stagedRoot + "/baldur.ini", "utf8"), "Runtime settings");
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
  await Module.launchRuntime("gemrb", entry, { userDataDir: root, settings: {}, spawnDetachedChecked: async (...args) => { call = args; return {}; } });
  assert.equal(call[0], executable); assert.equal(call[1][0], "-c");
  assert.ok(call[1][1].endsWith("GemRB.cfg")); assert.equal(call[2].cwd, path.dirname(call[1][1]));
  assert.equal(call[2].env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(call[2].env.SDL_MAC_BACKGROUND_APP, "0");
});

test("GemRB source overlay redirects install-name changes to a copied library and adds a CLI entry", t => {
  const root = temporary(t), source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "gemrb"), { recursive: true });
  fs.mkdirSync(path.join(source, "platforms", "apple", "CocoaWrapper", "mac"), { recursive: true });
  const cmake = 'get_filename_component(SDL_FULL_PATH "${SDL_LIB}" REALPATH)\nADD_CUSTOM_COMMAND(TARGET gemrb PRE_BUILD COMMAND tool "${SDL_FULL_PATH}")\n  # compile nib\n  ADD_CUSTOM_COMMAND (TARGET gemrb POST_BUILD\n COMMAND ibtool\n COMMENT "Compiling GemRB.xib")\n';
  const wrapper = '#import "Logging/Logging.h"\nint main (int __unused argc, char ** __unused argv)\n{\n return 0;\n}\n';
  fs.writeFileSync(path.join(source, "gemrb", "CMakeLists.txt"), cmake);
  const entry = path.join(source, "platforms", "apple", "CocoaWrapper", "mac", "CocoaWrapper.mm");
  fs.writeFileSync(entry, wrapper);
  require("../src/modules/gemrb/runtime/build").adaptSource(source, "0.9.5-cli-v1");
  const adapted = fs.readFileSync(path.join(source, "gemrb", "CMakeLists.txt"), "utf8");
  assert.ok(adapted.includes('"${BUNDLE_FRAMEWORK_PATH}/${SDL_REAL_BASENAME}")'));
  assert.equal(adapted.includes('COMMAND tool "${SDL_FULL_PATH}")'), false);
  assert.equal(adapted.includes("Compiling GemRB.xib"), false);
  assert.match(fs.readFileSync(entry, "utf8"), /LoadFromArgs\(argc, argv\)/);
  assert.throws(() => require("../src/modules/gemrb/runtime/build").adaptSource(source, "0.9.5-cli-v1"), /no longer matches/);
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

test("GemRB published catalogs distinguish the reviewed CLI adapter from unqualified older releases", async () => {
  const { mapRelease } = require("../src/modules/gemrb/runtime/catalog");
  const revision = "b".repeat(40), metadata = { resolveRevision: async () => revision, sourceUrl: "https://github.com/gemrb/gemrb/releases/tag/v0.9.5" };
  const latest = await mapRelease({ tag_name: "v0.9.5" }, metadata);
  assert.equal(latest.version, "0.9.5-cli-v2"); assert.equal(latest.publishedVersion, "0.9.5");
  assert.equal(latest.upstreamTag, "v0.9.5"); assert.equal(latest.upstreamRevision, revision); assert.equal(latest.localBuild, true);
  const previous = await mapRelease({ tag_name: "v0.9.4" }, metadata);
  assert.equal(previous.version, "0.9.4"); assert.equal(previous.localBuild, false); assert.equal(previous.asset, undefined);
  assert.match(previous.installReason, /No compatible Mac CLI runtime/);
  assert.equal(await mapRelease({ tag_name: "latest" }, metadata), null);
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
  assert.equal(selected.version, "0.9.5-cli-v4");
  const versionField = require("../src/modules/gemrb/manifest.json").runtime.entries.gemrb.settings.fields
    .find(field => field.key === "version");
  assert.ok(versionField.options.some(option => option.value === selected.version));
  if (selected.ready) {
    assert.equal(requirement, null); assert.equal(selected.install.bundledExecution, "direct");
    assert.equal(fs.existsSync(path.join(context.userDataDir, "runtimes")), false);
  } else assert.deepEqual(requirement, { managerId: "gemrb", version: "0.9.5-cli-v4", installOptions: {} });
  const launch = Module.__test.prepareLaunch(entry, context);
  assert.equal(launch.config.GameType, "example"); assert.ok(launch.config.GUIScriptsPath.startsWith(context.userDataDir));
  assert.equal(fs.lstatSync(path.join(launch.stagedRoot, "assets.bif")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(launch.stagedRoot, "area.png")).isSymbolicLink(), true);
  fs.writeFileSync(path.join(launch.config.GUIScriptsPath, "GUIScripts", "example", "Start.py"), "# managed write\n");
  assert.equal(fs.readFileSync(path.join(scripts, "Start.py"), "utf8"), "# author profile\n");
  entry.runtimeData = { gemrb: { version: "0.9.5-cli-v1" } };
  assert.throws(() => Module.ensureRuntime(entry, context), /CLI v1 can crash while loading scripts/);
});

test("GemRB shrinks old resource copies without replacing edited sidecars or player files", t => {
  const root = temporary(t), gameRoot = path.join(root, "game"), entry = { ...game(gameRoot), gameId: "upgrade" };
  fs.writeFileSync(path.join(gameRoot, "area.png"), "immutable area image");
  fs.writeFileSync(path.join(gameRoot, "game.ini"), "original options");
  const context = { userDataDir: path.join(root, "data") }, launch = Module.__test.prepareLaunch(entry, context);
  const marker = path.join(launch.directory, "game-root.json");
  fs.writeFileSync(marker, JSON.stringify({ layoutVersion: 3, source: gameRoot }));
  const area = path.join(launch.stagedRoot, "area.png");
  fs.rmSync(area); fs.copyFileSync(path.join(gameRoot, "area.png"), area);
  fs.writeFileSync(path.join(launch.stagedRoot, "game.ini"), "player options");
  fs.writeFileSync(path.join(launch.stagedRoot, "player-state.json"), "player state");
  const upgraded = Module.__test.prepareLaunch(entry, context);
  assert.equal(fs.lstatSync(area).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(upgraded.stagedRoot, "game.ini"), "utf8"), "player options");
  assert.equal(fs.readFileSync(path.join(upgraded.stagedRoot, "player-state.json"), "utf8"), "player state");
  assert.equal(fs.readFileSync(path.join(gameRoot, "game.ini"), "utf8"), "original options");
});
