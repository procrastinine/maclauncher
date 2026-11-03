// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
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
function supportPin(version = "9.7.3") {
  return { version, versionLabel: `DXMT · support ${version}`, minimumMacOS: "14.0", hostArchitectures: ["arm64"], localBuild: false,
    upstreamRevision: `Template-${version}:sha256:${sha(version)}`, asset: { filename: `Template-${version}.tar.xz`, bytes: 42,
      url: `https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-${version}.tar.xz`, sha256: sha(version) } };
}
// The Template release list publishing these support archives.
function templateRoutes(assets, onList = () => {}) {
  const routes = Harness.githubRoutes("Sikarugir-App/Template", [{ tag_name: "v1.0", assets }]), list = routes["https://api.github.com/repos/Sikarugir-App/Template/releases"];
  routes["https://api.github.com/repos/Sikarugir-App/Template/releases"] = () => { onList(); return list; };
  return routes;
}
const templateAsset = row => ({ name: row.asset.filename, browser_download_url: row.asset.url, digest: `sha256:${row.asset.sha256}`, size: row.asset.bytes });
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
test("camera capability follows the automatic default after consent and requires matched DXMT, x64 and the selected renderer", async t => {
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
  const options = { install: { templateRoot: support, engineRoot: engine }, runtimeId: "sikarugir", root: graphicsRoot, host: { platform: "darwin", hardwareArch: "arm64", macOSVersion: "26.0" } };
  const plan = Temporal.resolvePlan(entry, {}, options);const streamline = {depth: true, motionVectors: true, jitter: true, exposure: true, cameraProjection: true};
  assert.deepEqual(plan.inputs, {...streamline, source: "streamline", methods: ["fsr2", "fsr3"], routes: [{...streamline, source: "streamline", methods: ["fsr2", "fsr3"]}]});
  assert.equal(plan.libraries[0].relativePath, "plugins/sl.interposer.dll");
  for (const settings of [{ graphicsBackend: "wined3d" }, { graphicsBackend: "d3dmetal" }, { graphicsBackend: "dxvk" }]) assert.equal(Temporal.resolvePlan(entry, {}, { ...options, settings }), null);
  assert.equal(Temporal.resolvePlan(entry, {}, { ...options, host: { ...options.host, macOSVersion: "13.6" } }), null);
  assert.equal(Temporal.resolvePlan(entry, {}, { ...options, host: { ...options.host, hardwareArch: "x64" } }), null);
  assert.ok(Temporal.resolvePlan(entry, {}, { ...options, host: { ...options.host, hardwareArch: null, macOSVersion: null } }),
    "unknown host requirements do not disable an otherwise matched bridge");
  const descriptor = path.join(dllRoot, "camera-bridge.json"), camera = JSON.parse(fs.readFileSync(descriptor));
  put(descriptor, JSON.stringify({ ...camera, minimumMacOS: "14.4.2" }));
  assert.equal(Temporal.adapter(graphicsRoot, { macOSVersion: "14.4.1" }), null);
  assert.ok(Temporal.adapter(graphicsRoot, { macOSVersion: "14.4.2" }));
  assert.ok(Temporal.adapter(graphicsRoot, { macOSVersion: null }));
  put(descriptor, JSON.stringify(camera));
  fs.writeFileSync(f.target, pe([...names, "slFutureAPI"]));assert.equal(Temporal.resolvePlan(entry, {}, options), null);fs.writeFileSync(f.target, pe());
  fs.writeFileSync(path.join(base, "x86_64-unix/winemetal.so"), "different renderer");assert.equal(Temporal.resolvePlan(entry, {}, options), null);
  put(path.join(base, "x86_64-unix/winemetal.so"), "native base");fs.unlinkSync(f.target);assert.equal(Temporal.resolvePlan(entry, {}, options), null);
  fs.writeFileSync(f.target, pe());
  const Support = require("../src/modules/crossover/temporal/support-manager"), vendor = path.join(f.root, "CrossOver");
  put(path.join(vendor, "lib/wine/x86_64-unix/wine"), "vendor loader");
  const pin = supportPin(), context = { userDataDir: path.join(f.root, "profile"), runtimeId: "crossover", runtimeSettings: { graphicsBackend: "dxmt", graphicsBridgeVersion: pin.version } };
  const fresh = {...context, userDataDir:path.join(f.root,"fresh-profile"), runtimeSettings:{graphicsBackend:"dxmt"}};
  const discovery = Temporal.resolvePlan(entry, fresh, {...options, install:{crossoverRoot:vendor}, runtimeId:"crossover", settings:fresh.runtimeSettings, allowDownload:true});
  assert.deepEqual(discovery.download, {managerId:"sikarugir-graphics-bridge",version:null,discoveryRequired:true});
  Support.core.rememberResolvedVersion({ userDataDir: context.userDataDir, entry: pin });
  const crossover = { ...options, install: { crossoverRoot: vendor }, runtimeId: "crossover", settings: context.runtimeSettings };
  assert.equal(Temporal.resolvePlan(entry, context, crossover), null);
  assert.equal(Temporal.resolvePlan(entry, context, { ...crossover, allowDownload: true }).inputs.requiresDownload, true);
  const dependency = { root: graphicsRoot, manager: { resolveSelection: () => ({ ready: true, install: crossover.install }) } };
  entry.effects = null;assert.deepEqual(Temporal.requirements(entry, context, dependency), []);
  entry.effects = { schema: 2, mode: "advanced", enabled: true, video: [{ id: "scene", kind: "temporal", enabled: true, method: "fsr2", settings: {} }] };
  assert.equal(Temporal.requirements(entry, context, dependency)[0]?.managerId, "sikarugir-graphics-bridge", "CrossOver downloads the shared DXMT support package");
  const sikarugirContext = { ...context, runtimeId: "sikarugir", runtimeSettings: { graphicsBackend: "auto", graphicsBridgeVersion: pin.version } };
  assert.equal(Temporal.resolvePlan(entry, sikarugirContext, { ...options, allowDownload: true }).download.managerId, "sikarugir-graphics-bridge");
  assert.equal(Temporal.requirements(entry, sikarugirContext, { ...dependency, manager: { resolveSelection: () => ({ ready: true, install: options.install }) } })[0]?.managerId, "sikarugir-graphics-bridge");
  assert.deepEqual(Temporal.resolvePlan(entry, context, { ...crossover, allowDownload: true, settings: { ...context.runtimeSettings, graphicsBridgeVersion: "missing-version" } }).download,
    {managerId:"sikarugir-graphics-bridge",version:null,discoveryRequired:true});
  assert.equal(Temporal.resolvePlan(entry, context, { ...crossover, allowDownload: true, settings: { ...context.runtimeSettings, dllOverrides: ["dxgi=n"] } }), null);
  fs.writeFileSync(f.target, pe([...names, "slFutureAPI"]));assert.deepEqual(Temporal.requirements(entry, context, dependency), []);
  fs.writeFileSync(f.target, pe());
  const native = require("../src/modules/shared/runtime/local-native");
  t.mock.method(native, "resolveLocalRuntime", ({ runtimePath, expectedSha256 }) => {
    const sha256 = sha(fs.readFileSync(runtimePath));if (expectedSha256) assert.equal(sha256, expectedSha256);
    return { executablePath: runtimePath, architectures: ["x86_64"], sha256 };
  });
  const older = supportPin("9.7.3"), newer = supportPin("9.7.4"), future = supportPin("12.3.8"), pins = [newer, older, future], userDataDir = path.join(f.root, "abi-profile");
  const abiManager = Support.createManager({ dependencies: { systemVersionSync: () => "14.0" } });
  Harness.network.routes = templateRoutes(pins.map(templateAsset));
  try { await abiManager.refreshCatalog({ userDataDir, force: true }); } finally { Harness.network.routes = null; }
  function installed(listed, nativeBytes, thunkBytes) {
    const row = abiManager.core.catalog.find(pin => pin.version === listed.version);
    const directory = abiManager.core.getInstallDir({ userDataDir, version: row.version }), files = {};
    for (const name of Support.FILES) {
      const bytes = name === "wine/x86_64-unix/winemetal.so" ? nativeBytes : name === "wine/x86_64-windows/winemetal.dll" ? thunkBytes : name;
      put(path.join(directory, "dxmt", name), bytes);files[name] = sha(bytes);
    }
    put(path.join(directory, "runtime.json"), JSON.stringify({ version: row.version, upstreamRevision: row.upstreamRevision, catalogEntry: row, source: "download",
      executableRelative: "dxmt/wine/x86_64-unix/winemetal.so", binarySha256: files["wine/x86_64-unix/winemetal.so"], archiveSha256: row.asset.sha256,
      installationMetadata: { schema: 1, files } }));
  }
  installed(older, "native base", "thunk base");installed(newer, "different native", "different thunk");
  const automatic = abiManager.resolveSelection({}, {}, userDataDir);
  assert.equal(automatic.version, future.version, "Automatic follows the newest compatible published release");
  assert.equal(automatic.selectionSource, "default");
  assert.equal(automatic.ready, false);assert.equal(automatic.requiresDownload, true);
  assert.equal(automatic.discoveryRequired, false, "the existing catalog already supplies the automatic version");
  const originalForRuntime = Support.forRuntime;
  t.mock.method(Support, "forRuntime", id => id === "crossover" ? abiManager : originalForRuntime(id));
  const abiContext = { userDataDir, runtimeId: "crossover", runtimeSettings: { graphicsBackend: "dxmt", graphicsBridgeVersion: "auto" } };
  const automaticOptions = { ...crossover, settings: abiContext.runtimeSettings };
  assert.equal(Temporal.resolvePlan(entry, abiContext, automaticOptions), null, "Automatic cannot acquire missing support without consent");
  const automaticDownload = Temporal.resolvePlan(entry, abiContext, { ...automaticOptions, allowDownload: true });
  assert.equal(automaticDownload.requiresDownload, true);
  assert.deepEqual(automaticDownload.download, { managerId: abiManager.id, version: future.version });
  const explicitPlan = version => Temporal.resolvePlan(entry, abiContext, { ...crossover, settings: { ...abiContext.runtimeSettings, graphicsBridgeVersion: version }, allowDownload: true });
  assert.equal(explicitPlan(older.version).dependency.version, older.version);
  assert.equal(explicitPlan(newer.version), null, "An installed incompatible explicit package is neither replaced nor requested again");
  assert.equal(abiManager.resolveSelection({}, {}, userDataDir, { version: newer.version }).version, newer.version);
  assert.deepEqual(explicitPlan("unlisted-future").download, {managerId:abiManager.id,version:null,discoveryRequired:true},
    "An unlisted exact choice discovers the publisher list after consent before deciding availability");
  assert.equal(abiManager.resolveSelection({}, {}, userDataDir, {version:"unlisted-future"}).version, "unlisted-future",
    "Discovery planning preserves the explicit choice");
  assert.equal(explicitPlan(future.version).download.version, future.version, "An uninstalled publisher release still receives actual inspection after consent");
  installed(future, "native base", "thunk base");
  assert.equal(explicitPlan(future.version).dependency.version, future.version, "Actual matching bytes admit a future release without a version whitelist");
  const automaticReady = Temporal.resolvePlan(entry, abiContext, automaticOptions);
  assert.equal(automaticReady.dependency.version, future.version, "Automatic resumes with the installed release after its actual renderer bytes match");
  assert.equal(automaticReady.requiresDownload, undefined);
});
test("the DXMT support catalog discovers publisher versions and preserves offline explicit choices", async t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), pin = supportPin(), extra = supportPin("11.4.2");
  let calls = 0;
  const assets = [pin, extra].map(templateAsset), userDataDir = path.join(f.root, "profile");
  t.after(() => { Harness.network.routes = null; });
  const manager = Support.createManager(), settings = { runtimes: { [manager.id]: { defaultVersion: extra.version } } };
  assert.deepEqual(manager.core.catalog, []);
  // A second listing of the same archive without a digest is not another version.
  Harness.network.routes = templateRoutes([...assets, { ...assets[0], digest: null }], () => calls++);
  await manager.refreshCatalog({ userDataDir, force: true });
  Harness.network.routes = null;
  assert.equal(calls, 1);
  assert.deepEqual(manager.core.catalog.map(row => row.version), [pin.version, extra.version]);
  assert.equal(manager.resolveSelection({}, settings, userDataDir).version, extra.version);
  assert.equal(manager.resolveSelection({ runtimeData: { [manager.id]: { version: pin.version } } }, settings, userDataDir).version, pin.version);
  assert.equal(manager.resolveSelection({}, settings, userDataDir, { version: "missing" }).version, "missing");
  assert.equal(manager.resolveSelection({}, settings, userDataDir, { version: "missing" }).ready, false);
  const offline = Support.createManager();
  assert.equal(offline.resolveSelection({ runtimeData: { [manager.id]: { version: pin.version } } }, {}, userDataDir).version, pin.version);
});
test("CrossOver and Sikarugir show one DXMT support package with the same versions and plain version labels", t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), registry = require("../src/modules/registry");
  const pin = supportPin(), extra = supportPin("11.4.2"), userDataDir = path.join(f.root, "profile");
  // One manager serves both hosts and appears once in Runtimes, under Graphics.
  assert.equal(Support.forRuntime("crossover"), Support.forRuntime("sikarugir"));
  assert.equal(Support.forRuntime("unrelated"), null);
  const registered = [...new Set(registry.listModules().flatMap(info => registry.getModule(info.id).runtimeManagers || [])
    .filter(source => /dxmt support/i.test(source.label || "") || /graphics-bridge/.test(source.id)))];
  assert.deepEqual(registered.map(source => source.id), [Support.id]);
  assert.deepEqual(registry.getRuntimeManagerUi(Support.id), Support.ui);
  assert.deepEqual([Support.ui.groupId, Support.ui.tabLabel, Support.ui.sectionLabel], ["graphics", "Graphics", "DXMT support"]);
  // A catalog saved by an earlier launcher still carries composed labels.
  require("../src/modules/shared/runtime/runtime-catalog").writeRuntimeCatalog({ userDataDir, managerId: Support.id,
    entries: [pin, extra].map(row => ({ ...row, catalogSourceId: "upstream", upstreamTag: row.version })), source: "https://github.com/Sikarugir-App/Template/releases",
    sourceStates: { upstream: { status: "success", fetchedAt: Date.now(), error: null, mode: "all" } } });
  const state = Support.getState({ userDataDir });
  assert.equal(Support.core.catalog.find(row => row.version === pin.version)?.versionLabel, `DXMT · support ${pin.version}`);
  assert.deepEqual(state.catalog.versions, [pin.version, extra.version]);
  assert.doesNotMatch(JSON.stringify(state), /DXMT · support/);
  const mod = require("../src/modules/crossover/main"), manifest = mod.manifest;
  const { resolveRuntimeSettingsSchema, normalizeRuntimeSettings } = require("../src/core/runtime-settings");
  const expected = [{ value: "auto", label: "Automatic" }, { value: pin.version, label: pin.version }, { value: extra.version, label: extra.version }];
  for (const runtimeId of ["crossover", "sikarugir"]) {
    const schema = resolveRuntimeSettingsSchema(manifest, runtimeId), field = schema.fields.find(field => field.key === "graphicsBridgeVersion");
    assert.deepEqual(field.options, [{ value: "auto", label: "Automatic" }]);
    assert.equal(field.optionsAction, "listGraphicsBridgeVersions");assert.equal(field.optionsKey, "graphicsBridgeVersions");
    const context = { userDataDir, runtimeId };
    assert.deepEqual(mod.settingsActions.listGraphicsBridgeVersions({ runtimeId }, context).graphicsBridgeVersions, expected);
    assert.deepEqual(mod.actions.listGraphicsBridgeVersions({ runtimeId }, {}, context).graphicsBridgeVersions, expected);
    for (const moduleId of ["fna", "unity"]) {
      const engine = registry.getModule(moduleId);
      assert.deepEqual(engine.settingsActions.listGraphicsBridgeVersions({ runtimeId }, context).graphicsBridgeVersions, expected);
      assert.deepEqual(engine.actions.listGraphicsBridgeVersions({ runtimeId: "unrelated" }, {}, context).graphicsBridgeVersions, expected);
    }
    for (const selected of [pin.version, "unavailable-saved-version"])
      assert.equal(normalizeRuntimeSettings(schema, { graphicsBridgeVersion: selected }).graphicsBridgeVersion, selected);
  }
});
test("DXMT support installed by earlier launchers in either host's folder is used in place on Apple Silicon without another download",
  { skip: require("../src/modules/shared/runtime/host-capabilities").getHostCapabilities().hardwareArch !== "arm64" && "DXMT support runs on Apple Silicon" }, t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), userDataDir = path.join(f.root, "profile");
  // DXMT's Wine-side libraries are x86_64 files; the release declares Apple Silicon Macs as its hosts.
  const library = Buffer.alloc(64);library.writeUInt32LE(0xfeedfacf, 0);library.writeUInt32LE(0x01000007, 4);library.writeUInt32LE(3, 8);library.writeUInt32LE(6, 12);
  // Earlier launchers kept one folder per host and no CPU subfolder, and recorded no build CPU.
  function earlierInstall(folder, pin) {
    const directory = path.join(userDataDir, "runtimes", folder, pin.version), files = {};
    for (const name of Support.FILES) {
      const bytes = name === "wine/x86_64-unix/winemetal.so" ? library : Buffer.from(name), file = path.join(directory, "dxmt", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes, { mode: 0o755 });files[name] = sha(bytes);
    }
    fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: pin.version, upstreamRevision: pin.upstreamRevision, catalogEntry: pin,
      binarySha256: files["wine/x86_64-unix/winemetal.so"], executableRelative: "dxmt/wine/x86_64-unix/winemetal.so", archiveSha256: pin.asset.sha256,
      installationMetadata: { schema: 1, files }, assetUrl: pin.asset.url, source: "download", installedAt: "2026-10-24T15:22:40.761Z" }));
    return directory;
  }
  const crossover = supportPin("9.7.3"), sikarugir = supportPin("9.7.4");
  const directories = { [crossover.version]: earlierInstall("crossover-graphics-bridge", crossover), [sikarugir.version]: earlierInstall("sikarugir-graphics-bridge", sikarugir) };
  const state = Support.getState({ userDataDir });
  assert.deepEqual(state.installed.map(row => [row.version, row.ready, row.architecture, row.installDir]).sort(),
    Object.entries(directories).map(([version, directory]) => [version, true, "arm64", directory]), "each install is listed once, for Apple Silicon");
  for (const version of Object.keys(directories)) assert.equal(state.catalog.versionRequirements[version]?.available, true, `${version}: no Install offered beside it`);
  for (const runtimeId of ["crossover", "sikarugir"]) {
    for (const [version, directory] of Object.entries(directories)) {
      const selected = Support.forRuntime(runtimeId).resolveSelection({}, {}, userDataDir, { version, verification: "full" });
      assert.equal(selected.ready, true, `${runtimeId} ${version}`);assert.ok(!selected.requiresDownload, `${runtimeId} ${version}: no download`);
      assert.equal(selected.install.installDir, directory);assert.equal(selected.install.baseRoot, path.join(directory, "dxmt/wine"));
    }
    const choices = require("../src/modules/crossover/main").settingsActions.listGraphicsBridgeVersions({ runtimeId }, { userDataDir, runtimeId }).graphicsBridgeVersions;
    assert.deepEqual(choices.map(row => row.value).sort(), ["auto", ...Object.keys(directories)].sort());
  }
  // Nothing is moved or copied.
  for (const directory of Object.values(directories)) assert.ok(fs.existsSync(path.join(directory, "runtime.json")));
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes/sikarugir-graphics-bridge/arm64")), false);
});
test("owned DXMT transport survives both shared graphics environment merges and cannot be supplied through runtime settings", () => {
  const ReShade = require("../src/modules/shared/reshade"), Temporal = require("../src/modules/crossover/temporal");
  const transport = Temporal.environment({ dxmt: {} }, "/private/game/wine/lib/wine"), effects = { DYLD_INSERT_LIBRARIES: "/graphics/libreshade.dylib", RESHADE_TEMPORAL_METHOD: "fsr2" };
  assert.equal(ReShade.mergeEnvironment(ReShade.mergeEnvironment(transport, effects), effects).MACLAUNCHER_DXMT_BASE_LIBRARY,
    "/private/game/wine/lib/wine/x86_64-unix/maclauncher-dxmt-original.so");
  for (const module of ["../src/modules/crossover/runtime/launch", "../src/modules/crossover/sikarugir/launch"])
    assert.throws(() => require(module).parseEnvironment(["MACLAUNCHER_DXMT_BASE_LIBRARY=/unrelated.so"]), /Environment/);
});
for (const layout of ["Frameworks", "SharedSupport"]) test(`DXMT camera support keeps only the matched renderer files from the shared Template archive (${layout}/renderer)`, async t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), pin = supportPin(), unpacked = path.join(f.root, "unpacked"), app = path.join(unpacked, `Template-${pin.version}.app`);
  const renderer = path.join(app, "Contents", layout, "renderer/dxmt");fs.mkdirSync(path.join(app, "Contents/Frameworks"), { recursive: true });
  for (const name of Support.FILES) { const file = path.join(renderer, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, name); }
  const unrelated = path.join(app, "Contents/MacOS/launcher");fs.mkdirSync(path.dirname(unrelated), { recursive: true });fs.writeFileSync(unrelated, "unused launcher");
  const metadata = await Support.prepareInstall({ unpacked, pin });
  assert.equal(fs.existsSync(app), false);assert.equal(fs.existsSync(path.join(unpacked, "wswine.bundle")), false);
  assert.deepEqual(Object.keys(metadata.files), Support.FILES);
  const install = { installDir: unpacked, installationMetadata: metadata };assert.equal(Support.verified(install).baseRoot, path.join(unpacked, "dxmt/wine"));
  fs.writeFileSync(path.join(unpacked, "dxmt/wine/x86_64-windows/nvapi64.dll"), "changed");assert.equal(Support.verified(install), null);
});

