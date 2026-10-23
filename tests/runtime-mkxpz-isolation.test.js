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
  const source = { version: "fixture-v1", appPath: sourceApp, source: "MacLauncher Builds" };
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

test("warm shared-native identity avoids repeated reads and rejects changed bytes with restored mtime", t => {
  const f = fixture(t), originalHash = require("../src/modules/shared/runtime/local-native").hashFile;
  const Native = require("../src/modules/shared/runtime/local-native");
  const original = fs.readFileSync(f.native), stat = fs.statSync(f.native);
  f.source.bundle = { manifest: { files: [{ path: "Z-universal.app/Contents/MacOS/Z-universal", size: stat.size,
    mode: stat.mode & 0o777, sha256: originalHash(f.native) }] } };
  let nativeReads = 0;
  const canonicalNative = fs.realpathSync(f.native);
  t.mock.method(Native, "hashFile", file => { if (file === canonicalNative) nativeReads++; return originalHash(file); });
  const first = f.prepare("cache-first"), second = f.prepare("cache-second");
  assert.equal(first.binarySha256, second.binarySha256);
  assert.equal(nativeReads, 1, "unchanged native bytes should only be read on the first preparation");
  const modified = Buffer.from(original); modified[modified.length - 1] ^= 1;
  fs.writeFileSync(f.native, modified); fs.utimesSync(f.native, stat.atime, stat.mtime);
  assert.throws(() => f.prepare("cache-changed"), /native bytes changed/);
  assert.equal(nativeReads, 2, "a changed source identity must be re-read before rejecting it");
});

test("Ruby CPU library lookup includes versioned Darwin siblings and invalidates on sibling changes", t => {
  const f = fixture(t), parent = fs.realpathSync(path.dirname(f.sourceApp)), library = path.join(parent, "stdlib");
  fs.rmSync(path.join(f.sourceApp, "Contents", "Game"), { recursive: true });
  fs.writeFileSync(path.join(parent, "mkxp.json"), "{}");
  const current = path.join(library, "arm64-darwin27");
  fs.mkdirSync(current, { recursive: true }); fs.writeFileSync(path.join(current, "rbconfig.rb"), "# real CPU-specific Ruby configuration");
  fs.mkdirSync(path.join(library, "x86_64-darwin27"));
  assert.deepEqual(f.prepare("ruby-current").runtimeRubyLoadpaths, [library, current]);
  const legacy = path.join(library, "arm64-darwin"); fs.mkdirSync(legacy);
  assert.deepEqual(f.prepare("ruby-sibling-added").runtimeRubyLoadpaths, [library, legacy, current]);
  fs.rmSync(current, { recursive: true });
  assert.deepEqual(f.prepare("ruby-sibling-removed").runtimeRubyLoadpaths, [library, legacy]);
  const outside = path.join(f.root, "outside-ruby"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, current);
  assert.throws(() => f.prepare("ruby-symlink"), /runtime libraries must remain inside/);
});

test("two immutable-container games keep independent portable views with the same unchanged MKXP-Z executable", async t => {
  const f = fixture(t), nativeBefore = treeIdentity(f.sourceApp), launches = [];
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
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
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
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

test("damaged exact installations stop before spawn and preserve all original data", async t => {
  const f = fixture(t), game = entry(f), before = treeIdentity(f.sourceApp);
  fs.writeFileSync(path.join(game.contentRootDir, "Save01.rvdata2"), "existing save");
  const saves = treeIdentity(game.contentRootDir);
  const opts = options(f, game, () => assert.fail("A damaged runtime must not spawn"));
  const failure = new Error("selected payload checksum mismatch");
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => { throw failure; });
  await assert.rejects(Launcher.launchRuntime(opts), error => error === failure);
  assert.deepEqual(treeIdentity(f.sourceApp), before);
  assert.deepEqual(treeIdentity(game.contentRootDir), saves);
  const aborted = new Error("cancelled"); aborted.name = "AbortError";
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => { throw aborted; });
  await assert.rejects(Launcher.launchRuntime(opts), error => error === aborted);
});

test("same-version recovery does not retry an actual game spawn failure", async t => {
  const f = fixture(t), ownedRoot = path.join(f.userDataDir, "runtimes", "mkxpz", f.source.version);
  fs.mkdirSync(ownedRoot, { recursive: true });
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
  const failure = new Error("real launch failure"); let spawns = 0;
  await assert.rejects(Launcher.launchRuntime(options(f, entry(f), () => { spawns++; throw failure; })), error => error === failure);
  assert.equal(spawns, 1);
});

