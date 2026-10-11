const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const GameRuntime = require("../src/modules/rgss/runtime/mkxpz-game-runtime");
const ConfigHelper = require("../src/modules/rgss/runtime/mkxpz-config-helper");
const Launcher = require("../src/modules/rgss/runtime/mkxpz-launcher");
const Manager = require("../src/modules/rgss/runtime/mkxpz-manager");
const Assets = require("../src/modules/rgss/assets");
const WritableRgss = require("../src/modules/rgss/writable-input");

function executable(marker) {
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12); return Buffer.concat([header, Buffer.from(marker)]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-mkxpz-isolation-")), userDataDir = path.join(root, "userdata");
  t.after(() => { Assets.removeStagedAssets({ userDataDir }); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceApp = path.join(root, "publisher", "Z-universal.app"), native = path.join(sourceApp, "Contents", "MacOS", "Z-universal");
  const sourceConfig = path.join(sourceApp, GameRuntime.MUTABLE_CONFIG), resource = path.join(sourceApp, "Contents", "Resources", "library.rb");
  for (const file of [native, sourceConfig, resource]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(native, executable("publisher-native"), { mode: 0o755 });
  fs.writeFileSync(path.join(sourceApp, "Contents", "Info.plist"), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Z-universal</string></dict></plist>');
  fs.writeFileSync(sourceConfig, JSON.stringify({ gameFolder: "unrelated-prior-game", windowTitle: "Old game" }));
  fs.writeFileSync(resource, "immutable Ruby runtime");
  const assetRoot = path.join(root, "runtime-resources"), kawarikiRoot = path.join(root, "kawariki");
  for (const pack of ["Standard", "RPGVX", "RPGVXAce"]) { const dir = path.join(assetRoot, "rtp", pack); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "dummy.txt"), pack); }
  fs.mkdirSync(path.join(assetRoot, "soundfont")); fs.writeFileSync(path.join(assetRoot, "soundfont", "GMGSx.SF2"), "font");
  fs.mkdirSync(kawarikiRoot); fs.writeFileSync(path.join(kawarikiRoot, "preload.rb"), "# fixture preload");
  const ensure = Assets.ensureAssetsStaged;
  t.mock.method(Assets, "ensureAssetsStaged", options => ensure({ ...options, resourceRoot: assetRoot, kawarikiRoot }));
  const helper = { version: "fixture-helper-v1", architectures: ["arm64", "x86_64"], dylibPath: path.join(root, "shared", "mkxpz-config.dylib"), binarySha256: "a".repeat(64), sourceSha256: "b".repeat(64), manifestSha256: "c".repeat(64), minimumMacOS: "11.0" };
  t.mock.method(ConfigHelper, "resolveConfigHelper", async () => helper);
  t.mock.method(ConfigHelper, "assertInjectionCompatible", async () => ({ flags: 2, injectionCompatible: true }));
  const source = { version: "fixture-v1", appPath: sourceApp, included: true, source: "Bundled" };
  const prepare = gameId => GameRuntime.prepareGameRuntime({ userDataDir, gameId, source, helper });
  return { root, userDataDir, sourceApp, native, sourceConfig, resource, source, helper, prepare };
}
function treeIdentity(root) {
  const result = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name), stat = fs.lstatSync(full);
      result.push([path.relative(root, full), stat.mode & 0o777, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "directory"]);
      if (stat.isDirectory()) walk(full);
    }
  }
  walk(root); return result;
}
function entry(f, gameId = "game-a", version = f.source.version) {
  const game = path.join(f.root, "originals", gameId); fs.mkdirSync(game, { recursive: true }); fs.writeFileSync(path.join(game, "Game.ini"), "[Game]\nTitle=" + gameId);
  return { gameId, name: gameId, gamePath: game, contentRootDir: game, moduleData: { rgssVersion: "RGSS3" }, runtimeData: { mkxpz: { version } } };
}
function options(f, game, spawn) {
  return { entry: game, userDataDir: f.userDataDir, settings: {}, runtimeSettings: { windowTitle: game.name }, spawnDetachedChecked: spawn };
}

