const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const Models = require("../src/modules/shared/reshade/neural/models"), Sources = require("../src/modules/shared/reshade/neural/model-sources");
const Manager = require("../src/modules/shared/reshade/runtime/neural-models-manager"), Imports = require("../src/modules/shared/reshade/imports");
const Zip = require("../src/modules/shared/runtime/zip"), {writeZipArchive} = require("./helpers/zip-fixture");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "neural-model-sources-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), app = path.join(root, "Reconstruction.app"), prefix = "Reconstruction.app/Contents/Resources/models/Any Name.dlssmodel/";
  const weights = Buffer.alloc(128 << 10, 7), manifest = {schemaVersion: 1, identifier: "org.example.source", architecture: "mlxdlss.neural-rendering-transformer.v1",
    inputs: [{name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16]}],
    outputs: [{name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4]}], state: {kind: "stateless"},
    weights: {file: "weights.safetensors", sha256: crypto.createHash("sha256").update(weights).digest("hex"),
      tensors: [{name: "test", dataType: "float16", shape: [1]}]}};
  const entries = [{name: prefix + "manifest.json", data: JSON.stringify(manifest)}, {name: prefix + manifest.weights.file, data: weights},
    {name: "Reconstruction.app/Contents/Resources/NOTICE", data: "Original model terms apply."},
    {name: "Reconstruction.app/Contents/MacOS/never-executed", data: "unrelated executable"},
    {name: "Reconstruction.app/Contents/Resources/models/unrelated-fp8.safetensors", data: "unused model"}];
  for (const row of entries) { const file = path.join(root, row.name);fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, row.data); }
  const archive = path.join(root, "Download.zip");writeZipArchive(archive, entries.map(row => ({...row, deflate: true})));fs.mkdirSync(userDataDir);
  return {root, userDataDir, app, archive, prefix, manifest, weights, entries};
}
test("adding notices to an active deduplicated neural version requires its own mutation lease", async t => {
  const f = fixture(t), bare = path.join(f.root, f.prefix.replace(/\/$/, '')), first = await Models.importModel({ userDataDir: f.userDataDir, runtimePath: bare });
  const { withRuntimeUse, instrumentRuntimeManagers } = require('../src/core/coordinated-runtime-managers');
  const manager = { ...Manager };instrumentRuntimeManagers([manager]);
  const receipt = path.join(first.installDir, 'source.json');assert.equal(fs.existsSync(receipt), false);
  await withRuntimeUse(Models.identityForPath(f.userDataDir, first.modelPath), async use => {
    await use.bind(process.pid);
    await assert.rejects(manager.importRuntime({ userDataDir: f.userDataDir, runtimePath: f.archive }), { code: 'RUNTIME_IN_USE' });
    assert.equal(fs.existsSync(receipt), false);assert.equal(fs.existsSync(path.join(first.installDir, 'notices')), false);
    assert.deepEqual(fs.readFileSync(path.join(first.modelPath, 'weights.safetensors')), f.weights);
  }, { userDataDir: f.userDataDir });
  const reused = await manager.importRuntime({ userDataDir: f.userDataDir, runtimePath: f.archive });
  assert.equal(reused.version, first.version);assert.equal(Models.listInstalled(f.userDataDir).length, 1);
  assert.equal(fs.readFileSync(path.join(first.installDir, 'notices/0-NOTICE'), 'utf8'), 'Original model terms apply.');
});
test("app and ZIP model sources import declared packages through the shared manager without unrelated app resources", async t => {
  const f = fixture(t), catalog = Manager.getState({userDataDir: f.userDataDir}).catalog;
  assert.deepEqual(catalog.importExtensions, ["dlssmodel", "app", "zip"]);
  for (const runtimePath of [f.app, f.archive]) {
    assert.equal(Imports.kindForPath(runtimePath), "neural-model");
    const imported = await Manager.importRuntime({userDataDir: f.userDataDir, runtimePath});
    assert.deepEqual(fs.readdirSync(imported.modelPath).sort(), ["manifest.json", "weights.safetensors"]);
    assert.deepEqual(fs.readFileSync(path.join(imported.modelPath, "weights.safetensors")), f.weights);
    assert.equal(fs.readFileSync(path.join(imported.installDir, "notices/0-NOTICE"), "utf8"), "Original model terms apply.");
    assert.ok(!fs.existsSync(path.join(imported.installDir, "Contents")));
    assert.equal(Models.listInstalled(f.userDataDir).length, 1, "identical source packages deduplicate");
  }
  assert.ok(fs.readdirSync(path.join(f.userDataDir, "runtimes", Models.ID)).every(name => !name.startsWith(".")));
  assert.equal(fs.readFileSync(path.join(f.app, "Contents/MacOS/never-executed"), "utf8"), "unrelated executable");
});
test("graphics-first recognition preserves unrelated apps, archives and failed mixed imports", async t => {
  const f = fixture(t), game = path.join(f.root, "Game.app"), gameZip = path.join(f.root, "Game.zip");
  fs.mkdirSync(game);writeZipArchive(gameZip, [{name: "Game.app/Contents/Resources/models/raw.bin", data: "raw weights"}]);
  assert.equal(Imports.kindForPath(game), null);assert.equal(Imports.kindForPath(gameZip), null);
  const unrelatedPackage = path.join(f.root, "Other.app/Contents/Resources/models/Unsupported.dlssmodel");
  fs.mkdirSync(unrelatedPackage, {recursive: true});fs.writeFileSync(path.join(unrelatedPackage, "manifest.json"), "{}");
  assert.equal(Imports.kindForPath(path.join(f.root, "Other.app")), null);
  const games = [], importer = Imports.createImporter({userDataDir: f.userDataDir, importGame: file => games.push(file),
    importModel: runtimePath => Models.importModel({userDataDir: f.userDataDir, runtimePath})});
  const broken = path.join(f.root, "Broken.zip");writeZipArchive(broken, f.entries.map(row => row.name.endsWith("weights.safetensors") ? {...row, data: Buffer.alloc(f.weights.length, 8)} : row));
  const results = await Promise.allSettled([importer(game), importer(f.app), importer(broken), importer(gameZip)]);
  assert.deepEqual(results.map(row => row.status), ["fulfilled", "fulfilled", "rejected", "fulfilled"]);
  assert.match(results[2].reason.message, /checksum/);assert.deepEqual(games, [game, gameZip]);
  assert.equal(Models.listInstalled(f.userDataDir).length, 1);
});
test("standalone model archives are supported while unsafe model entries and oversized inflation fail without publication", async t => {
  const f = fixture(t), standalone = path.join(f.root, "Model.zip");
  const entries = f.entries.slice(0, 2).map(row => ({...row, name: "Folder/Model.dlssmodel/" + path.posix.basename(row.name)}));
  writeZipArchive(standalone, entries);
  assert.equal(Sources.inspect(standalone).packages.length, 1);
  assert.ok((await Models.importModel({userDataDir: f.userDataDir, runtimePath: standalone})).ready);
  const unsafe = path.join(f.root, "Unsafe.zip");writeZipArchive(unsafe, [...entries, entries[0]]);
  assert.equal(Sources.recognizes(unsafe), false);
  const traversal = path.join(f.root, "Traversal.zip");writeZipArchive(traversal, entries.map(row => ({...row, name: "../" + row.name})));
  assert.equal(Sources.recognizes(traversal), false);
  const bomb = path.join(f.root, "False-size.zip");writeZipArchive(bomb, [{name: "large", data: Buffer.alloc(4096), deflate: true}]);
  const archive = Zip.readZipEntries(bomb), fd = fs.openSync(bomb, "r");let row;
  try { row = Zip.readCentralDirectory(fd, archive.info, {metadata: true})[0]; } finally { fs.closeSync(fd); }
  const destination = path.join(f.root, "bounded");
  await assert.rejects(Zip.extractZipEntry(bomb, {...row, uncompressedSize: 16}, destination, {maxOutputBytes: 16}), /expanded size limit/);
  assert.equal(fs.existsSync(destination), false);
});
test("archive cancellation removes source extraction and partial managed copies", async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(Models.importModel({userDataDir: f.userDataDir, runtimePath: f.archive, signal: controller.signal,
    onProgress: () => controller.abort()}), {name: "AbortError"});
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);
  assert.deepEqual(fs.readdirSync(path.join(f.userDataDir, "runtimes", Models.ID)), []);
});
test("the ordinary model picker manages local packages and app sources once, preserving cancellation", async t => {
  const f = fixture(t), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8"), start = source.indexOf("async function pickEffectFile("),
    end = source.indexOf("async function saveGameReShade(", start), imported = [];
  let picked = {canceled: true, filePaths: []};
  const context = {require: require("node:module").createRequire(require.resolve("../src/main/main")), fs, userDataDir: f.userDataDir,
    getLauncherDialogOwner: () => null, ReShadeFilters: require("../src/modules/shared/reshade/filter-library"),
    dialog: {showOpenDialog: async options => { assert.deepEqual([...options.filters[0].extensions], ["dlssmodel", "app", "zip"]);return picked; }},
    importNeuralModelFile: async runtimePath => { imported.push(runtimePath);return Models.importModel({userDataDir: f.userDataDir, runtimePath}); }};
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(await context.pickEffectFile("neural-model"), null);assert.deepEqual(imported, []);
  picked = {canceled: false, filePaths: [f.app]};
  const managed = await context.pickEffectFile("neural-model");
  assert.equal(managed, Models.listInstalled(f.userDataDir)[0].modelPath);assert.deepEqual(imported, [f.app]);
  picked = {canceled: false, filePaths: [path.join(f.root, f.prefix)]};
  assert.equal(await context.pickEffectFile("neural-model"), managed);
  assert.deepEqual(imported, [f.app, fs.realpathSync(path.join(f.root, f.prefix))]);
  picked = {canceled: false, filePaths: [managed]};
  assert.equal(await context.pickEffectFile("neural-model"), managed);
  assert.equal(imported.length, 2, "an existing managed package is reused without another import");
  assert.equal(Models.listInstalled(f.userDataDir).length, 1);
});
test("offline video's local source picker uses the same managed model import", async t => {
  const f = fixture(t), input = path.join(f.root, "clip.mp4"), output = path.join(f.root, "processed.mp4");fs.writeFileSync(input, "source video");
  const context = {userDataDir: f.userDataDir, ui: {dialog: {showOpenDialog: async () => ({filePaths: [f.archive]}),
    showSaveDialog: async () => ({filePath: output})}}};
  const result = await require("../src/modules/video/tools").processVideo({gamePath: input}, {}, context, {processVideo: async options => {
    assert.notEqual(options.modelPath, f.archive);assert.equal(Models.listInstalled(f.userDataDir)[0].modelPath, options.modelPath);
    return {output: options.output};
  }});
  assert.equal(result.output, output);assert.equal(fs.readFileSync(input, "utf8"), "source video");
});
