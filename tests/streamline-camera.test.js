const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Streamline = require("../src/modules/crossover/temporal/streamline"), PE = require("../src/modules/crossover/temporal/streamline/pe-exports");
const names = ["slEvaluateFeature", "slSetConstants", "slShutdown"];
function pe(exports = names, marker = 1) {
  const bytes = Buffer.alloc(4096), offset = 0x80, optional = offset + 24, section = optional + 240;
  bytes.writeUInt16LE(0x5a4d);bytes.writeUInt32LE(offset, 60);bytes.writeUInt32LE(0x4550, offset);bytes.writeUInt16LE(0x8664, offset + 4);bytes.writeUInt16LE(1, offset + 6);bytes.writeUInt16LE(240, offset + 20);
  bytes.writeUInt16LE(0x20b, optional);bytes.writeUInt32LE(16, optional + 108);bytes.writeUInt32LE(0x1000, optional + 112);bytes.writeUInt32LE(0x400, optional + 116);
  bytes.writeUInt32LE(0x1000, section + 12);bytes.writeUInt32LE(3584, section + 16);bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(1, 0x210);bytes.writeUInt32LE(exports.length, 0x214);bytes.writeUInt32LE(exports.length, 0x218);
  bytes.writeUInt32LE(0x1050, 0x21c);bytes.writeUInt32LE(0x1090, 0x220);bytes.writeUInt32LE(0x10d0, 0x224);
  let cursor = 0x300;
  exports.forEach((name, i) => { bytes.writeUInt32LE(0x1800 + i, 0x250 + 4 * i);bytes.writeUInt32LE(cursor + 0xe00, 0x290 + 4 * i);bytes.writeUInt16LE(i, 0x2d0 + 2 * i);bytes.write(name, cursor);cursor += name.length + 1; });
  bytes[4095] = marker;return bytes;
}
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "streamline-camera-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "supplied.dll"), providerRoot = path.join(root, "provider"), gameRoot = path.join(root, "game"), relativePath = "plugins/sl.interposer.dll";
  fs.mkdirSync(providerRoot);fs.mkdirSync(path.join(gameRoot, "plugins"), { recursive: true });
  fs.writeFileSync(sourcePath, pe());const target = path.join(gameRoot, relativePath);fs.symlinkSync(sourcePath, target);
  function provider(marker = 2) { const file = path.join(providerRoot, "sl.interposer.dll");fs.writeFileSync(file, pe(names, marker));fs.writeFileSync(path.join(providerRoot, "provider.json"), JSON.stringify({ schema: 1, library: "sl.interposer.dll", sha256: sha(fs.readFileSync(file)), exports: PE.inspect(file) })); }
  provider();return { root, sourcePath, providerRoot, gameRoot, relativePath, target, provider };
}
test("Streamline adapter replaces only the private leaf, keeps original DLL beside it, and restores without editing the source", t => {
  const f = fixture(t), before = fs.readFileSync(f.sourcePath), result = Streamline.prepare(f);
  assert.equal(result.available, true);assert.equal(result.cameraProjection, true);assert.deepEqual(result.methods, ["fsr2", "fsr3"]);
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(), false);assert.deepEqual(fs.readFileSync(f.sourcePath), before);
  const backup = path.join(path.dirname(f.target), Streamline.ORIGINAL);assert.deepEqual(fs.readFileSync(backup), before);
  const time = fs.statSync(f.target).mtimeMs;assert.equal(Streamline.prepare(f).prepared, true);assert.equal(fs.statSync(f.target).mtimeMs, time);
  assert.equal(Streamline.restore(f), true);assert.deepEqual(fs.readFileSync(f.target), before);assert.equal(fs.existsSync(backup), false);assert.equal(Streamline.restore(f), false);
});
test("adapter upgrades and staged game updates preserve the correct supplied original", t => {
  const f = fixture(t);Streamline.prepare(f);f.provider(3);assert.equal(Streamline.prepare(f).available, true);assert.equal(fs.readFileSync(f.target)[4095], 3);
  fs.writeFileSync(f.sourcePath, pe(names, 4));fs.copyFileSync(f.sourcePath, f.target);
  assert.equal(Streamline.prepare(f).available, true);assert.equal(Streamline.restore(f), true);assert.equal(fs.readFileSync(f.target)[4095], 4);assert.equal(fs.readFileSync(f.sourcePath)[4095], 4);
});
test("unknown or malformed Streamline interfaces leave the private game unchanged", t => {
  const f = fixture(t);fs.writeFileSync(f.sourcePath, pe([...names, "slFutureAPI"]));const bytes = fs.readFileSync(f.sourcePath);
  assert.equal(Streamline.prepare(f).available, false);assert.equal(fs.lstatSync(f.target).isSymbolicLink(), true);assert.deepEqual(fs.readFileSync(f.sourcePath), bytes);
  for (const mutate of [b => b.writeUInt16LE(0x14c, 0x84), b => b.writeUInt32LE(0xffffffff, 0x21c), b => b.writeUInt32LE(0x1000, 0x250), b => b.writeUInt32LE(2, 0x218)]) {
    const data = pe();mutate(data);fs.writeFileSync(f.sourcePath, data);assert.equal(PE.inspect(f.sourcePath), null);
  }
});
test("private DLL changes, backup collisions, and directory symlinks are never overwritten", t => {
  const f = fixture(t);Streamline.prepare(f);fs.writeFileSync(f.target, "another mod");assert.equal(Streamline.prepare(f).available, false);assert.throws(() => Streamline.restore(f), /changed/);assert.equal(fs.readFileSync(f.target, "utf8"), "another mod");
  fs.rmSync(path.join(f.gameRoot, "plugins"), { recursive: true });fs.mkdirSync(path.join(f.root, "outside"));fs.symlinkSync(path.join(f.root, "outside"), path.join(f.gameRoot, "plugins"));
  assert.equal(Streamline.prepare(f).available, false);assert.deepEqual(fs.readdirSync(path.join(f.root, "outside")), []);
});
test("corrupt payloads and interrupted preparations do not install a partial adapter", t => {
  const f = fixture(t);fs.appendFileSync(path.join(f.providerRoot, "sl.interposer.dll"), "changed");assert.equal(Streamline.prepare(f).available, false);assert.equal(fs.lstatSync(f.target).isSymbolicLink(), true);
  f.provider();let checks = 0;assert.throws(() => Streamline.prepare({ ...f, signal: { throwIfAborted() { if (++checks === 2) throw Error("cancelled"); } } }), /cancelled/);
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(), true);assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["sl.interposer.dll"]);
});
test("camera rollback attempts every owned DLL and blocks fallback only when restoration remains unsafe", async t => {
  const f = fixture(t), Temporal = require("../src/modules/crossover/temporal"), originalRestore = Streamline.restore;
  const relatives = ["sl.interposer.dll", "plugins/sl.interposer.dll", "Streamline/sl.interposer.dll"];
  for (const relative of relatives) {const file = path.join(f.gameRoot, relative);fs.mkdirSync(path.dirname(file), {recursive: true});if (!fs.existsSync(file)) fs.writeFileSync(file, pe());}
  const plan = {providerRoot: f.providerRoot, libraries: relatives.map(relativePath => ({sourcePath: f.sourcePath, relativePath}))};
  const copyFailure = new Error("copy failed"), restoreFailure = new Error("restore permission denied"), calls = [];let preparationFailure = copyFailure;
  const originalPrepare = Streamline.prepare;
  t.mock.method(Streamline, "prepare", options => {const result = originalPrepare(options);if (options.relativePath === relatives[2]) throw preparationFailure;return result;});
  t.mock.method(Streamline, "restore", options => {calls.push(options.relativePath);if (options.relativePath === relatives[0]) throw restoreFailure;return originalRestore(options);});
  assert.throws(() => Temporal.prepareGame(plan, f.gameRoot), error => error.code === "STREAMLINE_RESTORE_FAILED" && error.cause === copyFailure && error.errors[0] === restoreFailure);
  assert.deepEqual(calls, relatives);assert.equal(fs.readFileSync(path.join(f.gameRoot, relatives[0]))[4095], 2, "an unrestored owned proxy remains visible to recovery");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, relatives[1]))[4095], 1, "later DLL restoration runs after the earlier failure");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, relatives[2]))[4095], 1, "the DLL whose preparation failed after replacement is restored too");
  const cancelled = Object.assign(new Error("cancelled"), {code: "ABORT_ERR"});preparationFailure = cancelled;calls.length = 0;
  assert.throws(() => Temporal.prepareGame(plan, f.gameRoot), error => error.code === "STREAMLINE_RESTORE_FAILED" && error.name === "AbortError" && error.cause === cancelled);
  assert.deepEqual(calls, relatives);
  const exe = path.join(f.gameRoot, "game.exe"), bytes = pe();bytes.writeUInt16LE(2, 0x96);fs.writeFileSync(exe, bytes);
  const entry = {runtimeData: {crossover: {sourceRoot: f.gameRoot, windowsExecutablePath: exe, executableArchitecture: "x86_64", detectionComplete: true}}};
  calls.length = 0;assert.throws(() => Temporal.restoreGame(entry, {logger: {warn: () => {throw Error("logger failed");}}}, f.gameRoot), {code: "STREAMLINE_RESTORE_FAILED"});assert.deepEqual(calls, relatives);
  Streamline.restore.mock.mockImplementation(originalRestore);
  fs.writeFileSync(path.join(f.gameRoot, relatives[0]), "separately modified DLL");fs.writeFileSync(path.join(f.gameRoot, Streamline.ORIGINAL), "changed backup");
  for (const warn of [() => {throw Error("logger failed");}, () => Promise.reject(Error("logger rejected"))]) assert.doesNotThrow(() => Temporal.restoreGame(entry, {logger: {warn}}, f.gameRoot));
  assert.equal(fs.readFileSync(path.join(f.gameRoot, relatives[0]), "utf8"), "separately modified DLL", "a changed mod is never replaced by an owned backup");
  assert.deepEqual(fs.readFileSync(f.sourcePath), pe());await new Promise(setImmediate);
});
test("camera capability requires matched DXMT, a supported Streamline interface, x64, and the selected renderer", t => {
  const f = fixture(t), Temporal = require("../src/modules/crossover/temporal"), graphicsRoot = path.join(f.root, "graphics");
  const support = path.join(f.root, "support"), engine = path.join(f.root, "engine"), base = path.join(support, "Frameworks/renderer/dxmt/wine");
  function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes); }
  fs.cpSync(f.providerRoot, path.join(graphicsRoot, "temporal/streamline"), { recursive: true });
  const dllRoot = path.join(graphicsRoot, "temporal/dxmt"), files = {};
  for (const name of Temporal.FILES) { put(path.join(dllRoot, name), name);files[name] = sha(name); }
  put(path.join(base, "x86_64-unix/winemetal.so"), "native base");put(path.join(base, "x86_64-windows/winemetal.dll"), "thunk base");
  put(path.join(engine, "lib/wine/x86_64-unix/ntdll.so"), "engine");
  put(path.join(dllRoot, "camera-bridge.json"), JSON.stringify({ schema: 1, id: "dxmt-camera1", architecture: "x86_64", tableCount: 146, minimumMacOS: "14.0.0", files,
    base: { nativeSha256: sha("native base"), thunkSha256: sha("thunk base") } }));
  const exe = path.join(f.gameRoot, "game.exe"), bytes = pe();bytes.writeUInt16LE(2, 0x96);bytes.writeUInt16LE(3, 0x98 + 68);put(exe, bytes);
  const entry = { gamePath: f.gameRoot, runtimeData: { crossover: { sourceRoot: f.gameRoot, windowsExecutablePath: exe, executableArchitecture: "x86_64", detectionComplete: true } } };
  // Keep the interposer inside the imported game rather than an external alias.
  fs.unlinkSync(f.target);fs.writeFileSync(f.target, pe());
  const options = { install: { templateRoot: support, engineRoot: engine }, runtimeId: "sikarugir", root: graphicsRoot, host: { platform: "darwin", arch: "arm64", macOSVersion: "26.0" } };
  const plan = Temporal.resolvePlan(entry, {}, options);assert.deepEqual(plan.inputs, { cameraProjection: true, source: "streamline", methods: ["fsr2", "fsr3"] });
  assert.equal(plan.libraries[0].relativePath, "plugins/sl.interposer.dll");
  for (const settings of [{ graphicsBackend: "wined3d" }, { graphicsBackend: "d3dmetal" }, { graphicsBackend: "dxvk" }]) assert.equal(Temporal.resolvePlan(entry, {}, { ...options, settings }), null);
  assert.equal(Temporal.resolvePlan(entry, {}, { ...options, host: { ...options.host, macOSVersion: "13.6" } }), null);
  fs.writeFileSync(f.target, pe([...names, "slFutureAPI"]));assert.equal(Temporal.resolvePlan(entry, {}, options), null);fs.writeFileSync(f.target, pe());
  fs.writeFileSync(path.join(base, "x86_64-unix/winemetal.so"), "different renderer");assert.equal(Temporal.resolvePlan(entry, {}, options), null);
  put(path.join(base, "x86_64-unix/winemetal.so"), "native base");fs.unlinkSync(f.target);assert.equal(Temporal.resolvePlan(entry, {}, options), null);
  fs.writeFileSync(f.target, pe());
  const Support = require("../src/modules/crossover/temporal/support-manager"), vendor = path.join(f.root, "CrossOver");
  put(path.join(vendor, "lib/wine/x86_64-unix/wine"), "vendor loader");
  const manifestPath = path.join(dllRoot, "camera-bridge.json"), manifest = JSON.parse(fs.readFileSync(manifestPath));manifest.base = Support.BASE;fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const context = { userDataDir: path.join(f.root, "profile"), runtimeId: "crossover", runtimeSettings: { graphicsBackend: "dxmt" } };
  const crossover = { ...options, install: { crossoverRoot: vendor }, runtimeId: "crossover", settings: context.runtimeSettings };
  assert.equal(Temporal.resolvePlan(entry, context, crossover), null);
  assert.equal(Temporal.resolvePlan(entry, context, { ...crossover, allowDownload: true }).inputs.requiresDownload, true);
  const dependency = { root: graphicsRoot, manager: { resolveSelection: () => ({ ready: true, install: crossover.install }) } };
  entry.graphics = { temporalMethod: "off" };assert.deepEqual(Temporal.requirements(entry, context, dependency), []);
  entry.graphics = { temporalMethod: "fsr2" };assert.equal(Temporal.requirements(entry, context, dependency)[0]?.managerId, "crossover-graphics-bridge");
  const sikarugirContext = { ...context, runtimeId: "sikarugir", runtimeSettings: { graphicsBackend: "auto" } };
  assert.equal(Temporal.resolvePlan(entry, sikarugirContext, { ...options, allowDownload: true }).download.managerId, "sikarugir-graphics-bridge");
  assert.equal(Temporal.requirements(entry, sikarugirContext, { ...dependency, manager: { resolveSelection: () => ({ ready: true, install: options.install }) } })[0]?.managerId, "sikarugir-graphics-bridge");
  assert.equal(Temporal.resolvePlan(entry, context, { ...crossover, allowDownload: true, settings: { ...context.runtimeSettings, graphicsBridgeVersion: "missing-version" } }), null);
  assert.equal(Temporal.resolvePlan(entry, context, { ...crossover, allowDownload: true, settings: { ...context.runtimeSettings, dllOverrides: ["dxgi=n"] } }), null);
  fs.writeFileSync(f.target, pe([...names, "slFutureAPI"]));assert.deepEqual(Temporal.requirements(entry, context, dependency), []);
});
test("graphics bridge catalogs preserve separate engine defaults, per-game versions, and shared generated options", t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), Catalog = require("../src/modules/crossover/temporal/catalog");
  const extra = { ...Support.PIN, version: "1.0.22", versionLabel: "Future compatible closure" }, catalog = [Support.PIN, extra];
  for (const runtimeId of ["crossover", "sikarugir"]) {
    const manager = Support.createManager({ runtimeId, catalog }), userDataDir = path.join(f.root, runtimeId), settings = { runtimes: { [manager.id]: { defaultVersion: extra.version } } };
    assert.equal(manager.id, runtimeId + "-graphics-bridge");assert.equal(manager.ui.groupId, runtimeId);
    assert.equal(manager.resolveSelection({}, settings, userDataDir).version, extra.version);
    assert.equal(manager.resolveSelection({ runtimeData: { [manager.id]: { version: Support.VERSION } } }, settings, userDataDir).version, Support.VERSION);
    assert.equal(manager.resolveSelection({}, settings, userDataDir, { version: "missing" }).version, "missing");
    assert.equal(manager.resolveSelection({}, settings, userDataDir, { version: "missing" }).ready, false);
  }
  const manifest = require("../src/modules/crossover/main").manifest;
  for (const runtime of Object.values(manifest.runtime.entries)) assert.deepEqual(runtime.settings.fields.find(field => field.key === "graphicsBridgeVersion").options.slice(1).map(option => option.value), Catalog.CATALOG.map(pin => pin.version));
});
test("owned DXMT transport survives both shared graphics environment merges and cannot be supplied through runtime settings", () => {
  const ReShade = require("../src/modules/shared/reshade"), Temporal = require("../src/modules/crossover/temporal");
  const transport = Temporal.environment({ dxmt: {} }, "/private/game/wine/lib/wine"), effects = { DYLD_INSERT_LIBRARIES: "/graphics/libreshade.dylib", RESHADE_TEMPORAL_METHOD: "fsr2" };
  assert.equal(ReShade.mergeEnvironment(ReShade.mergeEnvironment(transport, effects), effects).MACLAUNCHER_DXMT_BASE_LIBRARY,
    "/private/game/wine/lib/wine/x86_64-unix/maclauncher-dxmt-original.so");
  for (const module of ["../src/modules/crossover/runtime/launch", "../src/modules/crossover/sikarugir/launch"])
    assert.throws(() => require(module).parseEnvironment(["MACLAUNCHER_DXMT_BASE_LIBRARY=/unrelated.so"]), /Environment/);
});
test("DXMT camera support keeps only the matched renderer files from the shared Template archive", async t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), unpacked = path.join(f.root, "unpacked"), app = path.join(unpacked, `Template-${Support.VERSION}.app`);
  const renderer = path.join(app, "Contents/Frameworks/renderer/dxmt");
  for (const name of Support.FILES) { const file = path.join(renderer, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, name); }
  const unrelated = path.join(app, "Contents/MacOS/launcher");fs.mkdirSync(path.dirname(unrelated), { recursive: true });fs.writeFileSync(unrelated, "unused launcher");
  const metadata = await Support.prepareInstall({ unpacked, pin: Support.PIN });
  assert.equal(fs.existsSync(app), false);assert.equal(fs.existsSync(path.join(unpacked, "wswine.bundle")), false);
  assert.deepEqual(Object.keys(metadata.files), Support.FILES);assert.equal(Support.PIN.asset.sha256, require("../src/modules/crossover/sikarugir/runtime/catalog").DEFAULT_TEMPLATE.asset.sha256);
  const install = { installDir: unpacked, installationMetadata: metadata };assert.equal(Support.verified(install).baseRoot, path.join(unpacked, "dxmt/wine"));
  fs.writeFileSync(path.join(unpacked, "dxmt/wine/x86_64-windows/nvapi64.dll"), "changed");assert.equal(Support.verified(install), null);
});

