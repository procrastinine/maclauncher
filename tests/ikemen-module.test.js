const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/ikemen/main");
const { inspectGame, readInfo } = require("../src/modules/ikemen/inspect");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ikemen-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function game(root, version = "1.1") {
  for (const name of ["data", "chars", "stages"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "system.def"), `[Info]\nmugenversion = ${version}\nversiondate = 2026,10,08\n[Files]\nselect = select.def\n`);
  fs.writeFileSync(path.join(root, "data", "select.def"), "[Characters]\nkfm\n[ExtraStages]\n");
  return Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
}
function runtime(root) {
  fs.mkdirSync(path.join(root, "external", "script"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "external", "script", "main.lua"), "selected runtime script");
  fs.writeFileSync(path.join(root, "data", "common.const"), "runtime default");
  const executablePath = path.join(root, "Ikemen_GO"); fs.writeFileSync(executablePath, "native fixture", { mode: 0o755 });
  return { source: "local", executablePath, binarySha256: require("../src/modules/shared/runtime/local-native").hashFile(executablePath), version: "1.0.0" };
}

test("Ikemen detects complete MUGEN layouts and rejects arbitrary DEF files", t => {
  const root = temporary(t), detected = game(root);
  assert.equal(detected.moduleId, "ikemen"); assert.equal(detected.moduleData.motifRelative, path.join("data", "system.def"));
  assert.equal(detected.moduleData.mugenVersion, "1.1"); assert.equal(detected.moduleData.detectedVersionConfidence, "declared");
  assert.equal(detected.moduleData.contentVersion, "2026,10,08");
  fs.writeFileSync(path.join(root, "data", "system.def"), "[Info]\nnot a motif");
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
});

test("Ikemen detects app distributions through sibling assets and confines motif paths", t => {
  const root = temporary(t); game(root);
  const app = path.join(root, "I.K.E.M.E.N-Go.app"); fs.mkdirSync(app);
  const detected = Module.detectGame({ inputPath: app, rootDir: app, isAppBundle: true, stat: fs.statSync(app) });
  assert.equal(detected.contentRootDir, root);
  fs.writeFileSync(path.join(root, "data", "mugen.cfg"), "[Options]\nmotif = ../../other/system.def\n");
  assert.equal(require("../src/modules/ikemen/detect").validMotif(root, "../outside.def"), null);
});

test("Ikemen version inspector reads Info declarations and detects future requirements", t => {
  const root = temporary(t); game(root, "2.0");
  const info = readInfo(path.join(root, "data", "system.def")); assert.equal(info.mugenVersion, "2.0");
  const inspected = inspectGame(root, "data/system.def");
  assert.equal(inspected.compatibility, "requires-newer-runtime"); assert.equal(inspected.unsupported.length, 1);
  fs.writeFileSync(path.join(root, "data", "system.def"), "[Info]\nname=fixture\n[Files]\n");
  assert.equal(inspectGame(root, "data/system.def").compatibility, "unknown");
  fs.writeFileSync(path.join(root, "data", "system.def"), "[Info]\nikemenversion=nightly\n[Files]\n");
  assert.equal(inspectGame(root, "data/system.def").compatibility, "unknown-declaration");
});

test("Ikemen stages selected engine defaults and original content without patching source, preserving saves across runtime restaging", t => {
  const root = temporary(t), gameRoot = path.join(root, "source"), runtimeRoot = path.join(root, "runtime");
  const entry = { ...game(gameRoot), gameId: "fixture" };
  const install = runtime(runtimeRoot), context = { userDataDir: path.join(root, "data") };
  fs.mkdirSync(path.join(gameRoot, "external", "script"), { recursive: true });
  fs.writeFileSync(path.join(gameRoot, "external", "script", "main.lua"), "foreign script");
  const staged = Module.__test.prepareLaunch(entry, context, install);
  assert.equal(fs.readFileSync(path.join(staged.wrapper, "external", "script", "main.lua"), "utf8"), "selected runtime script");
  assert.equal(fs.readFileSync(path.join(staged.wrapper, "data", "common.const"), "utf8"), "runtime default");
  assert.equal(fs.readFileSync(path.join(staged.wrapper, "data", "system.def"), "utf8"), fs.readFileSync(path.join(gameRoot, "data", "system.def"), "utf8"));
  fs.writeFileSync(path.join(staged.saveRoot, "config.ini"), "keep this save");
  fs.writeFileSync(install.executablePath, "changed native fixture");
  const next = Module.__test.prepareLaunch(entry, context, { ...install, binarySha256: require("../src/modules/shared/runtime/local-native").hashFile(install.executablePath) });
  assert.equal(fs.readFileSync(path.join(next.saveRoot, "config.ini"), "utf8"), "keep this save");
  assert.equal(fs.existsSync(path.join(gameRoot, "save")), false);
});