test("two immutable-container games keep independent portable views with the same unchanged MKXP-Z executable", async t => {
  const f = fixture(t), nativeBefore = treeIdentity(f.sourceApp), launches = [];
  t.mock.method(Manager.core, "resolveBundledRuntime", () => f.source);
  t.mock.method(Manager.core, "installBundledRuntime", () => assert.fail("Included runtime must stay shared"));
  const games = [entry(f, "container-a"), entry(f, "container-b")];
  for (const game of games) {
    game.moduleId = "rgss"; game.containerData = { extractedRoot: game.contentRootDir, key: game.gameId };
    fs.writeFileSync(path.join(game.contentRootDir, "Game.rgss3a"), "immutable packed assets");
  }
  const originals = treeIdentity(path.join(f.root, "originals"));
  const inputs = games.map(game => WritableRgss.prepareInput(game, { userDataDir: f.userDataDir }));
  let release; const barrier = new Promise(resolve => { release = resolve; });
  await Promise.all(inputs.map(input => Launcher.launchRuntime(options(f, input, async (command, args, opts) => {
    launches.push({ command, args, opts }); if (launches.length === 2) release(); await barrier;
    const config = JSON.parse(fs.readFileSync(path.join(opts.cwd, "mkxp.json")));
    assert.equal(config.gameFolder, input.contentRootDir); assert.equal(command, fs.realpathSync(f.native));
    fs.writeFileSync(path.join(input.contentRootDir, "Save01.rvdata2"), input.gameId);
    return new EventEmitter();
  }))));
  assert.equal(new Set(launches.map(item => item.command)).size, 1);
  assert.notEqual(launches[0].opts.cwd, launches[1].opts.cwd);
  assert.notEqual(inputs[0].defaultSaveDir, inputs[1].defaultSaveDir);
  for (let i = 0; i < games.length; i++) {
    assert.equal(games[i].contentRootDir, games[i].gamePath);
    assert.equal(fs.readFileSync(path.join(inputs[i].defaultSaveDir, "Save01.rvdata2"), "utf8"), games[i].gameId);
  }
  assert.deepEqual(treeIdentity(f.sourceApp), nativeBefore); assert.deepEqual(treeIdentity(path.join(f.root, "originals")), originals);
  assert.ok(!treeIdentity(path.join(f.userDataDir, "games")).some(([name]) => name.includes(".app/") || name.endsWith(".dylib")));
});

test("two overlapping games use one shared executable and independent tiny configs without modifying source/originals", { timeout: 10000 }, async t => {
  const f = fixture(t), before = treeIdentity(f.sourceApp), leases = [], launches = [];
  t.mock.method(Manager.core, "resolveBundledRuntime", () => f.source);
  t.mock.method(Manager.core, "installBundledRuntime", () => { throw new Error("Included Play must not create a global copy"); });
  const games = [entry(f, "game-a"), entry(f, "game-b")], original = treeIdentity(path.join(f.root, "originals"));
  let release; const barrier = new Promise(resolve => { release = resolve; });
  await Promise.all(games.map(game => Launcher.launchRuntime({ ...options(f, game, async (command, args, opts) => {
    launches.push({ command, args, opts });
    if (launches.length === 2) release(); await barrier;
    const config = JSON.parse(fs.readFileSync(path.join(opts.cwd, "mkxp.json")));
    assert.equal(config.gameFolder, game.gamePath); assert.equal(config.windowTitle, game.name);
    assert.equal(command, fs.realpathSync(f.native));
    assert.equal(opts.env.MACLAUNCHER_MKXPZ_CONFIG_TARGET, opts.cwd);
    assert.equal(opts.env.MACLAUNCHER_MKXPZ_CONFIG_SOURCE, fs.realpathSync(path.dirname(f.sourceConfig)));
    assert.equal(opts.env.DYLD_INSERT_LIBRARIES, f.helper.dylibPath);
    return new EventEmitter();
  }), useRuntime: async value => leases.push(value) })));
  assert.notEqual(launches[0].opts.cwd, launches[1].opts.cwd);
  assert.equal(new Set(launches.map(launch => launch.command)).size, 1);
  assert.equal(leases.filter(value => value.sourcePath === f.sourceApp).length, 2);
  assert.equal(new Set(leases.filter(value => value.sourcePath.includes("/assets/generations/")).map(value => value.sourcePath)).size, 1);
  assert.deepEqual(treeIdentity(f.sourceApp), before); assert.deepEqual(treeIdentity(path.join(f.root, "originals")), original);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "runtimes", "mkxpz")), false);
  const privateFiles = treeIdentity(path.join(f.userDataDir, "games"));
  assert.ok(!privateFiles.some(([name]) => name.includes(".app/") || name.endsWith(".dylib")));
  const snapshots = privateFiles.filter(([name]) => name.endsWith("launch.json"));
  assert.equal(snapshots.length, 2);
  for (const [name] of snapshots) assert.equal(JSON.parse(fs.readFileSync(path.join(f.userDataDir, "games", name))).runtime.runtimeCopied, false);
});