test("an explicit original-source camera view copies only code and retains old and new private bytes", async t => {
  const f = fixture(t), GameView = require("../src/modules/crossover/temporal/game-view");
  assert.equal(GameView.baseline, undefined, "released baseline recovery is absent from the current adapter");
  const base = path.join(fs.realpathSync(f.root), "original"), directory = path.join(f.root, "runtime");
  const put = (root, name, bytes) => {const file = path.join(root, name);fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, bytes);};
  put(base, "Game.exe", "original executable");put(base, "plugins/sl.interposer.dll", pe());
  put(base, "settings.ini", "original settings");put(base, "Assets/large.pak", Buffer.alloc(65536, 7));
  const old = path.join(directory, "temporal-camera");put(old, "SaveOld.dat", "old private save");
  put(directory, "temporal-camera.json", "old receipt must stay untouched");
  const recovery = {overrides: {}, omitted: new Set(), libraries: []};
  const plan = {libraries: [{relativePath: "plugins/sl.interposer.dll"}]};
  const view = await GameView.camera(directory, base, path.join(base, "Game.exe"), plan, recovery);
  assert.notEqual(view.gameRoot, old);
  const copied = Object.entries(view.record.entries).filter(([, row]) => row.kind === "file").map(([name]) => name).sort();
  assert.deepEqual(copied, ["Game.exe", "plugins/sl.interposer.dll"]);
  assert.ok(fs.lstatSync(path.join(view.gameRoot, "settings.ini")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(view.gameRoot, "Assets")).isSymbolicLink());
  fs.writeFileSync(path.join(view.gameRoot, "settings.ini"), "game writes to original settings");
  assert.equal(fs.readFileSync(path.join(base, "settings.ini"), "utf8"), "game writes to original settings");
  put(view.gameRoot, "SaveNew.dat", "new private save");
  const entry = {}, context = {};GameView.remember(entry, context, "sikarugir", view, recovery);
  GameView.reconcile(entry, context, directory, "sikarugir");
  assert.equal(fs.readFileSync(path.join(view.gameRoot, "SaveNew.dat"), "utf8"), "new private save");
  assert.equal(fs.existsSync(path.join(base, "SaveNew.dat")), false, "retirement never copies over or renames original data");
  assert.equal(fs.readFileSync(path.join(old, "SaveOld.dat"), "utf8"), "old private save");
  assert.equal(fs.readFileSync(path.join(directory, "temporal-camera.json"), "utf8"), "old receipt must stay untouched");
  GameView.discard(view);
  assert.equal(fs.readFileSync(path.join(view.gameRoot, "SaveNew.dat"), "utf8"), "new private save");
  const next = await GameView.camera(directory, base, path.join(base, "Game.exe"), plan, recovery);
  assert.notEqual(next.gameRoot, view.gameRoot);
  assert.equal(fs.readFileSync(path.join(view.gameRoot, "SaveNew.dat"), "utf8"), "new private save");
});

test("never-used camera Off performs no projection filesystem work or process wrapping", async t => {
  const GameView = require("../src/modules/crossover/temporal/game-view"), entry = {}, context = {};
  for (const method of ["lstatSync", "readFileSync", "readdirSync", "realpathSync", "copyFileSync"]) t.mock.method(fs, method, () => assert.fail("Off accessed " + method));
  GameView.reconcile(entry, context, "/owned/runtime", "sikarugir");
  assert.equal(GameView.baseline, undefined);
  const plain = {binding: null};GameView.watch(entry, context, "/owned/runtime", "sikarugir", plain);
 assert.equal(context.onProcessSpawn, undefined);assert.equal(context.spawnDetachedChecked, undefined);
});
