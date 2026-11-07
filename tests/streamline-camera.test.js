// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Streamline = require("../src/modules/crossover/temporal/streamline"), PE = require("../src/modules/crossover/temporal/streamline/pe-exports");
const { execFileSync } = require("node:child_process"), { peFixture } = require("./helpers/pe-fixture");
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
// A DXMT support row as earlier launchers recorded it: one package per
// Template release, versioned by the release number.
function supportPin(version = "9.7.3") {
  return { version, versionLabel: `DXMT · support ${version}`, minimumMacOS: "14.0", hostArchitectures: ["arm64"], localBuild: false,
    upstreamRevision: `Template-${version}:sha256:${sha(version)}`, asset: { filename: `Template-${version}.tar.xz`, bytes: 42,
      url: `https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-${version}.tar.xz`, sha256: sha(version) } };
}
// A Sikarugir Template release archive whose renderer folder holds DXMT. The
// renderer bytes decide whether the camera adapter matches it.
function templateArchive(root, release, { layout = "Frameworks", native = "native base", thunk = "thunk base" } = {}) {
  const stage = path.join(root, `template-${release}`), app = path.join(stage, `Template-${release}.app`), dxmt = path.join(app, "Contents", layout, "renderer/dxmt");
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes); };
  const builtin = () => { const fixture = peFixture({ is64: true });fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);fixture.bytes.write("Wine builtin DLL\0", 64);return fixture.bytes; };
  put(path.join(dxmt, "wine/x86_64-unix/winemetal.so"), native);put(path.join(dxmt, "wine/x86_64-windows/winemetal.dll"), thunk);
  for (const name of ["d3d11.dll", "dxgi.dll", "d3d10core.dll", "nvapi64.dll"]) put(path.join(dxmt, "wine/x86_64-windows", name), builtin());
  put(path.join(dxmt, "LICENSE"), "DXMT licence");put(path.join(dxmt, "version"), "v0.72\n");
  put(path.join(app, "Contents/MacOS/launcher"), "unused launcher");put(path.join(app, "Contents/Frameworks/wswine.bundle/version"), "unused engine");
  const file = path.join(root, `Template-${release}.tar.xz`);
  execFileSync("/usr/bin/tar", ["-cJf", file, "-C", stage, path.basename(app)]);
  return { release, version: `template-Template-${release}`, name: path.basename(file), bytes: fs.readFileSync(file) };
}
// The Template release list publishing these archives, and their downloads.
function templateRoutes(archives, onList = () => {}) {
  const repository = "Sikarugir-App/Template", list = `https://api.github.com/repos/${repository}/releases`;
  const releases = archives.map(item => ({ tag_name: `v${item.release}`, assets: [{ name: item.name, size: item.bytes.length, digest: `sha256:${sha(item.bytes)}`,
    browser_download_url: `https://github.com/${repository}/releases/download/v${item.release}/${item.name}` }] }));
  const routes = Harness.githubRoutes(repository, releases), listed = routes[list];
  routes[list] = () => { onList();return listed; };
  for (const [index, item] of archives.entries()) routes[releases[index].assets[0].browser_download_url] = item.bytes;
  return routes;
}
async function installTemplates(manager, userDataDir, routes, archives) {
  Harness.network.routes = routes;
  try {
    await manager.refreshCatalog({ userDataDir, force: true });
    for (const item of archives) await manager.installRuntime({ userDataDir, version: item.version });
  } finally { Harness.network.routes = null; }
}
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
  // A used D3D12 provider must not replace the selected D3D11 DXMT camera route.
  const crossoverRoot=path.join(f.root,"CrossOver");put(path.join(crossoverRoot,"lib/wine/x86_64-unix/wine"),"loader");
  const mixed=Temporal.resolvePlan(entry,{}, {...options,runtimeId:"crossover",install:{crossoverRoot},
    settings:{dlss:true,graphicsBackend:"dxmt"},translatorPlan:{apiMode:true,components:{
      d3d11:{used:{engine:"dxmt",root:base}},d3d12:{used:{engine:"d3dmetal"}}
    }}});
  assert.ok(mixed?.dxmt,"D3D11 keeps its matched DXMT producer");assert.deepEqual(mixed.inputs,plan.inputs);
  assert.equal(Temporal.rendererFile(mixed,"x86_64-windows","d3d12.dll","d3dmetal-original"),"d3dmetal-original");
  const bridgeFile=path.join(dllRoot,"camera-bridge.json"),record=JSON.parse(fs.readFileSync(bridgeFile));
  put(path.join(dllRoot,"x86_64-windows/d3d12.dll"),"dxmt12");record.files["x86_64-windows/d3d12.dll"]=sha("dxmt12");record.temporalD3D12API=1;put(bridgeFile,JSON.stringify(record));
  fs.unlinkSync(f.target);
  const directOptions={...options,runtimeId:"crossover",install:{crossoverRoot},settings:{dlss:true},translatorPlan:{apiMode:true,components:{d3d11:{used:{engine:"dxvk"}},d3d12:{used:{engine:"dxmt",root:base}}}}};
  const direct=Temporal.resolvePlan(entry,{},directOptions);
  assert.ok(direct?.dxmt,"Direct NGX does not depend on a Streamline plugin");assert.deepEqual(direct.dxmtRoles,["d3d12"]);assert.equal(Temporal.rendererFiles(direct).includes("x86_64-windows/d3d11.dll"),false);assert.equal(Temporal.rendererFiles(direct).includes("x86_64-windows/d3d12.dll"),true);assert.equal(direct.inputs.source,"ngx");assert.equal(direct.inputs.cameraProjection,false);assert.deepEqual(direct.inputs.methods,["metalfx"]);
  assert.equal(Temporal.rendererFile(direct,"x86_64-windows","d3d12.dll","stock"),path.join(dllRoot,"x86_64-windows/d3d12.dll"));
  assert.equal(Temporal.rendererFile({...direct,dxmtRoles:["d3d11"]},"x86_64-windows","d3d12.dll","stock"),"stock");
  record.temporalD3D12API=0;put(bridgeFile,JSON.stringify(record));assert.equal(Temporal.resolvePlan(entry,{},directOptions),null);
  fs.writeFileSync(f.target,pe());


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
  // Template releases whose actual renderer bytes match the camera adapter, or not.
  const archives = { older: templateArchive(f.root, "9.7.3"), newer: templateArchive(f.root, "9.7.4", { native: "different native", thunk: "different thunk" }),
    future: templateArchive(f.root, "12.3.8") };
  const routes = templateRoutes(Object.values(archives)), userDataDir = path.join(f.root, "abi-profile");
  const abiManager = Support.createManager({ dependencies: { systemVersionSync: () => "14.0" } });
  await installTemplates(abiManager, userDataDir, routes, [archives.older, archives.newer]);
  const originalForRuntime = Support.forRuntime;
  t.mock.method(Support, "forRuntime", id => id === "crossover" ? abiManager : originalForRuntime(id));
  const abiContext = { userDataDir, runtimeId: "crossover", runtimeSettings: { graphicsBackend: "dxmt", graphicsBridgeVersion: "auto" } };
  const automaticOptions = { ...crossover, settings: abiContext.runtimeSettings };
  const automatic = Temporal.resolvePlan(entry, abiContext, automaticOptions);
  assert.equal(automatic.dependency.version, archives.older.version, "Automatic uses the installed release whose renderer matches");
  assert.equal(automatic.requiresDownload, undefined);
  const explicitPlan = version => Temporal.resolvePlan(entry, abiContext, { ...crossover, settings: { ...abiContext.runtimeSettings, graphicsBridgeVersion: version }, allowDownload: true });
  assert.equal(explicitPlan(archives.older.version).dependency.version, archives.older.version);
  assert.equal(explicitPlan(archives.newer.version), null, "An installed incompatible explicit package is neither replaced nor requested again");
  assert.equal(abiManager.resolveSelection({}, {}, userDataDir, { version: archives.newer.version }).version, archives.newer.version);
  assert.deepEqual(explicitPlan("unlisted-future").download, {managerId:abiManager.id,version:null,discoveryRequired:true},
    "An unlisted exact choice discovers the publisher list after consent before deciding availability");
  assert.equal(abiManager.resolveSelection({}, {}, userDataDir, {version:"unlisted-future"}).version, "unlisted-future",
    "Discovery planning preserves the explicit choice");
  assert.equal(explicitPlan(archives.future.version).download.version, archives.future.version, "An uninstalled publisher release still receives actual inspection after consent");
  // Without a matching installation, Automatic acquires the newest published release only after consent.
  const mismatched = { ...abiContext, userDataDir: path.join(f.root, "mismatched-profile") };
  await installTemplates(abiManager, mismatched.userDataDir, routes, [archives.newer]);
  assert.equal(Temporal.resolvePlan(entry, mismatched, automaticOptions), null, "Automatic cannot acquire missing support without consent");
  const automaticDownload = Temporal.resolvePlan(entry, mismatched, { ...automaticOptions, allowDownload: true });
  assert.equal(automaticDownload.requiresDownload, true);
  assert.deepEqual(automaticDownload.download, { managerId: abiManager.id, version: archives.future.version });
  await installTemplates(abiManager, userDataDir, routes, [archives.future]);
  assert.equal(explicitPlan(archives.future.version).dependency.version, archives.future.version, "Actual matching bytes admit a future release without a version whitelist");
  const automaticReady = Temporal.resolvePlan(entry, abiContext, automaticOptions);
  assert.equal(automaticReady.dependency.version, archives.future.version, "Automatic follows the newest installed release whose renderer matches");
  assert.equal(automaticReady.requiresDownload, undefined);
});
test("the DXMT support catalog discovers publisher versions and preserves offline explicit choices", async t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager");
  const pin = templateArchive(f.root, "9.7.3"), extra = templateArchive(f.root, "11.4.2"), userDataDir = path.join(f.root, "profile");
  let calls = 0;
  t.after(() => { Harness.network.routes = null; });
  const manager = Support.createManager();
  assert.deepEqual(manager.core.catalog, []);
  // A second listing of the same archive without a digest is not another version.
  const routes = templateRoutes([pin, extra]), list = "https://api.github.com/repos/Sikarugir-App/Template/releases", releases = routes[list]();
  routes[list] = () => { calls++;return [{ ...releases[0], assets: [...releases[0].assets, { ...releases[0].assets[0], digest: null }] }, ...releases.slice(1)]; };
  Harness.network.routes = routes;
  await manager.refreshCatalog({ userDataDir, force: true });
  Harness.network.routes = null;
  assert.equal(calls, 1);
  assert.deepEqual(manager.core.catalog.map(row => row.version).sort(), [pin.version, extra.version].sort());
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, extra.version, "the newest published release is the default");
  assert.equal(manager.resolveSelection({ runtimeData: { [manager.id]: { version: pin.version } } }, {}, userDataDir).version, pin.version);
  assert.equal(manager.resolveSelection({}, {}, userDataDir, { version: "missing" }).version, "missing");
  assert.equal(manager.resolveSelection({}, {}, userDataDir, { version: "missing" }).ready, false);
  const offline = Support.createManager();
  assert.equal(offline.resolveSelection({ runtimeData: { [manager.id]: { version: pin.version } } }, {}, userDataDir).version, pin.version);
});
test("CrossOver and Sikarugir share one DXMT manager and list the same installed versions", async t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), registry = require("../src/modules/registry");
  const userDataDir = path.join(f.root, "profile"), installed = templateArchive(f.root, "9.7.3"), listed = templateArchive(f.root, "11.4.2");
  // One manager serves both hosts and appears once in Runtimes, under DirectX → Metal.
  assert.equal(Support.forRuntime("crossover"), Support.forRuntime("sikarugir"));
  assert.equal(Support.forRuntime("unrelated"), null);
  const registered = [...new Set(registry.listModules().flatMap(info => registry.getModule(info.id).runtimeManagers || [])
    .filter(source => /dxmt/i.test(source.label || "") || /graphics-bridge/.test(source.id)))];
  assert.deepEqual(registered.map(source => source.id), [Support.id]);
  assert.deepEqual([Support.ui.groupId, Support.ui.sectionLabel], ["directx-metal", "DXMT"]);
  // A catalog saved by an earlier launcher carries composed labels; they are not shown.
  require("../src/modules/shared/runtime/runtime-catalog").writeRuntimeCatalog({ userDataDir, managerId: Support.id,
    entries: [supportPin(), supportPin("11.4.2")].map(row => ({ ...row, catalogSourceId: "upstream", upstreamTag: row.version })), source: "https://github.com/Sikarugir-App/Template/releases",
    sourceStates: { upstream: { status: "success", fetchedAt: Date.now(), error: null, mode: "all" } } });
  assert.doesNotMatch(JSON.stringify(Support.getState({ userDataDir })), /DXMT · support/);
  await installTemplates(Support, userDataDir, templateRoutes([installed, listed]), [installed]);
  const label = Support.getState({ userDataDir }).versionLabels?.[installed.version];
  assert.ok(label && !/DXMT · support/.test(label), label);
  const mod = require("../src/modules/crossover/main"), manifest = mod.manifest;
  const { resolveRuntimeSettingsSchema, normalizeRuntimeSettings } = require("../src/core/runtime-settings");
  // Settings list installed copies; other releases are acquired from Runtimes or consented Play.
  const expected = [{ value: "auto", label: "Automatic" }, { value: installed.version, label }];
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
    for (const selected of [installed.version, "unavailable-saved-version"])
      assert.equal(normalizeRuntimeSettings(schema, { graphicsBridgeVersion: selected }).graphicsBridgeVersion, selected);
  }
});
test("DXMT support installed by earlier launchers in either host's folder is used in place on Apple Silicon without another download",
  { skip: require("../src/modules/shared/runtime/host-capabilities").getHostCapabilities().hardwareArch !== "arm64" && "DXMT support runs on Apple Silicon" }, t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), userDataDir = path.join(f.root, "profile");
  // DXMT's Wine-side libraries are x86_64 files; the release declares Apple Silicon Macs as its hosts.
  const library = Buffer.alloc(64);library.writeUInt32LE(0xfeedfacf, 0);library.writeUInt32LE(0x01000007, 4);library.writeUInt32LE(3, 8);library.writeUInt32LE(6, 12);
  // Earlier launchers kept one folder per host and no CPU subfolder, recorded no build CPU,
  // and copied these files from the Template's dxmt folder.
  const earlierFiles = ["wine/x86_64-unix/winemetal.so", "wine/x86_64-windows/winemetal.dll", "wine/x86_64-windows/nvapi64.dll", "wine/x86_64-windows/d3d10core.dll", "LICENSE", "version"];
  function earlierInstall(folder, pin) {
    const directory = path.join(userDataDir, "runtimes", folder, pin.version), files = {};
    for (const name of earlierFiles) {
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
  const Contract = require("../src/modules/shared/runtime/translator-environment.mjs");
  for (const runtime of ["crossover", "sikarugir"]) {
    const declaration = require("../src/modules/registry").listTranslatorEnvironments().find(item => item.id === runtime);
    assert.throws(() => Contract.normalizeValues({ MACLAUNCHER_DXMT_BASE_LIBRARY: "/unrelated.so" }, { declarations: [declaration] }), /set by MacLauncher/);
    assert.deepEqual(Contract.launchValues([declaration], [runtime], { game: { [runtime]: { MACLAUNCHER_DXMT_BASE_LIBRARY: "/unrelated.so" } } }).values, {});
  }
});
for (const layout of ["Frameworks", "SharedSupport"]) test(`DXMT camera support keeps only the Template's dxmt folder from its archive (${layout}/renderer)`, async t => {
  const f = fixture(t), Support = require("../src/modules/crossover/temporal/support-manager"), archive = templateArchive(f.root, "9.7.3", { layout });
  const manager = Support.createManager(), userDataDir = path.join(f.root, "profile");
  await installTemplates(manager, userDataDir, templateRoutes([archive]), [archive]);
  const selected = manager.resolveSelection({}, {}, userDataDir, { version: archive.version, verification: "full" }), directory = selected.install.installDir;
  assert.equal(selected.ready, true);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["dxmt", "runtime.json"], "the Template app, its launcher and its Wine engine are not kept");
  assert.deepEqual(fs.readdirSync(path.join(directory, "dxmt")).sort(), ["LICENSE", "version", "wine"], "the folder keeps its licence");
  assert.equal(selected.install.baseRoot, path.join(directory, "dxmt/wine"));
  const files = selected.install.installationMetadata.files;
  for (const name of ["wine/x86_64-unix/winemetal.so", "wine/x86_64-windows/winemetal.dll", "wine/x86_64-windows/nvapi64.dll", "wine/x86_64-windows/d3d10core.dll"])
    assert.match(files[name] || "", /^[a-f0-9]{64}$/, name);
  assert.equal(files["wine/x86_64-unix/winemetal.so"], sha("native base"), "the recorded renderer bytes are what the camera adapter compares");
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

test("D3DMetal resolves only the selected matched camera builtin without DXMT", t => {
  const f=fixture(t),Temporal=require("../src/modules/crossover/temporal"),graphicsRoot=path.join(f.root,"graphics");
  const providerRoot=path.join(graphicsRoot,"temporal/streamline");fs.cpSync(f.providerRoot,providerRoot,{recursive:true});
  const metadataFile=path.join(providerRoot,"provider.json"),metadata=JSON.parse(fs.readFileSync(metadataFile));
  const cameraBridge={name:"maclauncher-temporal-camera",architecture:"x86_64",windows:"x86_64-windows/maclauncher-temporal-camera.dll",unix:"x86_64-unix/maclauncher-temporal-camera.so",files:{}};
  for(const relative of [cameraBridge.windows,cameraBridge.unix]){const file=path.join(providerRoot,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,relative);cameraBridge.files[relative]=sha(relative);}
  fs.writeFileSync(metadataFile,JSON.stringify({...metadata,cameraBridge}));
  fs.unlinkSync(f.target);fs.writeFileSync(f.target,pe());
  const exe=path.join(f.gameRoot,"game.exe"),bytes=pe();bytes.writeUInt16LE(2,0x96);bytes.writeUInt16LE(3,0x98+68);fs.writeFileSync(exe,bytes);
  const entry={gamePath:f.gameRoot,runtimeData:{crossover:{sourceRoot:f.gameRoot,windowsExecutablePath:exe,executableArchitecture:"x86_64",detectionComplete:true}}};
  const options={runtimeId:"crossover",root:graphicsRoot,install:{crossoverRoot:path.join(f.root,"vendor")},settings:{dlss:true,graphicsBackend:"d3dmetal"},host:{platform:"darwin",hardwareArch:"arm64",macOSVersion:"26.0"}};
  const plan=Temporal.resolvePlan(entry,{},options);assert.equal(plan.kind,"d3dmetal-camera");assert.equal(plan.dxmt,undefined);assert.equal(plan.helper.name,cameraBridge.name);
  assert.equal(Temporal.resolvePlan(entry,{}, {...options,settings:{dlss:false,graphicsBackend:"d3dmetal"}}),null);
  assert.equal(Temporal.resolvePlan(entry,{}, {...options,runtimeId:"sikarugir"}),null);
  fs.writeFileSync(path.join(providerRoot,cameraBridge.unix),"changed");assert.equal(Temporal.resolvePlan(entry,{},options),null);
});