test("Ikemen launches a selected original complete distribution without a private view or legacy changes", async t => {
  const root = temporary(t), gameRoot = path.join(root, "source"), entry = { ...game(gameRoot), gameId: "original" };
  const install = runtime(gameRoot), userDataDir = path.join(root, "data");
  const old = path.join(userDataDir, "games", entry.gameId, "modules", "ikemen", "game");fs.mkdirSync(old,{recursive:true});
  fs.writeFileSync(path.join(old,"player-state.json"),"old private state");
  const selectionCalls=[];
  let selection={ready:true,install};
  t.mock.method(Module.runtimeManagers[0],"resolveSelection",(...args)=>{selectionCalls.push(args);return selection;});
  const context={userDataDir};
  const originalSave=path.join(gameRoot,"save"),privateSave=path.join(path.dirname(old),"saves");
  entry.defaultSaveDir=privateSave;
  assert.equal(Module.resolveSaveLocations(entry,context).primaryDirectory,originalSave,"stale private default must not drive save UI before Play");
  assert.equal(selectionCalls.at(-1)[3].verification,"status");
  Module.onImport(entry,context);assert.equal(entry.defaultSaveDir,originalSave);
  entry.defaultSaveDir=privateSave;
  Module.onRuntimeChange(entry,context);assert.equal(entry.defaultSaveDir,originalSave);
  assert.equal(Module.resolveSaveLocations({...entry,saveDirOverride:originalSave},context).primaryDirectory,originalSave);
  assert.equal(Module.resolveSaveLocations({...entry,saveDirOverride:path.join(root,"override")},context).primaryDirectory,privateSave);
  selection={ready:false};
  assert.equal(Module.resolveSaveLocations(entry,context).primaryDirectory,privateSave);
  selection={ready:true,install:{...install,executablePath:path.join(root,"separate-runtime","runner")}};
  assert.equal(Module.resolveSaveLocations(entry,context).primaryDirectory,privateSave);
  selection={ready:true,install};
  assert.equal(fs.existsSync(path.join(gameRoot,"save")),false);
  assert.deepEqual(fs.readdirSync(path.dirname(old)),["game"],"save presentation must not create private directories");
  let call;
  await Module.launchRuntime("ikemen",entry,{userDataDir,runtimeSettings:{},spawnDetachedChecked:async(...args)=>{call=args;return {};}});
  assert.equal(call[0],install.executablePath);assert.equal(call[2].cwd,gameRoot);
  assert.deepEqual(call[1],["-r",path.join("data","system.def")]);
  assert.equal(entry.defaultSaveDir,path.join(gameRoot,"save"));
  assert.equal(fs.readFileSync(path.join(old,"player-state.json"),"utf8"),"old private state");
  assert.deepEqual(fs.readdirSync(path.dirname(old)),["game"]);
  assert.equal(fs.existsSync(path.join(gameRoot,"save")),false,"upstream creates its own save folders");
  const independent=Module.__test.prepareLaunch({...entry,gameId:"fresh"},{userDataDir:path.join(root,"fresh-data")},install);
  assert.equal(independent.originalPaths,true);assert.equal(fs.existsSync(path.join(root,"fresh-data")),false);
  const macos=path.join(gameRoot,"Engine.app","Contents","MacOS");fs.mkdirSync(macos,{recursive:true});
  const appExecutable=path.join(macos,"runner");fs.writeFileSync(appExecutable,"original app runner");
  const appLaunch=Module.__test.prepareLaunch(entry,{}, {...install,executablePath:appExecutable});
  assert.equal(appLaunch.executablePath,appExecutable);assert.equal(appLaunch.wrapper,gameRoot);
  assert.throws(()=>Module.__test.prepareLaunch({...entry,saveDirOverride:path.relative(process.cwd(),path.join(gameRoot,"save"))},{},install),/must be absolute/);
});