async function privateGameView(t, executable = "Game.exe") {
  const f = fixture(t), GameView = require("../src/modules/crossover/temporal/game-view"), WindowsFiles = require("../src/modules/crossover/runtime/launch");
  const sourceRoot = path.join(f.root, "content"), directory = path.join(f.root, "runtime");
  const put = (name, bytes) => {const file = path.join(sourceRoot, name);fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, bytes);};
  put(executable, "original executable");put("plugins/sl.interposer.dll", pe());put("save.cfg", "initial save");put("delete.cfg", "obsolete");
  put("Assets/large.pak", Buffer.alloc(65536, 17));put("A/assets/portable.sav", "portable state");put("archive.bin", Buffer.alloc(65536, 9));
  const gameRoot = await WindowsFiles.stageGameFiles(sourceRoot, directory), executablePath = path.join(gameRoot, executable);
  const plan = {providerRoot: f.providerRoot, libraries: [{sourcePath: path.join(sourceRoot, "plugins/sl.interposer.dll"), relativePath: "plugins/sl.interposer.dll"}]};
  const entry = {}, context = {logger: {warn() {}}}, baseline = await GameView.baseline(entry, context, directory, gameRoot, executablePath, "sikarugir", plan.libraries);
  const open = async () => {
    const view = await GameView.camera(directory, gameRoot, executablePath, plan, baseline.recovery);
    assert.equal(require("../src/modules/crossover/temporal").prepareGame(plan, view.gameRoot), true);
    GameView.prepared(view, plan);GameView.remember(entry, context, "sikarugir", view, baseline.recovery);return view;
  };
  return {...f, GameView, sourceRoot, directory, gameRoot, executablePath, plan, entry, context, baseline, open};
}
test("never-used camera Off performs no projection filesystem work or process wrapping", async t => {
  const GameView = require("../src/modules/crossover/temporal/game-view"), entry = {}, context = {};
  for (const method of ["lstatSync", "readFileSync", "readdirSync", "realpathSync", "copyFileSync"]) t.mock.method(fs, method, () => assert.fail("Off accessed " + method));
  GameView.reconcile(entry, context, "/owned/runtime", "sikarugir");
  const plain = await GameView.baseline(entry, context, "/owned/runtime", "/owned/runtime/game", "/owned/runtime/game/Game.exe", "sikarugir", []);
  GameView.remember(entry, context, "sikarugir", plain, plain.recovery);GameView.watch(entry, context, "/owned/runtime", "sikarugir", plain);
  assert.equal(plain.gameRoot, "/owned/runtime/game");assert.equal(context.onProcessSpawn, undefined);assert.equal(context.spawnDetachedChecked, undefined);
});
test("camera views clone immediate regular leaves and alias only unmodified private asset subtrees", async t => {
  const f = await privateGameView(t), read = fs.readFileSync, list = fs.readdirSync;let assetReads = 0, assetWalks = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {if (String(file).endsWith("archive.bin") || String(file).endsWith("large.pak")) assetReads++;return read(file, ...args);});
  t.mock.method(fs, "readdirSync", (file, ...args) => {if (path.basename(String(file)) === "Assets") assetWalks++;return list(file, ...args);});
  const view = await f.open();
  for (const name of ["Game.exe", "archive.bin", "save.cfg", "plugins/sl.interposer.dll"]) assert.equal(fs.lstatSync(path.join(view.gameRoot, name)).isSymbolicLink(), false);
  const assets = path.join(view.gameRoot, "Assets");assert.equal(fs.lstatSync(assets).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(assets), fs.realpathSync(path.join(f.gameRoot, "Assets")));
  assert.equal(assetReads, 0);assert.equal(assetWalks, 0);
  fs.writeFileSync(path.join(view.gameRoot, "Assets/portable-new.sav"), "direct private save");
  assert.equal(read(path.join(f.gameRoot, "Assets/portable-new.sav"), "utf8"), "direct private save");
  assert.equal(fs.existsSync(path.join(f.sourceRoot, "Assets/portable-new.sav")), false);
  assert.deepEqual(read(path.join(f.gameRoot, "plugins/sl.interposer.dll")), pe());assert.deepEqual(read(path.join(f.sourceRoot, "plugins/sl.interposer.dll")), pe());
});
test("portable writes, atomic replacement, new files, deletion and changed executables survive camera to Off", async t => {
  const f = await privateGameView(t), view = await f.open();
  fs.writeFileSync(path.join(view.gameRoot, "save.cfg"), "first write");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "initial save", "regular leaves are independent COW files");
  fs.writeFileSync(path.join(view.gameRoot, "atomic.tmp"), "latest save");fs.renameSync(path.join(view.gameRoot, "atomic.tmp"), path.join(view.gameRoot, "save.cfg"));
  fs.writeFileSync(path.join(view.gameRoot, "new.sav"), "new portable save");fs.writeFileSync(view.executablePath, "game-updated executable");fs.unlinkSync(path.join(view.gameRoot, "delete.cfg"));
  fs.mkdirSync(path.join(view.gameRoot, "new-mod"));fs.writeFileSync(path.join(view.gameRoot, "new-mod/config.ini"), "new mod");
  f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  for (const [name, value] of [["save.cfg", "latest save"], ["new.sav", "new portable save"], ["Game.exe", "game-updated executable"], ["new-mod/config.ini", "new mod"]]) assert.equal(fs.readFileSync(path.join(f.gameRoot, name), "utf8"), value);
  assert.equal(fs.existsSync(path.join(f.gameRoot, "delete.cfg")), false);assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, "plugins/sl.interposer.dll")), pe());
  assert.equal(fs.existsSync(path.join(f.gameRoot, "plugins", Streamline.ORIGINAL)), false);assert.equal(fs.readFileSync(path.join(f.sourceRoot, "save.cfg"), "utf8"), "initial save");
  const plain = await f.GameView.baseline(f.entry, f.context, f.directory, f.gameRoot, f.executablePath, "sikarugir", []);
  assert.equal(plain.gameRoot, f.gameRoot);f.GameView.remember(f.entry, f.context, "sikarugir", plain, plain.recovery);
  const again = await f.open();assert.equal(fs.readFileSync(path.join(again.gameRoot, "save.cfg"), "utf8"), "latest save");
});
test("retirement preserves real concurrent conflicts but keeps the newest game save authoritative", async t => {
  const f = await privateGameView(t), view = await f.open();
  fs.writeFileSync(path.join(view.gameRoot, "save.cfg"), "game latest");fs.writeFileSync(path.join(f.gameRoot, "save.cfg"), "external edit");
  fs.writeFileSync(path.join(view.gameRoot, "plugins/sl.interposer.dll"), "user DLL mod");fs.writeFileSync(path.join(view.gameRoot, "plugins", Streamline.ORIGINAL), "user backup mod");fs.writeFileSync(path.join(view.gameRoot, "plugins", Streamline.RECORD), "user record mod");
  f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "game latest");
  const conflicts = path.join(f.directory, "temporal-conflicts"), rows = fs.readdirSync(conflicts);
  assert.ok(rows.some(row => fs.existsSync(path.join(conflicts, row, "save.cfg")) && fs.readFileSync(path.join(conflicts, row, "save.cfg"), "utf8") === "external edit"));
  for (const [name, value] of [["sl.interposer.dll", "user DLL mod"], [Streamline.ORIGINAL, "user backup mod"], [Streamline.RECORD, "user record mod"]]) assert.equal(fs.readFileSync(path.join(f.gameRoot, "plugins", name), "utf8"), value);
});
test("renamed materialized directories retain aliased portable data and moved camera libraries become originals", async t => {
  const f = await privateGameView(t, "A/Game.exe"), view = await f.open();
  fs.writeFileSync(path.join(view.gameRoot, "A/assets/portable.sav"), "latest nested save");
  fs.mkdirSync(path.join(view.gameRoot, "Nested"));fs.renameSync(path.join(view.gameRoot, "A"), path.join(view.gameRoot, "Nested/B"));fs.renameSync(path.join(view.gameRoot, "plugins"), path.join(view.gameRoot, "renamed-plugins"));
  f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, "Nested/B/assets/portable.sav"), "utf8"), "latest nested save");assert.equal(fs.existsSync(path.join(f.gameRoot, "A")), false);
  assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, "renamed-plugins/sl.interposer.dll")), pe());
  assert.equal(fs.existsSync(path.join(f.gameRoot, "renamed-plugins", Streamline.ORIGINAL)), false);assert.equal(fs.existsSync(path.join(f.gameRoot, "renamed-plugins", Streamline.RECORD)), false);
});
test("interrupted reconciliation retains launch copies and safely retries without deleting an earlier save", async t => {
  const f = await privateGameView(t), view = await f.open(), rename = fs.renameSync;
  fs.writeFileSync(path.join(view.gameRoot, "save.cfg"), "first latest");fs.writeFileSync(path.join(view.gameRoot, "z-last.sav"), "last latest");
  t.mock.method(fs, "renameSync", (from, to) => {if (to === path.join(f.gameRoot, "z-last.sav")) throw Object.assign(Error("controlled publication denied"), {code: "EACCES"});return rename(from, to);});
  assert.throws(() => f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir"), /controlled publication denied/);
  assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "first latest");assert.equal(fs.readFileSync(path.join(view.gameRoot, "save.cfg"), "utf8"), "first latest");
  fs.renameSync.mock.restore();f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "first latest");assert.equal(fs.readFileSync(path.join(f.gameRoot, "z-last.sav"), "utf8"), "last latest");
});
test("crash recovery accepts the owned selected receipt when the library binding persisted late", async t => {
  const f = await privateGameView(t), view = await f.open();
  fs.writeFileSync(path.join(view.gameRoot, "save.cfg"), "crash-recovered save");
  f.entry.runtimeData.sikarugir.cameraGameView.id = crypto.randomUUID();
  f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "crash-recovered save");
  assert.equal(JSON.parse(fs.readFileSync(view.file)).reconciled, true);
});
test("a failed next camera setup cannot strand an older persisted binding or block ordinary Off", async t => {
  const f = await privateGameView(t), view = await f.open(), oldBinding = structuredClone(f.entry.runtimeData.sikarugir.cameraGameView);
  fs.writeFileSync(path.join(view.gameRoot, "save.cfg"), "retired latest save");f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  assert.equal(f.entry.runtimeData.sikarugir.cameraGameView, null);
  const copy = fs.promises.copyFile;
  t.mock.method(fs.promises, "copyFile", async () => {throw Object.assign(Error("controlled next preparation failure"), {code: "ENOTSUP"});});
  await assert.rejects(f.open(), /controlled next preparation failure/);fs.promises.copyFile.mock.restore();
  assert.equal(fs.promises.copyFile, copy);f.entry.runtimeData.sikarugir.cameraGameView = oldBinding;
  f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");assert.equal(f.entry.runtimeData.sikarugir.cameraGameView, null);
  const unselected = await f.GameView.camera(f.directory, f.gameRoot, f.executablePath, f.plan, f.baseline.recovery);f.GameView.discard(unselected);
  f.entry.runtimeData.sikarugir.cameraGameView = oldBinding;f.GameView.reconcile(f.entry, f.context, f.directory, "sikarugir");
  assert.equal(f.entry.runtimeData.sikarugir.cameraGameView, null);assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "retired latest save");
});
test("legacy owned proxies with unavailable backups recover only from SHA-verified supplied originals", async t => {
  const f = await privateGameView(t), target = path.join(f.gameRoot, "plugins/sl.interposer.dll"), bytes = fs.readFileSync(target);
  const owned = Streamline.prepare({sourcePath: f.plan.libraries[0].sourcePath, gameRoot: f.gameRoot, relativePath: "plugins/sl.interposer.dll", providerRoot: f.providerRoot});assert.equal(owned.available, true);
  fs.writeFileSync(path.join(path.dirname(target), Streamline.ORIGINAL), "damaged private backup");
  t.mock.method(Streamline, "restore", () => assert.fail("legacy restoration must not mutate inaccessible leaves"));
  const recovery = await f.GameView.baseline(f.entry, f.context, f.directory, f.gameRoot, f.executablePath, "sikarugir", f.plan.libraries);
  assert.deepEqual(fs.readFileSync(path.join(recovery.gameRoot, "plugins/sl.interposer.dll")), bytes);assert.equal(fs.readFileSync(target)[4095], 2);
  assert.equal(fs.readFileSync(path.join(recovery.gameRoot, "plugins", Streamline.ORIGINAL), "utf8"), "damaged private backup", "unknown backup bytes are preserved");
  fs.writeFileSync(f.plan.libraries[0].sourcePath, "unverified changed source");
  await assert.rejects(f.GameView.baseline(f.entry, f.context, f.directory, f.gameRoot, f.executablePath, "sikarugir", f.plan.libraries), /original Streamline library is unavailable/);
});
test("projection cloning never silently falls back to copying an unsupported volume", async t => {
  const f = await privateGameView(t);let attempts = 0;
  t.mock.method(fs.promises, "copyFile", async (_source, _output, mode) => {attempts++;assert.ok(mode & fs.constants.COPYFILE_FICLONE_FORCE);throw Object.assign(Error("volume does not clone"), {code: "ENOTSUP"});});
  await assert.rejects(f.open(), /volume does not clone/);assert.equal(attempts, 1);
  assert.equal(fs.existsSync(path.join(f.directory, "temporal-camera")), false);assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, "plugins/sl.interposer.dll")), pe());
});
test("portable save reconciliation waits for real Wine supervisor retirement, including Stop", async t => {
  const {spawn} = require("node:child_process"), {once, EventEmitter} = require("node:events"), Launch = require("../src/modules/crossover/sikarugir/launch"), CrossOver = require("../src/modules/crossover/runtime/launch");
  for (const runtimeId of ["sikarugir", "crossover"]) for (const stop of [false, true]) {
    const f = await privateGameView(t), view = await f.open(), controller = new AbortController();
    f.entry.runtimeData[runtimeId] = f.entry.runtimeData.sikarugir;
    const pidFile = path.join(f.root, "writer.pid"), ready = path.join(f.root, "writer.ready"), returned = path.join(f.root, "wine-returned"), gate = path.join(f.root, "finish-permitted"), serverCalled = path.join(f.root, "server-called");
    const writer = `const fs=require('fs');const finish=()=>{fs.writeFileSync(process.env.SAVE,'final portable save');process.exit(0)};process.on('SIGTERM',finish);fs.writeFileSync(process.env.READY,'ready');setInterval(()=>{if(${!stop}&&fs.existsSync(process.env.GATE))finish()},10);`;
    const wine = path.join(f.root, "wine"), server = path.join(f.root, "wineserver");
    const reaper = `const fs=require('fs'),{spawn}=require('child_process');const writer=spawn(process.execPath,['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.PID,String(writer.pid));writer.on('exit',()=>process.exit(0));`;
    fs.writeFileSync(wine, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');const owner=spawn(process.execPath,['-e',${JSON.stringify(reaper)}],{detached:true,stdio:'ignore'});owner.unref();const wait=setInterval(()=>{if(fs.existsSync(process.env.READY)){clearInterval(wait);fs.writeFileSync(process.env.RETURNED,'yes')}},10);`, {mode: 0o755});
    fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('fs'),pid=Number(fs.readFileSync(process.env.PID,'utf8'));fs.writeFileSync(process.env.SERVER_CALLED,'yes');if(process.argv[2]==='-k'){const wait=setInterval(()=>{if(fs.existsSync(process.env.GATE)){clearInterval(wait);try{process.kill(pid,'SIGTERM')}catch{}}},10)}else{const wait=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(wait)}},10)}`, {mode: 0o755});
    let released = false, writerPid;
    const context = {...f.context, signal: controller.signal, onProcessSpawn: child => child.once("exit", () => {
      assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "final portable save", "save export root is current before lease release");
      assert.throws(() => process.kill(writerPid, 0), {code: "ESRCH"}, "Windows writer has retired");released = true;
    })};
    f.GameView.watch(f.entry, context, f.directory, runtimeId, view);
    const helper = Object.assign(new EventEmitter(), {spawnfile: process.execPath, spawnargs: [process.execPath, "setup"], exitCode: null, signalCode: null});
    await context.onProcessSpawn(helper);helper.removeAllListeners("exit");helper.emit("exit", 0);
    assert.equal(JSON.parse(fs.readFileSync(view.file)).reconciled, false, "unrelated setup process cannot reconcile the game view");
    const environment = {...process.env, PID: pidFile, READY: ready, RETURNED: returned, GATE: gate, SERVER_CALLED: serverCalled, SAVE: path.join(view.gameRoot, "save.cfg")};
    const args = runtimeId === "sikarugir" ? Launch.supervisorArguments(wine, server, "play", [], environment) : ["-c", CrossOver.SUPERVISOR, "maclauncher-crossover", wine, server];
    const child = spawn("/bin/sh", args, {detached: true, stdio: "ignore", env: environment});
    t.after(() => {child.removeAllListeners("exit");try {if (child.exitCode == null) process.kill(-child.pid, "SIGKILL");} catch {}try {if (writerPid) process.kill(writerPid, "SIGKILL");} catch {}});
    const closed = once(child, "close");await context.onProcessSpawn(child);
    const deadline = Date.now() + 5000;
    while ((!fs.existsSync(returned) || !fs.existsSync(serverCalled)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(returned), true);assert.equal(fs.existsSync(serverCalled), true);writerPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(child.exitCode, null);assert.equal(fs.readFileSync(path.join(f.gameRoot, "save.cfg"), "utf8"), "initial save", "root Wine exit is not game retirement");
    fs.writeFileSync(gate, "permit");
    if (stop) {controller.abort();assert.equal(require("../src/core/process-stop").stopProcessTree(child.pid), true);}
    const [code] = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error("supervisor did not retire")), 6000).unref())]);
    assert.equal(code, stop ? 143 : 0);assert.equal(released, true);assert.equal(JSON.parse(fs.readFileSync(view.file)).reconciled, true);
    f.GameView.clearWatch(context);
  }
});