test("each same-game launch gets a new config while sharing source and helper identity", t => {
  const f = fixture(t), first = f.prepare("game-a"), second = f.prepare("game-a"), before = treeIdentity(f.sourceApp);
  GameRuntime.writeGameConfig(first, { windowTitle: "A" }); GameRuntime.writeGameConfig(second, { windowTitle: "B" });
  assert.notEqual(first.configDir, second.configDir); assert.equal(first.sourceIdentity, second.sourceIdentity);
  assert.equal(first.executablePath, second.executablePath); assert.equal(first.executablePath, fs.realpathSync(f.native));
  assert.deepEqual(JSON.parse(fs.readFileSync(first.configPath)), { windowTitle: "A" });
  assert.deepEqual(JSON.parse(fs.readFileSync(second.configPath)), { windowTitle: "B" });
  assert.deepEqual(treeIdentity(f.sourceApp), before);
  assert.throws(() => GameRuntime.writeGameConfig(first, {}), /EEXIST/);
});

test("explicit managed versions and owned same-version sources retain their exact bytes and precedence", async t => {
  const f = fixture(t), includedBefore = treeIdentity(f.sourceApp);
  t.mock.method(Manager.core, "resolveBundledRuntime", () => { throw new Error("An exact owned registration must retain priority"); });
  for (const version of ["selected-actions-version", f.source.version]) {
    const ownedRoot = path.join(f.userDataDir, "runtimes", "mkxpz", version), owned = path.join(ownedRoot, "Z-universal.app");
    fs.cpSync(f.sourceApp, owned, { recursive: true });
    const native = path.join(owned, "Contents", "MacOS", "Z-universal");
    fs.writeFileSync(native, executable("owned-" + version));
    fs.writeFileSync(path.join(ownedRoot, ".maclauncher-mkxpz.json"), JSON.stringify({ version, source: "GitHub" }));
    const before = treeIdentity(owned), leases = [], game = entry(f, "game-" + version, version);
    await Launcher.launchRuntime({ ...options(f, game, async command => {
      assert.equal(command, fs.realpathSync(native)); return new EventEmitter();
    }), useRuntime: async value => leases.push(value) });
    assert.equal(leases[0].sourcePath, owned); assert.equal(leases[0].version, version); assert.deepEqual(treeIdentity(owned), before);
  }
  assert.deepEqual(treeIdentity(f.sourceApp), includedBefore);
});

test("damaged selected installations fail instead of falling back to the same-version Included app", async t => {
  const f = fixture(t), ownedRoot = path.join(f.userDataDir, "runtimes", "mkxpz", f.source.version);
  fs.mkdirSync(ownedRoot, { recursive: true });
  t.mock.method(Manager.core, "resolveBundledRuntime", () => { throw new Error("Damaged owned registration must not fall back"); });
  const opts = options(f, entry(f), () => { throw new Error("Damaged runtime must not spawn"); });
  await assert.rejects(Launcher.launchRuntime(opts), /missing its app bundle/);
  fs.cpSync(f.sourceApp, path.join(ownedRoot, "Z-universal.app"), { recursive: true });
  const record = path.join(ownedRoot, ".maclauncher-mkxpz.json");
  fs.writeFileSync(record, "{broken"); await assert.rejects(Launcher.launchRuntime(opts), /record is damaged/);
  fs.writeFileSync(record, JSON.stringify({ version: "another-version" })); await assert.rejects(Launcher.launchRuntime(opts), /another version/);
  fs.unlinkSync(record); fs.unlinkSync(path.join(ownedRoot, "Z-universal.app", "Contents", "MacOS", "Z-universal"));
  await assert.rejects(Launcher.launchRuntime(opts), /executable is missing/);
});

test("changed source or helper identities remain explicit while earlier session configs stay intact", t => {
  const f = fixture(t), first = f.prepare("game-a"); GameRuntime.writeGameConfig(first, { windowTitle: "Retained" });
  fs.writeFileSync(f.native, executable("changed-owned-native"));
  const changed = f.prepare("game-a"); assert.notEqual(changed.sourceIdentity, first.sourceIdentity);
  assert.equal(changed.executablePath, first.executablePath); assert.deepEqual(JSON.parse(fs.readFileSync(first.configPath)), { windowTitle: "Retained" });
  const helperChange = GameRuntime.prepareGameRuntime({ userDataDir: f.userDataDir, gameId: "game-a", source: f.source, helper: { ...f.helper, version: "fixture-helper-v2", binarySha256: "d".repeat(64) } });
  assert.notEqual(helperChange.sourceIdentity, changed.sourceIdentity);
});

test("managed apps without Contents/Game keep that layout and use the private initial cwd", async t => {
  const f = fixture(t); fs.rmSync(path.join(f.sourceApp, "Contents", "Game"), { recursive: true });
  const before = treeIdentity(f.sourceApp); t.mock.method(Manager.core, "resolveBundledRuntime", () => f.source);
  await Launcher.launchRuntime(options(f, entry(f), async (_command, _args, opts) => {
    assert.ok(fs.existsSync(path.join(opts.cwd, "mkxp.json"))); assert.equal(opts.env.MACLAUNCHER_MKXPZ_CONFIG_SOURCE, path.join(fs.realpathSync(f.sourceApp), "Contents", "Game"));
    return new EventEmitter();
  }));
  assert.deepEqual(treeIdentity(f.sourceApp), before); assert.equal(fs.existsSync(path.join(f.sourceApp, "Contents", "Game")), false);
});