test("Ikemen stages an unchanged Mac app beside game assets and detects copied executable damage", t => {
  const root = temporary(t), gameRoot = path.join(root, "source"), runtimeRoot = path.join(root, "runtime");
  const entry = { ...game(gameRoot), gameId: "app-fixture" };
  runtime(runtimeRoot);
  const app = path.join(runtimeRoot, "Engine.app"), macos = path.join(app, "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  const executablePath = path.join(macos, "runner"); fs.writeFileSync(executablePath, "native app fixture");
  const frameworks = path.join(app, "Contents", "Frameworks"); fs.mkdirSync(frameworks);
  fs.writeFileSync(path.join(frameworks, "dependency.dylib"), "dependency bytes");
  const install = { source: "download", installDir: runtimeRoot, version: "1.0.0", executablePath,
    binarySha256: require("../src/modules/shared/runtime/local-native").hashFile(executablePath) };
  const staged = Module.__test.prepareLaunch(entry, { userDataDir: path.join(root, "data") }, install);
  assert.equal(path.relative(staged.wrapper, staged.executablePath), path.join("Engine.app", "Contents", "MacOS", "runner"));
  assert.equal(fs.readFileSync(path.join(staged.wrapper, "Engine.app", "Contents", "Frameworks", "dependency.dylib"), "utf8"), "dependency bytes");
  fs.writeFileSync(staged.executablePath, "changed owned copy");
  assert.throws(() => Module.__test.prepareLaunch(entry, { userDataDir: path.join(root, "data") }, install), /changed/);
  assert.equal(fs.readFileSync(executablePath, "utf8"), "native app fixture");
});

test("Ikemen rejects content requiring a newer runner before staging", t => {
  const root = temporary(t), gameRoot = path.join(root, "source"), runtimeRoot = path.join(root, "runtime");
  const entry = { ...game(gameRoot, "2.0"), gameId: "fixture" };
  assert.throws(() => Module.__test.prepareLaunch(entry, { userDataDir: path.join(root, "data") }, runtime(runtimeRoot)), /newer MUGEN/);
});

test("Ikemen automatic preparation aliases a unique moved resource while preserving authored paths and managed configuration", t => {
  const root = temporary(t), gameRoot = path.join(root, "source"), runtimeRoot = path.join(root, "runtime");
  const entry = { ...game(gameRoot), gameId: "resource-repair" }, install = runtime(runtimeRoot);
  fs.mkdirSync(path.join(gameRoot, "data", "moved")); fs.mkdirSync(path.join(gameRoot, "save"));
  fs.writeFileSync(path.join(gameRoot, "data", "moved", "gofx.snd"), "sound asset");
  fs.writeFileSync(path.join(gameRoot, "data", "gofx.def"), "[Files]\nsnd = gofx.snd ; relocated resource\n");
  fs.writeFileSync(path.join(gameRoot, "save", "config.ini"), "author defaults");
  const context = { userDataDir: path.join(root, "data") };
  const before = Module.__test.prepareLaunch(entry, context, install);
  assert.equal(fs.readFileSync(path.join(before.wrapper, "data", "gofx.snd"), "utf8"), "sound asset");
  assert.equal(fs.readFileSync(path.join(before.saveRoot, "config.ini"), "utf8"), "author defaults");
  fs.writeFileSync(path.join(before.saveRoot, "config.ini"), "player configuration");
  const repaired = Module.__test.prepareLaunch(entry, context, install);
  assert.equal(fs.readFileSync(path.join(repaired.wrapper, "data", "gofx.snd"), "utf8"), "sound asset");
  assert.equal(fs.readFileSync(path.join(repaired.saveRoot, "config.ini"), "utf8"), "player configuration");
  assert.equal(fs.existsSync(path.join(gameRoot, "data", "gofx.snd")), false);
  assert.equal(fs.readFileSync(path.join(gameRoot, "save", "config.ini"), "utf8"), "author defaults");
});

test("Ikemen resource repair leaves ambiguous assets and traversal references unresolved", t => {
  const root = temporary(t), data = path.join(root, "data");
  for (const name of ["first", "second"]) { fs.mkdirSync(path.join(data, name), { recursive: true }); fs.writeFileSync(path.join(data, name, "effect.snd"), name); }
  fs.writeFileSync(path.join(data, "effect.def"), "[Files]\nsnd=effect.snd\nair=../../escaped.air\n");
  assert.deepEqual(Module.__test.repairAssetPaths(root), []);
  assert.equal(fs.existsSync(path.join(data, "effect.snd")), false);
});

test("Ikemen Play preflights version requirements before installing", t => {
  const root = temporary(t), entry = game(root), context = { userDataDir: path.join(root, "data"), settings: {} };
  const request = Module.ensureRuntime(entry, context);
  assert.equal(request.managerId, "ikemen"); assert.equal(request.version, null);assert.equal(request.discoveryRequired, true);assert.equal(request.selectionRequired, undefined); assert.deepEqual(request.installOptions, {});
  fs.writeFileSync(path.join(root, "data", "system.def"), "[Info]\nmugenversion=2.0\n[Files]\nselect=select.def\n");
  assert.throws(() => Module.ensureRuntime(entry, context), /newer MUGEN/);
});

test("Ikemen current overlay aliases new 3D resources and preserves existing player copies", t => {
  const root = temporary(t), source = path.join(root, "source"), managed = path.join(root, "managed"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "stage.glb"), "large immutable 3D model");
  fs.writeFileSync(path.join(source, "settings.json"), "author settings");
  require("../src/modules/shared/game-overlay").syncOverlay({ destination: managed, recordPath: path.join(root, "game-files.json"), layers: [{ source }], ...Module.__test.overlayRules });
  const model = path.join(managed, "stage.glb"); assert.equal(fs.lstatSync(model).isSymbolicLink(), true);
  fs.rmSync(model); fs.copyFileSync(path.join(source, "stage.glb"), model);
  fs.writeFileSync(path.join(managed, "settings.json"), "player settings");
  require("../src/modules/shared/game-overlay").syncOverlay({ destination: managed, recordPath: path.join(root, "game-files.json"), layers: [{ source }], ...Module.__test.overlayRules });
  assert.equal(fs.lstatSync(model).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(model, "utf8"), "large immutable 3D model");
  assert.equal(fs.readFileSync(path.join(managed, "settings.json"), "utf8"), "player settings");
  fs.rmSync(model); fs.writeFileSync(model, "custom player model");
  require("../src/modules/shared/game-overlay").syncOverlay({ destination: managed, recordPath: path.join(root, "game-files.json"), layers: [{ source }], ...Module.__test.overlayRules });
  assert.equal(fs.readFileSync(model, "utf8"), "custom player model");
});

