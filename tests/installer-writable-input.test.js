const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const Inno = require("../src/modules/shared/installers/inno");
const Header = require("../src/modules/shared/installers/inno-header");
const Writable = require("../src/modules/shared/writable-input");
const Modules = require("../src/modules/registry");
const { createLauncher } = require("../src/core/launcher");
const { createGameMetadataService } = require("../src/core/game-metadata");
const { createSaveService } = require("../src/core/save-service");
const GameStore = require("../src/core/game-store");
const Storage = require("../src/modules/shared/mvmz/storage-patch");
const Snapshots = require("../src/modules/shared/save-snapshots");
const Renpy = require("../src/modules/renpy/main");
const Inputs = require("../src/modules/shared/installers");
const { createBackendOperations } = require("../src/core/backend-operations");

function loader() {
  const bytes = Buffer.alloc(256); bytes.write("MZ");
  bytes.writeUInt32LE(0x6f6e6e49, 0x30); bytes.writeUInt32LE(64, 0x34); bytes.writeUInt32LE(~64 >>> 0, 0x38);
  Buffer.from("72446c507453cde6d77b0b2a", "hex").copy(bytes, 64);
  bytes.writeUInt32LE(1, 76); bytes.writeUInt32LE(128, 96); bytes.writeUInt32LE(224, 100);
  bytes.writeUInt32LE(Header.crc32(bytes.subarray(64, 104)), 104);
  bytes.write("Inno Setup Setup Data (5.5.7) (u)", 128); return bytes;
}
function tree(root) {
  const values = [];
  function visit(dir) { for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    values.push([path.relative(root, file), stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "directory"]);
    if (stat.isDirectory()) visit(file);
  } }
  visit(root); return values;
}
async function fixture(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-direct-input-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "setup.exe"), userDataDir = path.join(root, "data"), tool = path.join(root, "reader.cjs");
  fs.writeFileSync(file, loader());
  const payload = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]));
  const metadata = { schemaVersion: 1, helperVersion: "fixture-v1", sourceRevision: "a".repeat(40), format: "inno", formatVersion: "5.5.7 (unicode)",
    headerOffset: 128, dataOffset: 224, externalData: false, encrypted: false, requiredSlices: [],
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, authoredPath: "{app}\\" + name.replaceAll("/", "\\"), size: Buffer.byteLength(bytes), location: 0 })) };
  fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(root, "payload.json"), JSON.stringify(payload));
  fs.writeFileSync(tool, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(path.join(__dirname,'calls'),process.argv[2]+'\\n');
if(process.argv[2]==='--inspect-json')console.log(fs.readFileSync(path.join(__dirname,'metadata.json'),'utf8'));
else {const root=process.argv[process.argv.indexOf('--output-dir')+1];for(const [name,bytes] of Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname,'payload.json'))))){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(bytes,'base64'));}}
`, { mode: 0o755 });
  const helper = { version: metadata.helperVersion, sourceRevision: metadata.sourceRevision, identity: "b".repeat(64), inspector: tool, executable: tool };
  const options = { userDataDir, gameId: "installer-game", helper };
  const extracted = await Inno.prepareInstaller(file, options);
  return { root, file, userDataDir, helper, options, extracted,
    calls: () => fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n") };
}
function webFiles(engine) {
  const mod = Modules.getModule(engine);
  return {
    "www/index.html": "<html><script src='js/main.js'></script></html>",
    ["www/js/" + (engine === "mv" ? "rpg_core.js" : "rmmz_core.js")]: "// engine core\n",
    "www/js/main.js": engine === "mv" ? "PluginManager.setup($plugins);\n" : "const scriptUrls = [\n  'js/plugins.js',\n];\n",
    "www/js/plugins.js": "var $plugins = [];\n",
    "www/img/asset.bin": Buffer.alloc(256 * 1024, 9),
    "www/data/System.json": JSON.stringify({ gameTitle: "Fixture" }),
    ["www/save/file1." + (engine === "mv" ? "rpgsave" : "rmmzsave")]: mod.save.encode('{"chapter":1}')
  };
}

for (const engine of ["mv", "mz"]) test(`${engine}: script/plugin patches and edited portable saves survive a warm original-installer retry`, async t => {
  const f = await fixture(t, webFiles(engine));
  const launcher = createLauncher({ userDataDir: f.userDataDir, logger: {}, inputPreparation: (input, options) =>
    Inno.prepareInstaller(input, { ...options, helper: f.helper }) });
  const entry = await launcher.resolveEntry(f.file), canonical = [entry.gameId, entry.gamePath, entry.importPath, entry.contentRootDir, entry.indexHtml];
  assert.equal(entry.moduleId, engine); assert.equal(entry.gameId, f.options.gameId);
  const mod = Modules.getModule(engine), input = Writable.runtimeEntry(entry);
  assert.equal(input, entry);
  assert.equal(input.contentRootDir, f.extracted.inputPath);
  assert.equal(entry.moduleData?.writableInput, undefined);
  assert.equal(fs.lstatSync(path.join(input.indexDir, "js/main.js")).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(input.indexDir, "img/asset.bin")).isSymbolicLink(), false);
  assert.equal(input.indexDir, path.join(f.extracted.inputPath, "www"));
  assert.equal(mod.cheats.patcher.patchGame(entry).patched, true);
  assert.equal((await launcher.runAction(entry, "refreshDecryptionStatus")).sourcePath, entry.contentRootDir);
  await launcher.runAction(entry, "installSaveSlotsPlugin");
  assert.match(fs.readFileSync(path.join(input.indexDir, "js/plugins.js"), "utf8"), /CustomizeMaxSaveFile/);
  const storage = { isLocalMode: () => false, localFileDirectoryPath: () => "wrong", fileDirectoryPath: () => "wrong",
    save(_id, bytes) { fs.writeFileSync(path.join(this.localFileDirectoryPath(), "file2.rpgsave"), bytes); },
    saveZip(_id, bytes) { fs.writeFileSync(path.join(this.fileDirectoryPath(), "file2.rmmzsave"), bytes); } };
  vm.runInNewContext(Storage.buildStoragePatchScript(engine, entry.defaultSaveDir), { window: { StorageManager: storage }, console, setTimeout: () => assert.fail("Storage should be ready") });
  storage[engine === "mv" ? "save" : "saveZip"](2, mod.save.encode('{"chapter":2}'));
  const fileName = "file2." + (engine === "mv" ? "rpgsave" : "rmmzsave"), service = launcher.saveService;
  const document = await service.runAction(entry, "readSaveDocument", { fileName });
  assert.equal(document.json, '{"chapter":2}');
  await service.runAction(entry, "writeSaveDocument", { fileName, expectedHash: document.sourceHash, json: '{"chapter":3}' });
  assert.equal((await service.runAction(entry, "readSaveDocument", { fileName })).json, '{"chapter":3}');
  assert.equal(entry.defaultSaveDir, path.join(f.extracted.inputPath, "www/save"));
  assert.equal(mod.save.decode(fs.readFileSync(path.join(entry.defaultSaveDir, fileName), "utf8")), '{"chapter":3}');
  const patchedMain = fs.readFileSync(path.join(input.indexDir, "js/main.js")), prepared = tree(f.extracted.inputPath);
  t.mock.method(fs, "copyFileSync", () => assert.fail("Warm input resolution must not recopy files"));
  const retry = await launcher.resolveEntry(f.file);
  assert.deepEqual([retry.gameId, retry.gamePath, retry.importPath, retry.contentRootDir, retry.indexHtml], canonical);
  assert.equal(retry.moduleData?.writableInput, undefined);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "games", entry.gameId, "modules", engine, "writable-input")), false);
  assert.deepEqual(fs.readFileSync(path.join(Writable.runtimeEntry(retry).indexDir, "js/main.js")), patchedMain);
  assert.deepEqual(tree(f.extracted.inputPath), prepared); assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).containerData.cached, true);
});

test("read-only installer resolution keeps original content and portable save paths without a mirror", async t => {
  const f = await fixture(t, webFiles("mv"));
  const launcher = createLauncher({ userDataDir: f.userDataDir, logger: {}, inputPreparation: (input, options) =>
    Inno.prepareInstaller(input, { ...options, helper: f.helper }) });
  const before = tree(f.userDataDir), entry = await launcher.resolveEntry(f.file, { persist: false });
  assert.equal(entry.moduleData?.writableInput, undefined);
  assert.equal(entry.defaultSaveDir, path.join(f.extracted.inputPath, "www/save"));
  assert.equal(entry.contentRootDir, f.extracted.inputPath);
  assert.deepEqual(tree(f.userDataDir), before);
});

test("metadata import and cached refresh keep original paths and edited scripts", async t => {
  const f = await fixture(t, webFiles("mv")), service = createGameMetadataService({ userDataDir: f.userDataDir, registry: Modules,
    logger: {}, inputPreparation: (input, options) => Inno.prepareInstaller(input, { ...options, helper: f.helper }) });
  const entry = await service.importEntry(f.file, {}); GameStore.writeGameRecord(f.userDataDir, entry);
  assert.equal(entry.contentRootDir, f.extracted.inputPath);
  assert.equal(entry.indexHtml, path.join(f.extracted.inputPath, "www/index.html"));
  assert.equal(entry.moduleData?.writableInput, undefined);
  fs.writeFileSync(path.join(entry.indexDir, "js/main.js"), "original project modification");
  t.mock.method(fs, "copyFileSync", () => assert.fail("Metadata refresh must not recopy input"));
  const warm = await service.refreshEntry(entry, {});
  assert.equal(warm.gameId, entry.gameId); assert.equal(warm.contentRootDir, entry.contentRootDir);
  assert.equal(warm.moduleData?.writableInput, undefined);
  assert.equal(fs.readFileSync(path.join(warm.indexDir, "js/main.js"), "utf8"), "original project modification");
  assert.deepEqual(f.calls(), ["--inspect-json", "--extract"]);
});

test("backend patch actions edit the original project while status remains read-only", async t => {
  const f = await fixture(t, webFiles("mv")), before = tree(f.extracted.inputPath);
  t.mock.method(Inputs, "prepareInput", (input, options) => Inno.prepareInstaller(input, { ...options, helper: f.helper }));
  const operations = createBackendOperations({ userDataDir: f.userDataDir });
  const entry = await operations.importEntry(f.file, {}); GameStore.writeGameRecord(f.userDataDir, entry);
  const directory = path.join(f.userDataDir, "games", entry.gameId, "modules/mv/writable-input");
  assert.equal(entry.moduleData?.writableInput, undefined);
  assert.equal((await operations.patcher(entry, "cheats", "status")).patched, false);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(tree(f.extracted.inputPath), before);
  assert.equal((await operations.patcher(entry, "cheats", "patch")).patched, true);
  const saved = GameStore.readGameRecord(f.userDataDir, entry.gameId);
  assert.equal(saved.contentRootDir, f.extracted.inputPath);
  assert.equal(saved.indexHtml, path.join(f.extracted.inputPath, "www/index.html"));
  assert.equal(saved.moduleData?.writableInput, undefined);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(Modules.getModule("mv").getContentReadRoots(saved), []);
  assert.equal(Modules.getModule("mv").cheats.patcher.getPatchStatus(saved).patched, true);
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).containerData.cached, true);
});

test("explicit plugin asset replacement edits only the selected original asset and survives warm reuse", async t => {
  const f = await fixture(t, webFiles("mv")), entry = { gameId: f.options.gameId, moduleId: "mv", engine: "mv",
    gamePath: f.extracted.inputPath, contentRootDir: f.extracted.inputPath, indexDir: path.join(f.extracted.inputPath, "www"),
    indexHtml: path.join(f.extracted.inputPath, "www/index.html"), containerData: f.extracted.containerData };
  const mod = Modules.getModule("mv"), input = mod.prepareInput(entry, { userDataDir: f.userDataDir });
  const asset = path.join(input.indexDir, "img/asset.bin"), main = fs.readFileSync(path.join(input.indexDir, "js/main.js")), replacement = path.join(f.root, "replacement.bin");
  assert.equal(input, entry);
  fs.writeFileSync(replacement, "edited plugin asset");
  Writable.atomicCopy(replacement, asset, { root: input.contentRootDir });
  assert.equal(fs.lstatSync(asset).isSymbolicLink(), false); assert.equal(fs.readFileSync(asset, "utf8"), "edited plugin asset");
  mod.prepareInput(entry, { userDataDir: f.userDataDir });
  assert.equal(fs.readFileSync(asset, "utf8"), "edited plugin asset");
  assert.equal(asset, path.join(f.extracted.inputPath, "www/img/asset.bin"));
  assert.deepEqual(fs.readFileSync(path.join(input.indexDir, "js/main.js")), main);
  assert.equal(entry.moduleData?.writableInput, undefined);
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).containerData.cached, true);
});

test("MV explicit library replacement backs up and restores the selected original asset", async t => {
  const files = webFiles("mv"); files["www/js/libs/test.js.map"] = "original map";
  const f = await fixture(t, files), entry = { gameId: f.options.gameId, moduleId: "mv", engine: "mv", gamePath: f.extracted.inputPath,
    contentRootDir: f.extracted.inputPath, indexDir: path.join(f.extracted.inputPath, "www"), containerData: f.extracted.containerData };
  const mod = Modules.getModule("mv"), input = mod.prepareInput(entry, { userDataDir: f.userDataDir });
  const bundle = path.join(f.root, "library"), relPath = "js/libs/test.js.map";
  fs.mkdirSync(path.dirname(path.join(bundle, relPath)), { recursive: true }); fs.writeFileSync(path.join(bundle, relPath), "replacement map");
  t.mock.method(mod.libs.catalog, "listDependencies", () => [{ id: "test", engine: "mv" }]);
  t.mock.method(mod.libs.catalog, "getVersion", () => ({ id: "v1", files: [relPath], bundleRoot: bundle }));
  const main = fs.readFileSync(path.join(input.indexDir, "js/main.js"));
  assert.equal(input, entry);
  assert.equal(mod.libs.patcher.patchGame(entry, { selections: { test: "v1" } }).patched, true);
  assert.equal(fs.readFileSync(path.join(input.indexDir, relPath), "utf8"), "replacement map");
  assert.equal(fs.lstatSync(path.join(input.indexDir, relPath)).isSymbolicLink(), false);
  mod.libs.patcher.unpatchGame(entry);
  assert.equal(fs.readFileSync(path.join(input.indexDir, relPath), "utf8"), "original map");
  assert.deepEqual(fs.readFileSync(path.join(input.indexDir, "js/main.js")), main);
  assert.equal(entry.moduleData?.writableInput, undefined);
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).containerData.cached, true);
});

test("Ren'Py explicit patches, developer tools and portable saves use the original project", async t => {
  const f = await fixture(t, { "Game.sh": "#!/bin/sh\n", "Game.py": "# launcher\n", "game/options.rpy": 'define config.save_directory = ""\n',
    "game/script.rpy": "label start:\n    'Hello'\n", "game/script.rpyc": "original bytecode", "game/saves/1-1.save": "original save",
    "game/archive.rpa": Buffer.alloc(256 * 1024, 7), "lib/windows-x86_64/Game.exe": "Windows executable" });
  const entry = { gameId: f.options.gameId, moduleId: "renpy", engine: "renpy", runtimeId: "patched",
    gamePath: f.extracted.inputPath, importPath: f.file, contentRootDir: f.extracted.inputPath, containerData: f.extracted.containerData,
    moduleData: { baseName: "Game", version: "8.5.2", major: 8 } };
  const context = { userDataDir: f.userDataDir, settings: {}, logger: {}, confirmRuntimeInstall: async () => true }, input = Renpy.prepareInput(entry, context);
  assert.equal(input, entry);
  assert.equal(entry.moduleData.writableInput, undefined);
  const extractionRoot = path.join(f.userDataDir, "games", entry.gameId, "modules/renpy/extracted");
  fs.mkdirSync(extractionRoot, { recursive: true });
  require("../src/modules/renpy/extract").writeExtractionMeta(extractionRoot, { sourcePath: path.join(f.extracted.inputPath, "game"), extractedAt: 1 });
  assert.equal((await Renpy.actions.refreshExtractionStatus(entry, {}, context)).extractedReady, true);
  const sdk = path.join(f.root, "sdk"), lib = path.join(sdk, "lib/py3-mac-universal"); fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "renpy"), "Mac executable"); fs.writeFileSync(path.join(lib, "python"), "Mac Python");
  t.mock.method(Renpy.runtime.patchSdk, "preparePatchSdk", async () => ({ sdkRoot: sdk, sdkVersion: "8.5.2" }));
  assert.equal((await Renpy.actions.patch(entry, {}, context)).patched, true);
  assert.ok(fs.existsSync(path.join(input.contentRootDir, "lib/py3-mac-universal/Game")));
  await Renpy.actions.installRenpyConsole(entry, {}, context);
  assert.ok(fs.existsSync(path.join(input.contentRootDir, "game/zz_maclauncher_console.rpy")));
  const location = Renpy.resolveSaveLocations(entry, context);
  assert.equal(location.primaryDirectory, path.join(input.contentRootDir, "game/saves"));
  assert.ok(location.directories.some(item => item.directory === path.join(f.extracted.inputPath, "game/saves")));
  fs.writeFileSync(path.join(location.primaryDirectory, "1-1.save"), "updated save");
  fs.writeFileSync(path.join(input.contentRootDir, "game/script.rpyc"), "compiled output");
  assert.equal(fs.lstatSync(path.join(input.contentRootDir, "game/archive.rpa")).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(path.join(input.contentRootDir, "game/archive.rpa")), Buffer.alloc(256 * 1024, 7));
  const prepared = tree(f.extracted.inputPath);
  t.mock.method(fs, "copyFileSync", () => assert.fail("Warm Ren'Py inputs must not be recopied"));
  Renpy.prepareInput(entry, context);
  assert.equal(fs.readFileSync(path.join(location.primaryDirectory, "1-1.save"), "utf8"), "updated save");
  assert.equal(fs.readFileSync(path.join(input.contentRootDir, "game/script.rpyc"), "utf8"), "compiled output");
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).containerData.cached, true);
  assert.deepEqual(tree(f.extracted.inputPath), prepared);
});

test("RGSS saves stay in the original project while snapshots reject matching save aliases", async t => {
  const f = await fixture(t, { "Game.ini": "[Game]\nTitle=Fixture\n", "Game.rgss3a": "packed data", "Game.exe": "Windows executable",
    "Data/Actors.rvdata2": "database", "Save01.rvdata2": "original save" });
  const entry = { gameId: f.options.gameId, moduleId: "rgss", gamePath: f.extracted.inputPath,
    contentRootDir: f.extracted.inputPath, defaultSaveDir: f.extracted.inputPath, containerData: f.extracted.containerData, moduleData: {} };
  const mod = Modules.getModule("rgss"), input = mod.prepareInput(entry, { userDataDir: f.userDataDir });
  assert.equal(input, entry);
  assert.equal(entry.moduleData.writableInput, undefined);
  assert.equal(fs.lstatSync(path.join(input.contentRootDir, "Data/Actors.rvdata2")).isSymbolicLink(), false);
  const service = createSaveService({ userDataDir: f.userDataDir, registry: Modules });
  assert.deepEqual(service.listFiles(entry).map(item => item.name), ["Save01.rvdata2"]);
  fs.writeFileSync(path.join(input.contentRootDir, "Save02.rvdata2"), "new native save");
  assert.deepEqual(service.listFiles(entry).map(item => item.name), ["Save01.rvdata2", "Save02.rvdata2"]);
  const snapshot = service.createSnapshot(entry); assert.ok(snapshot.id);
  fs.writeFileSync(path.join(input.contentRootDir, "Save02.rvdata2"), "changed save");
  const preview = await service.runAction(entry, "previewSaveSnapshot", { snapshotId: snapshot.id });
  await service.runAction(entry, "restoreSaveSnapshot", { snapshotId: snapshot.id, expectedStateHash: preview.expectedStateHash });
  assert.equal(fs.readFileSync(path.join(input.contentRootDir, "Save02.rvdata2"), "utf8"), "new native save");
  assert.equal(fs.readFileSync(path.join(f.extracted.inputPath, "Save02.rvdata2"), "utf8"), "new native save");
  assert.equal(fs.readFileSync(path.join(f.extracted.inputPath, "Data/Actors.rvdata2"), "utf8"), "database");
  fs.symlinkSync(path.join(f.extracted.inputPath, "Save01.rvdata2"), path.join(input.contentRootDir, "Save03.rvdata2"));
  assert.throws(() => service.listFiles(entry), /symlink/);
  assert.throws(() => Snapshots.collectFiles(input.contentRootDir, { extensions: ["rvdata2"] }), /symlink/);
  fs.unlinkSync(path.join(input.contentRootDir, "Save03.rvdata2"));
  assert.equal((await Inno.prepareInstaller(f.file, f.options)).containerData.cached, true);
});

test("cancelled preparation is inert and direct preparation never walks or writes the project", async t => {
  const files = webFiles("mv"); for (let i = 0; i < 150; i++) files[`www/img/asset-${i}.bin`] = "original asset";
  const f = await fixture(t, files), before = tree(f.extracted.inputPath), mod = Modules.getModule("mv");
  const entry = { gameId: f.options.gameId, moduleId: "mv", engine: "mv", gamePath: f.extracted.inputPath,
    contentRootDir: f.extracted.inputPath, indexDir: path.join(f.extracted.inputPath, "www"), containerData: f.extracted.containerData };
  const controller = new AbortController(); controller.abort();
  const methods = ["readdirSync", "statSync", "lstatSync", "realpathSync", "existsSync", "readFileSync", "mkdirSync", "writeFileSync", "copyFileSync", "symlinkSync"];
  const mocks = methods.map(name => t.mock.method(fs, name, () => assert.fail(`Preparation must not call fs.${name}`)));
  try {
    assert.throws(() => mod.prepareInput(entry, { userDataDir: f.userDataDir, signal: controller.signal }), { name: "AbortError" });
    assert.equal(mod.prepareInput(entry, { userDataDir: f.userDataDir, onProgress: () => assert.fail("No asset traversal") }), entry);
    assert.deepEqual(Writable.contentReadRoots(entry), []);
  } finally { for (const mock of mocks) mock.mock.restore(); }
  assert.deepEqual(tree(f.extracted.inputPath), before);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "games", entry.gameId, "modules")), false);
});

test("direct preparation preserves selected path aliases and explicit save overrides without creating output", async t => {
  const f = await fixture(t, webFiles("mv")), mod = Modules.getModule("mv"), alias = path.join(f.root, "source-alias");
  fs.symlinkSync(f.extracted.inputPath, alias);
  const entry = { gameId: f.options.gameId, moduleId: "mv", engine: "mv", gamePath: alias,
    contentRootDir: alias, indexDir: path.join(alias, "www"), containerData: f.extracted.containerData,
    saveDirOverride: path.join(f.root, "chosen-saves") };
  const before = tree(f.extracted.inputPath), input = mod.prepareInput(entry, { userDataDir: path.join(alias, "output") });
  assert.equal(input, entry);
  assert.equal(input.contentRootDir, alias);
  assert.equal(input.saveDirOverride, path.join(f.root, "chosen-saves"));
  assert.equal(fs.existsSync(path.join(alias, "output")), false);
  assert.equal(fs.existsSync(entry.saveDirOverride), false);
  assert.deepEqual(tree(f.extracted.inputPath), before);
});

test("current input preparation never reads obsolete metadata or loads backcompat", t => {
  const Module = require("node:module"), load = Module._load;
  const file = require.resolve("../src/modules/shared/writable-input"), cached = require.cache[file];
  const preparations = [require("../src/modules/rgss/writable-input"), require("../src/modules/shared/mvmz/writable-input")];
  t.mock.method(Module, "_load", (request, ...args) => {
    assert.doesNotMatch(request, /(?:^|[/\\])backcompat(?:[/\\]|$)/, "Current input code must not load legacy readers");
    return load(request, ...args);
  });
  let current;
  try { delete require.cache[file]; current = require(file); }
  finally { require.cache[file] = cached; }
  const entry = {gameId: "current", gamePath: path.join(os.tmpdir(), "selected-game"), contentRootDir: path.join(os.tmpdir(), "current-project")};
  Object.defineProperty(entry, "moduleData", {get() { assert.fail("Current preparation must not inspect legacy metadata"); }});
  const mocks = ["lstatSync", "statSync", "readFileSync", "realpathSync", "existsSync", "mkdirSync", "readdirSync", "writeFileSync"]
    .map(name => t.mock.method(fs, name, () => assert.fail(`Current preparation must not call fs.${name}`)));
  try {
    assert.equal(current.sourceEntry(entry), entry); assert.equal(current.runtimeEntry(entry), entry);
    assert.equal(current.sourceRoot(entry), entry.contentRootDir);
    assert.equal(current.sourceRoot({gamePath: entry.gamePath}), entry.gamePath);
    assert.equal(Object.hasOwn(current, "legacyGameMirrors"), false);
    for (const preparation of preparations) assert.equal(preparation.prepareInput(entry, {}), entry);
  } finally { for (const mock of mocks) mock.mock.restore(); }
});