test("source aliases resolve to the exact canonical executable and config source", t => {
  const f = fixture(t), alias = path.join(f.root, "publisher-alias"); fs.symlinkSync(path.dirname(f.sourceApp), alias);
  const prepared = GameRuntime.prepareGameRuntime({ userDataDir: f.userDataDir, gameId: "game-a", source: { ...f.source, appPath: path.join(alias, "Z-universal.app") }, helper: f.helper });
  assert.equal(prepared.executablePath, fs.realpathSync(f.native)); assert.equal(prepared.sourceAppPath, fs.realpathSync(f.sourceApp));
  assert.equal(prepared.sourceConfigDir, fs.realpathSync(path.dirname(f.sourceConfig)));
});

test("private ownership checks reject directory/config symlinks and preserve publisher config bytes", t => {
  const f = fixture(t); assert.throws(() => f.prepare("../outside"), /game id/);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.mkdirSync(f.userDataDir); fs.symlinkSync(outside, path.join(f.userDataDir, "games"));
  assert.throws(() => f.prepare("game-a"), /symlink/); assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(f.userDataDir, "games")); const prepared = f.prepare("game-a"), before = fs.readFileSync(f.sourceConfig);
  fs.symlinkSync(f.sourceConfig, prepared.configPath);
  assert.throws(() => GameRuntime.writeGameConfig(prepared, {}), /EEXIST/); assert.deepEqual(fs.readFileSync(f.sourceConfig), before);
});

test("signing policy rejects blocked injections and permits explicitly entitled compatible builds", () => {
  assert.equal(ConfigHelper.validateInjectionSignature("flags=0x2(adhoc)").injectionCompatible, true);
  assert.throws(() => ConfigHelper.validateInjectionSignature("flags=0x10000(runtime)"), /blocks the shared config helper/);
  assert.throws(() => ConfigHelper.validateInjectionSignature("flags=0x2000(require-lv)"), /blocks/);
  assert.throws(() => ConfigHelper.validateInjectionSignature("flags=0x800(restrict)"), /blocks/);
  const entitlements = '<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/>';
  assert.equal(ConfigHelper.validateInjectionSignature("flags=0x10000(runtime)" + entitlements).injectionCompatible, true);
});

test("an incompatible selected signing policy fails before native spawn without source substitution", async t => {
  const f = fixture(t), before = treeIdentity(f.sourceApp);
  t.mock.method(Manager.core, "resolveBundledRuntime", () => f.source);
  t.mock.method(ConfigHelper, "assertInjectionCompatible", async () => ConfigHelper.validateInjectionSignature("flags=0x10000(runtime)"));
  await assert.rejects(Launcher.launchRuntime(options(f, entry(f), () => { throw new Error("A blocked signing policy must never spawn"); })), /blocks the shared config helper/);
  assert.deepEqual(treeIdentity(f.sourceApp), before);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "runtimes", "mkxpz")), false);
});

test("the helper CPU must cover the exact selected native build", t => {
  const f = fixture(t);
  assert.throws(() => GameRuntime.prepareGameRuntime({ userDataDir: f.userDataDir, gameId: "game-a", source: f.source,
    helper: { ...f.helper, architectures: ["x86_64"] } }), /config helper CPU/);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "games")), false);
});

test("child environment replaces stale own mappings while retaining independent explicit DYLD helpers", () => {
  const environment = { DYLD_INSERT_LIBRARIES: "/old/mkxpz-config-helper/v0/mkxpz-config.dylib:/other/explicit.dylib", MACLAUNCHER_MKXP_CONFIG_SOURCE: "old", MACLAUNCHER_MKXPZ_CONFIG_EXECUTABLE: "old", OTHER: "kept" };
  const before = { ...environment }, prepared = { executablePath: "/chosen/MacOS/run", sourceConfigDir: "/chosen/Game", configDir: "/owned/private" }, helper = { dylibPath: "/shared/mkxpz-config.dylib" };
  const env = ConfigHelper.launchEnvironment({ prepared, helper, environment });
  assert.equal(env.DYLD_INSERT_LIBRARIES, "/shared/mkxpz-config.dylib:/other/explicit.dylib");
  assert.equal(env.MACLAUNCHER_MKXPZ_CONFIG_EXECUTABLE, prepared.executablePath); assert.equal(env.MACLAUNCHER_MKXPZ_CONFIG_SOURCE, prepared.sourceConfigDir);
  assert.equal(env.MACLAUNCHER_MKXP_CONFIG_SOURCE, undefined); assert.equal(env.OTHER, "kept"); assert.deepEqual(environment, before);
});