test("Ikemen discovery declares the CPU before any runtime download and leaves the macOS floor to the executable", async t => {
  const Github = require("../src/modules/shared/runtime/github-releases");
  const manager = require("../src/modules/ikemen/runtime/manager");
  const userDataDir = temporary(t);
  t.mock.method(Github, "fetchGithubReleases", async () => ["1.0.0", "0.99.0"].map(version => ({ tag_name: `v${version}`,
    assets: [{ name: `Ikemen_GO_v${version}-macos.zip`, browser_download_url: `https://github.com/ikemen-engine/Ikemen-GO/releases/download/v${version}/Ikemen_GO_v${version}-macos.zip`, digest: `sha256:${"a".repeat(64)}` }] })));
  t.mock.method(Github, "fetchGithubTags", async () => ["1.0.0", "0.99.0"].map(version => ({ name: `v${version}`, commit: { sha: "b".repeat(40) } })));
  await manager.refreshCatalog({ userDataDir, force: true });
  const pins = manager.core.listCatalog({ userDataDir });
  assert.equal(pins.find(pin => pin.version === "1.0.0").minimumMacOS, undefined);
  assert.equal(pins.find(pin => pin.version === "1.0.0").architecture, "arm64");
  await manager.refreshCatalog({ userDataDir, force: true, architecture: "x64" });
  const intelPins = require("../src/modules/shared/runtime/architecture").withArchitecture("x64", () => manager.core.listCatalog({ userDataDir }));
  assert.equal(intelPins.find(pin => pin.version === "0.99.0").architecture, "x64");
});