test("optional native application failure preserves original launch and cancellation remains visible", async t => {
  const f = fixture(t), Application = require("../src/modules/shared/native-application");
  const info = path.join(f.sourceApp, "Contents", "Info.plist");
  fs.writeFileSync(info, fs.readFileSync(info, "utf8").replace("</dict>", "<key>CFBundleIdentifier</key><string>org.mkxpz.fixture</string></dict>"));
  const before = treeIdentity(f.sourceApp), game = entry(f), failures = [], attempts = [];
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
  t.mock.method(Application, "prepare", async input => { attempts.push(input); throw new Error("Native identity unavailable"); });
  let spawns = 0;
  const opts = options(f, game, (command, _args, opts) => {
    spawns++; assert.equal(command, fs.realpathSync(f.native));
    assert.equal(opts.env.MACLAUNCHER_MKXPZ_CONFIG_SOURCE, fs.realpathSync(path.dirname(f.sourceConfig)));
    assert.ok(fs.existsSync(path.join(opts.cwd, "mkxp.json"))); return new EventEmitter();
  });
  for (const warn of [() => { throw new Error("sync sink"); }, () => Promise.reject(new Error("async sink"))]) {
    await Launcher.launchRuntime({ ...opts, logger: { warn(...args) { if (/Game application identity/.test(args[0])) { failures.push(args); return warn(); } } } });
  }
  assert.equal(spawns, 2); assert.equal(failures.length, 2); assert.equal(attempts.length, 2);
  assert.equal(attempts[0].identifier, "org.mkxpz.fixture"); assert.equal(attempts[0].cloneOnly, true);
  assert.deepEqual(treeIdentity(f.sourceApp), before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Launcher.launchRuntime({ ...opts, signal: controller.signal }), { name: "AbortError" });
  assert.equal(spawns, 2, "Cancellation cannot become a fallback launch");
});

test("native application caches retire only unchanged inactive generations after actual process retirement", async t => {
  const f = fixture(t), Application = require("../src/modules/shared/native-application");
  const plist = path.join(f.sourceApp, "Contents/Info.plist");
  fs.writeFileSync(plist, fs.readFileSync(plist, "utf8").replace("</dict>", "<key>CFBundleIdentifier</key><string>org.mkxp.cache</string></dict>"));
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
  t.mock.method(Application, "prepare", async input => {
    const app = path.join(input.directory, Application.bundleName(input.title)), executablePath = path.join(app, "Contents/MacOS", path.basename(input.executablePath));
    fs.mkdirSync(path.dirname(executablePath), { recursive: true }); fs.copyFileSync(input.executablePath, executablePath);
    fs.writeFileSync(path.join(input.directory, "application.json"), JSON.stringify({ basis: { cloneOnly: true, title: input.title } }));
    return { app, executablePath };
  });
  const game = entry(f, "retirement-game"), children = [], apps = [], attempted = [];
  let active;
  const withRuntimeMutation = async (identity, fn) => { attempted.push(identity.sourcePath); if (identity.sourcePath === active) throw Error("Runtime is in use"); return fn(); };
  for (let index = 0; index < 5; index++) {
    game.name = "Generated " + index;
    await Launcher.launchRuntime({ ...options(f, game, async command => {
      const child = new EventEmitter(); children.push(child); apps.push(path.dirname(path.dirname(path.dirname(command)))); return child;
    }), withRuntimeMutation });
    const file = path.join(path.dirname(apps[index]), "application.json"), receipt = JSON.parse(fs.readFileSync(file));
    receipt.retirement.createdAt = index + 1; fs.writeFileSync(file, JSON.stringify(receipt));
  }
  const parent = path.dirname(path.dirname(apps[0])); active = path.dirname(apps[2]);
  fs.writeFileSync(path.join(apps[1], "Contents/Game/portable-save"), "preserved");
  fs.mkdirSync(path.join(parent, "unknown"));
  assert.equal(attempted.length, 0, "Play does not scan or prune old identities");
  let release; children[4].runtimeRetirement = new Promise(resolve => { release = resolve; });
  children[4].emit("close", 0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempted.length, 0, "An exited root does not bypass pending owned teardown");
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(apps[0]), false);
  for (const index of [1, 2, 3, 4]) assert.equal(fs.existsSync(apps[index]), true, "Modified, active, fallback and current entries survive");
  assert.equal(fs.readFileSync(path.join(apps[1], "Contents/Game/portable-save"), "utf8"), "preserved");
  assert.equal(fs.existsSync(path.join(parent, "unknown")), true);
  assert.equal(attempted.includes(path.dirname(apps[3])), false, "The most recent inactive fallback is retained");
  children[4].emit("close", 0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempted.length, 3, "Retirement is bound once to this exact child");
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
  const before = treeIdentity(f.sourceApp); t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
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

test("publisher parent layouts retain shared Ruby resources and independent private configs", t => {
  const f = fixture(t), publisher = fs.realpathSync(path.dirname(f.sourceApp));
  fs.rmSync(path.join(f.sourceApp, "Contents", "Game"), { recursive: true });
  fs.writeFileSync(path.join(publisher, "mkxp.json"), '{"gameFolder":"publisher-default"}');
  const stdlib = path.join(publisher, "stdlib"), arch = path.join(stdlib, "arm64-darwin");
  fs.mkdirSync(arch, { recursive: true }); fs.writeFileSync(path.join(arch, "rbconfig.rb"), "# original Ruby config");
  const before = treeIdentity(publisher), prepared = f.prepare("new-layout");
  assert.equal(prepared.configLayout, "bundle-parent"); assert.equal(prepared.sourceConfigDir, publisher);
  const config = { gameFolder: path.join(f.root, "game") }; GameRuntime.writeGameConfig(prepared, config);
  assert.deepEqual(config.rubyLoadpath, [config.gameFolder, stdlib, arch]);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.configPath)), config);
  const custom = { rubyLoadpath: ["/explicit/loadpath"] }; GameRuntime.writeGameConfig(f.prepare("custom-paths"), custom);
  assert.deepEqual(custom.rubyLoadpath, ["/explicit/loadpath"]);
  assert.deepEqual(treeIdentity(publisher), before); assert.equal(prepared.runtimeCopied, false);
});

