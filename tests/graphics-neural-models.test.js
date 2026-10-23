const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Models = require("../src/modules/shared/reshade/neural/models");
const Neural = require("../src/modules/shared/reshade/neural");
const Manager = require("../src/modules/shared/reshade/runtime/neural-models-manager");
const { withRuntimeUse } = require("../src/core/coordinated-runtime-managers");
const {DownloadManager} = require("../src/modules/shared/runtime/download-manager");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "neural-models-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"); fs.mkdirSync(userDataDir);
  const runtimePath = path.join(root, "Reconstruction.dlssmodel"); fs.mkdirSync(runtimePath);
  const weights = Buffer.alloc(128 * 1024, 7), sha256 = crypto.createHash("sha256").update(weights).digest("hex");
  const manifest = { schemaVersion: 1, identifier: "org.example.reconstruction", architecture: "mlxdlss.neural-rendering-transformer.v1",
    inputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16] }],
    outputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4] }], state: { kind: "stateless" },
    weights: { file: "weights.safetensors", sha256, tensors: [{ name: "test", dataType: "float16", shape: [1] }] } };
  fs.writeFileSync(path.join(runtimePath, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(runtimePath, manifest.weights.file), weights);
  fs.writeFileSync(path.join(runtimePath, "unrelated.txt"), "not a model input");
  return { root, userDataDir, runtimePath, manifest, weights };
}
test("neural settings retain the useful unmasked blend range through full strength", () => {
  for (const intensity of [0, 0.5, 1]) assert.equal(Neural.settings({ intensity }).intensity, intensity);
  for (const intensity of [-0.01, 1.01, 2, NaN, Infinity]) assert.throws(() => Neural.settings({ intensity }), /0 to 1/);
});
test("local neural models are copied once, immutable and removable without changing original packages", async t => {
  const f = fixture(t);
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);
  assert.equal(Manager.getState({ userDataDir: f.userDataDir }).catalog.delivery, "local-files");
  assert.deepEqual(fs.readdirSync(f.userDataDir), [], "reading model state creates no files");
  const imported = await Manager.importRuntime(f);
  assert.ok(Models.validVersion(imported.version)); assert.notEqual(imported.modelPath, f.runtimePath);
  assert.deepEqual(fs.readdirSync(imported.modelPath).sort(), ["manifest.json", "weights.safetensors"]);
  assert.deepEqual(fs.readFileSync(path.join(imported.modelPath, "weights.safetensors")), f.weights);
  assert.equal(fs.statSync(path.join(imported.modelPath, "weights.safetensors")).mode & 0o222, 0);
  assert.equal((await Manager.importRuntime(f)).version, imported.version);
  assert.equal(Neural.listModels(f.userDataDir).length, 1);
  assert.equal(Neural.model(imported.modelPath), imported.modelPath);
  assert.deepEqual(Neural.modelIdentity(f.userDataDir, imported.modelPath), { managerId: Models.ID,
    sectionId: "default", version: imported.version, sourcePath: imported.installDir });
  const weightsFile = path.join(imported.modelPath, "weights.safetensors");
  fs.chmodSync(weightsFile, 0o644); fs.writeFileSync(weightsFile, Buffer.alloc(f.weights.length, 8));
  await assert.rejects(Models.resolveModel(f.userDataDir, imported.version), /changed/);
  await Manager.importRuntime(f);
  assert.equal((await Models.resolveModel(f.userDataDir, imported.version)).weightsHash, f.manifest.weights.sha256);
  await Manager.uninstallRuntime({ userDataDir: f.userDataDir, version: imported.version });
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);
  assert.deepEqual(fs.readFileSync(path.join(f.runtimePath, "weights.safetensors")), f.weights);
  assert.equal(fs.readFileSync(path.join(f.runtimePath, "unrelated.txt"), "utf8"), "not a model input");
});
test("model import rejects changed checksums, unsafe filenames, unsupported architectures and aliases", async t => {
  const f = fixture(t), manifestFile = path.join(f.runtimePath, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify({ ...f.manifest, weights: { ...f.manifest.weights, sha256: "a".repeat(64) } }));
  await assert.rejects(Models.importModel(f), /checksum/);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...f.manifest, weights: { ...f.manifest.weights, file: "../weights.safetensors" } }));
  await assert.rejects(Models.importModel(f), /filename/);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...f.manifest, architecture: "another-network" }));
  await assert.rejects(Models.importModel(f), /transformer/);
  fs.writeFileSync(manifestFile, JSON.stringify(f.manifest));
  const file = path.join(f.runtimePath, "weights.safetensors"), original = path.join(f.root, "original.safetensors");
  fs.renameSync(file, original); fs.symlinkSync(original, file);
  await assert.rejects(Models.importModel(f), /regular/);
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);
});
test("direct model selection validates the same supported metadata without reading weights", t => {
  const f = fixture(t), manifestFile = path.join(f.runtimePath, "manifest.json"), originalRead = fs.readFileSync;
  const reads = [];
  t.mock.method(fs, "readFileSync", function(file, ...options) {
    if (file === path.join(f.runtimePath, "weights.safetensors")) assert.fail("metadata inspection read model weights");
    reads.push(file); return originalRead.call(this, file, ...options);
  });
  assert.equal(Neural.model(f.runtimePath), f.runtimePath);
  const alias = path.join(f.root, "selected.dlssmodel"); fs.symlinkSync(f.runtimePath, alias);
  assert.equal(Neural.model(alias), f.runtimePath, "custom selection keeps canonical directory aliases");
  assert.equal(reads.filter(file => file === manifestFile).length, 2);
  const variants = [
    { schemaVersion: 2 }, { architecture: "unsupported" }, { identifier: "" },
    { weights: { ...f.manifest.weights, sha256: null } },
    { inputs: [{ ...f.manifest.inputs[0], dataType: "int8" }] },
    { inputs: [{ ...f.manifest.inputs[0], layout: "unknown" }] },
    { inputs: [{ ...f.manifest.inputs[0], shape: [1, "invalid-symbol", 16] }] },
    { inputs: [{ ...f.manifest.inputs[0], shape: [{ symbol: "height", multiplier: 0 }] }] },
    { outputs: [...f.manifest.outputs, ...f.manifest.outputs] },
    { weights: { ...f.manifest.weights, tensors: [{ name: "test", dataType: "float16", shape: [0] }] } },
    { weights: { ...f.manifest.weights, tensors: [{ name: "test", dataType: "float16", shape: ["width"] }] } },
    { state: { kind: "recurrent" } }, { state: { kind: "stateless", cadence: "consecutiveFrames" } },
    { state: { kind: "stateless", resetPolicy: "explicitAndSceneCut" } },
    { state: { kind: "stateless", tensors: f.manifest.inputs } }
  ];
  for (const changed of variants) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...f.manifest, ...changed }));
    assert.throws(() => Neural.model(f.runtimePath), /transformer|checksum/, JSON.stringify(changed));
    assert.throws(() => Models.inspectPackage(f.runtimePath), /transformer|checksum/);
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ ...f.manifest,
    inputs: [{ ...f.manifest.inputs[0], shape: [1, { symbol: "height", multiplier: 2 }, "width", 16] }] }));
  assert.equal(Neural.model(f.runtimePath), f.runtimePath);
});
test("cancelled model import removes the owned partial copy", async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(Models.importModel({ ...f, signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);
  assert.ok(fs.readdirSync(path.join(f.userDataDir, "runtimes", Models.ID))
    .every(name => !name.startsWith(".import-")));
  assert.deepEqual(fs.readFileSync(path.join(f.runtimePath, "weights.safetensors")), f.weights);
});
test("managed local model imports join shutdown cancellation and settle only after the owned copy is cleaned", async t => {
  const f = fixture(t), downloads = new DownloadManager(), caller = new AbortController();
  let entered, release, settled = false, combinedSignal;
  const copying = new Promise(resolve => {entered = resolve;}), cleanup = new Promise(resolve => {release = resolve;});
  const originalCopy = fs.promises.copyFile, originalImport = Models.importModel;
  t.mock.method(Models, "importModel", options => {combinedSignal = options.signal;return originalImport(options);});
  t.mock.method(fs.promises, "copyFile", async (...args) => {
    assert.equal(downloads.list()[0].kind, "import", "owned task is visible before model copying begins");
    await originalCopy(...args);entered();await cleanup;
  });
  const imported = Manager.importRuntime({...f, downloads, signal: caller.signal}).finally(() => {settled = true;});
  const failed = assert.rejects(imported, {name: "AbortError"});await copying;
  const source = fs.readFileSync(require.resolve("../src/core/backend-operations"), "utf8"), start = source.indexOf("    beginShutdown() {"),
    end = source.indexOf("\n    removeGameData,", start);
  assert.ok(start >= 0 && end > start);
  const shutdown = require("node:vm").runInNewContext("({" + source.slice(start, end) + "}).beginShutdown", {
    shuttingDown: false, downloads, importProgress: {clear() {}}, pendingImports: new Map(), launching: new Map(), moduleActions: new Map()
  });
  shutdown();assert.equal(combinedSignal.aborted, true);assert.equal(caller.signal.aborted, false);assert.equal(settled, false);
  release();await failed;assert.deepEqual(downloads.list(), []);assert.deepEqual(Models.listInstalled(f.userDataDir), []);
  assert.deepEqual(fs.readdirSync(path.join(f.userDataDir, "runtimes", Models.ID)), []);
  assert.deepEqual(fs.readFileSync(path.join(f.runtimePath, "weights.safetensors")), f.weights);
});
test("active neural model leases prevent removal of the selected managed copy", async t => {
  const f = fixture(t), imported = await Models.importModel(f), identity = Models.identityForPath(f.userDataDir, imported.modelPath);
  await withRuntimeUse(identity, async use => {
    await use.bind(process.pid);
    await assert.rejects(Models.removeModel({ userDataDir: f.userDataDir, version: imported.version }), { code: "RUNTIME_IN_USE" });
  }, { userDataDir: f.userDataDir });
  assert.equal(await Models.removeModel({ userDataDir: f.userDataDir, version: imported.version }), true);
});
test("damaged neural copies remain manageable without entering discovery or bypassing leases", async t => {
  const f = fixture(t), imported = await Models.importModel(f), identity = Models.identityForPath(f.userDataDir, imported.modelPath);
  const manager = {...Manager};require("../src/core/coordinated-runtime-managers").instrumentRuntimeManagers([manager]);
  const receipt = path.join(imported.installDir, "model.json"), external = path.join(f.root, "outside.json");
  fs.writeFileSync(external, "preserve external source");fs.chmodSync(receipt, 0o600);
  fs.writeFileSync(receipt, JSON.stringify({schema: 999, modelPath: external, installDir: f.root}));
  const aliasVersion = "sha256-" + "d".repeat(64);fs.symlinkSync(f.runtimePath, path.join(path.dirname(imported.installDir), aliasVersion));
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);assert.deepEqual(Neural.listModels(f.userDataDir), []);
  const installed = manager.getState({userDataDir: f.userDataDir}).installed;
  assert.equal(installed.length, 1);assert.equal(installed[0].version, imported.version);assert.equal(installed[0].ready, false);
  assert.equal(installed[0].installDir, imported.installDir);assert.equal(installed[0].modelPath, undefined);
  assert.equal(installed[0].weightsHash, undefined);assert.match(installed[0].error, /Import the original/);
  await assert.rejects(Models.resolveModel(f.userDataDir, imported.version), /changed/);
  await withRuntimeUse(identity, async use => {
    await use.bind(process.pid);await assert.rejects(manager.uninstallRuntime({userDataDir: f.userDataDir, version: imported.version}), {code: "RUNTIME_IN_USE"});
  }, {userDataDir: f.userDataDir});
  assert.equal(await manager.uninstallRuntime({userDataDir: f.userDataDir, version: imported.version}), true);
  assert.deepEqual(Models.listManaged(f.userDataDir), []);assert.equal(fs.readFileSync(external, "utf8"), "preserve external source");
  assert.deepEqual(fs.readFileSync(path.join(f.runtimePath, "weights.safetensors")), f.weights);
});
test("coordinated neural import adds a different model during use while reusing healthy data and protecting active repairs", async t => {
  const f = fixture(t), first = await Models.importModel(f), identity = Models.identityForPath(f.userDataDir, first.modelPath);
  const manager = { ...Manager };require('../src/core/coordinated-runtime-managers').instrumentRuntimeManagers([manager]);
  const secondPath = path.join(f.root, 'Second.dlssmodel');fs.cpSync(f.runtimePath, secondPath, { recursive: true });
  fs.writeFileSync(path.join(secondPath, 'manifest.json'), JSON.stringify({ ...f.manifest, identifier: 'org.example.second' }));
  const weights = path.join(first.modelPath, 'weights.safetensors'), before = fs.statSync(weights);
  await withRuntimeUse(identity, async use => {
    await use.bind(process.pid);
    const second = await manager.importRuntime({ ...f, runtimePath: secondPath });
    assert.notEqual(second.version, first.version);assert.equal(Models.listInstalled(f.userDataDir).length, 2);
    assert.equal((await manager.importRuntime(f)).version, first.version);
    assert.equal(fs.statSync(weights).ino, before.ino);assert.deepEqual(fs.readFileSync(weights), f.weights);
    await assert.rejects(manager.uninstallRuntime({ userDataDir: f.userDataDir, version: first.version }), { code: 'RUNTIME_IN_USE' });
    fs.chmodSync(weights, 0o644);const damaged = Buffer.alloc(f.weights.length, 9);fs.writeFileSync(weights, damaged);
    await assert.rejects(manager.importRuntime(f), { code: 'RUNTIME_IN_USE' });assert.deepEqual(fs.readFileSync(weights), damaged);
  }, { userDataDir: f.userDataDir });
  await manager.importRuntime(f);assert.deepEqual(fs.readFileSync(weights), f.weights);
  assert.ok(fs.readdirSync(path.dirname(first.installDir)).every(name => !name.startsWith('.')));
});