test("publisher root config and Ruby directory aliases are rejected before launch", t => {
  const f = fixture(t), publisher = path.dirname(f.sourceApp);
  fs.rmSync(path.join(f.sourceApp, "Contents", "Game"), { recursive: true });
  const original = path.join(f.root, "other-config"); fs.writeFileSync(original, "{}");
  fs.symlinkSync(original, path.join(publisher, "mkxp.json"));
  assert.throws(() => f.prepare("config-alias"), /regular file/);
  fs.unlinkSync(path.join(publisher, "mkxp.json")); fs.writeFileSync(path.join(publisher, "mkxp.json"), "{}");
  const outside = path.join(f.root, "other-libraries"); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(publisher, "stdlib"));
  assert.throws(() => f.prepare("library-alias"), /inside the selected runtime/);
});

test("existing contained Game aliases keep precedence over a publisher parent config", t => {
  const f = fixture(t), game = path.dirname(f.sourceConfig), retained = path.join(f.sourceApp, "Contents", "RetainedGame");
  fs.renameSync(game, retained); fs.symlinkSync("RetainedGame", game);
  fs.writeFileSync(path.join(path.dirname(f.sourceApp), "mkxp.json"), "{}");
  const prepared = f.prepare("retained-layout");
  assert.equal(prepared.configLayout, "bundle-game"); assert.equal(prepared.sourceConfigDir, fs.realpathSync(retained));
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
  t.mock.method(Manager.core, "resolveOwnedRuntime", () => f.source);
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
  const named = ConfigHelper.launchEnvironment({ prepared, helper, gameName: "  First game 日本語  ", environment });
  assert.equal(named.MACLAUNCHER_MKXPZ_CONFIG_GAME_NAME, "First game 日本語");
  assert.equal(named.SDL_APP_NAME, "First game 日本語");
  const second = ConfigHelper.launchEnvironment({ prepared, helper, gameName: "Second game", environment: named });
  assert.equal(second.MACLAUNCHER_MKXPZ_CONFIG_GAME_NAME, "Second game");
  assert.equal(named.MACLAUNCHER_MKXPZ_CONFIG_GAME_NAME, "First game 日本語");
  const invalid = ConfigHelper.launchEnvironment({ prepared, helper, gameName: "invalid\0name", environment: named });
  assert.equal(invalid.MACLAUNCHER_MKXPZ_CONFIG_GAME_NAME, undefined);
  assert.deepEqual(environment, before);
});

test("optional game-icon transport requires a canonical regular image-sized file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkxpz-game-icon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const icon = path.join(root, "icon.png"), alias = path.join(root, "alias.png"), oversized = path.join(root, "large.png");
  fs.writeFileSync(icon, "small icon input"); fs.symlinkSync(icon, alias);
  fs.writeFileSync(oversized, ""); fs.truncateSync(oversized, 8 * 1024 * 1024 + 1);
  const options = { prepared: { executablePath: "/selected/run", sourceConfigDir: "/selected/Game", configDir: "/owned/config" },
    helper: { dylibPath: "/shared/mkxpz-config.dylib" }, environment: {} };
  assert.equal(ConfigHelper.launchEnvironment({ ...options, gameIcon: alias }).MACLAUNCHER_MKXPZ_CONFIG_GAME_ICON, fs.realpathSync(icon));
  for (const gameIcon of [root, oversized, path.join(root, "missing.png")])
    assert.equal(ConfigHelper.launchEnvironment({ ...options, gameIcon }).MACLAUNCHER_MKXPZ_CONFIG_GAME_ICON, undefined);
});
