const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const Setup = require("../src/modules/shared/reshade/neural/setup"), Models = require("../src/modules/shared/reshade/neural/models");
const Manager = require("../src/modules/shared/reshade/runtime/neural-models-manager"), {writeZipArchive} = require("./helpers/zip-fixture");
const {DownloadManager} = require("../src/modules/shared/runtime/download-manager");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "neural-setup-"))), userDataDir = path.join(root, "profile");
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));fs.mkdirSync(userDataDir);
  const weights = Buffer.alloc(4096, 7), manifest = {schemaVersion: 1, identifier: "org.example.download", architecture: "mlxdlss.neural-rendering-transformer.v1",
    inputs: [{name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16]}],
    outputs: [{name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4]}], state: {kind: "stateless"},
    weights: {file: "weights.safetensors", sha256: hash(weights), tensors: [{name: "test", dataType: "float16", shape: [1]}]}};
  const bytes = Buffer.from(JSON.stringify(manifest)), archive = path.join(root, "Original.zip"), prefix = "Source.app/Contents/Resources/models/Model.dlssmodel/";
  writeZipArchive(archive, [{name: prefix + "manifest.json", data: bytes}, {name: prefix + "weights.safetensors", data: weights},
    {name: "Source.app/Contents/Resources/NOTICE", data: "Original model terms"}, {name: "Source.app/Contents/MacOS/never-run", data: "not executed or retained"}]);
  const source = {...Setup.sourceFor(), bytes: fs.statSync(archive).size, sha256: hash(fs.readFileSync(archive)),
    manifestHash: hash(bytes), weightsHash: hash(weights)};
  let downloads = 0;
  const downloadToFile = async (url, destination, {signal, onProgress}) => {
    assert.equal(url, source.url);assert.notEqual(destination, archive);signal?.throwIfAborted();downloads++;
    fs.copyFileSync(archive, destination, fs.constants.COPYFILE_EXCL);onProgress?.({downloaded: source.bytes, total: source.bytes});signal?.throwIfAborted();
  };
  return {root, userDataDir, weights, archive, source, downloadToFile, downloads: () => downloads};
}
function noPartial(f) {
  const root = path.join(f.userDataDir, "runtimes", Models.ID);
  assert.ok(!fs.existsSync(root) || fs.readdirSync(root).every(name => !name.startsWith(".")), "owned downloads and extractions are cleaned");
}
test("neural source catalog is pinned and model manager state performs no acquisition", t => {
  const f = fixture(t), source = Setup.sourceFor(), state = Manager.getState({userDataDir: f.userDataDir});
  assert.equal(source.bytes, 320194134);assert.equal(source.sha256, "cab2b8abb4c415d888903bad7edc8f88955c44c7279aea5a33bfde6114f24d62");
  assert.equal(state.setupActions[0].id, "downloadDlssMac");assert.equal(state.catalog.installable, false);
  assert.deepEqual(fs.readdirSync(f.userDataDir), [], "status creates no files");
  assert.throws(() => Setup.sourceFor("unlisted"), /available/);
});
test("declining or cancelling acquisition returns no model without download or storage writes", async t => {
  const f = fixture(t);let confirmations = 0;
  assert.equal(await Setup.ensureNeuralModel({userDataDir: f.userDataDir, confirmRuntimeInstall: async plan => {
    confirmations++;assert.equal(plan.managerId, Models.ID);assert.equal(plan.downloadBytes, f.source.bytes);return false;
  }}, f), null);
  const controller = new AbortController();controller.abort();
  assert.equal(await Setup.ensureNeuralModel({userDataDir: f.userDataDir, signal: controller.signal}, f), null);
  assert.equal(confirmations, 1);assert.equal(f.downloads(), 0);assert.deepEqual(fs.readdirSync(f.userDataDir), []);
});
test("consented download verifies the ZIP and imports only model files and notices with source retained", async t => {
  const f = fixture(t), original = fs.readFileSync(f.archive);let confirmations = 0;
  const result = await Setup.ensureNeuralModel({userDataDir: f.userDataDir, confirmRuntimeInstall: async plan => {
    confirmations++;assert.match(plan.detail, /NVIDIA/);return {approved: true};
  }}, f);
  assert.equal(f.downloads(), 1);assert.equal(confirmations, 1);assert.ok(Models.validVersion(result.version));
  const installed = await Models.resolveModel(f.userDataDir, result.version);
  assert.deepEqual(fs.readdirSync(installed.modelPath).sort(), ["manifest.json", "weights.safetensors"]);
  assert.deepEqual(fs.readFileSync(installed.weightsPath), f.weights);
  assert.equal(fs.readFileSync(path.join(installed.installDir, "notices/0-NOTICE"), "utf8"), "Original model terms");
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed.installDir, "download-source.json"))).sha256, f.source.sha256);
  assert.ok(!fs.existsSync(path.join(installed.installDir, "Contents")));noPartial(f);
  const again = await Setup.ensureNeuralModel({userDataDir: f.userDataDir, settings: {runtimes: {[Models.ID]: {defaultVersion: result.version}}},
    confirmRuntimeInstall: () => assert.fail("installed selection needs no download consent")}, {downloadToFile: () => assert.fail("installed selection needs no network")});
  assert.deepEqual(again, result);
  await Models.removeModel({userDataDir: f.userDataDir, version: result.version});
  assert.deepEqual(fs.readFileSync(f.archive), original, "download/import/removal preserves original source");
});
test("a damaged downloaded copy can be repaired after fresh consent while decline and abort preserve it", async t => {
  const f = fixture(t), original = fs.readFileSync(f.archive), model = await Setup.ensureNeuralModel({userDataDir: f.userDataDir}, f);
  const installed = await Models.resolveModel(f.userDataDir, model.version), damaged = Buffer.alloc(f.weights.length, 9);
  fs.chmodSync(installed.weightsPath, 0o600);fs.writeFileSync(installed.weightsPath, damaged);
  const context = {userDataDir: f.userDataDir, settings: {runtimes: {[Models.ID]: {defaultVersion: model.version}}}};
  let confirmations = 0;
  assert.equal(await Setup.ensureNeuralModel({...context, confirmRuntimeInstall: async () => {confirmations++;return false;}}, f), null);
  assert.equal(confirmations, 1);assert.equal(f.downloads(), 1);assert.deepEqual(fs.readFileSync(installed.weightsPath), damaged);
  const controller = new AbortController();
  assert.equal(await Setup.ensureNeuralModel({...context, signal: controller.signal, confirmRuntimeInstall: async () => {
    confirmations++;controller.abort();return true;
  }}, f), null);
  assert.equal(f.downloads(), 1);assert.deepEqual(fs.readFileSync(installed.weightsPath), damaged);noPartial(f);
  assert.deepEqual(await Setup.ensureNeuralModel({...context, confirmRuntimeInstall: async () => {confirmations++;return true;}}, f), model);
  assert.equal(confirmations, 3);assert.equal(f.downloads(), 2);
  assert.deepEqual(fs.readFileSync((await Models.resolveModel(f.userDataDir, model.version)).weightsPath), f.weights);
  assert.deepEqual(fs.readFileSync(f.archive), original);noPartial(f);
});
test("checksum and oversize failures publish no models and remove owned archive files", async t => {
  const f = fixture(t);
  await assert.rejects(Setup.ensureNeuralModel({userDataDir: f.userDataDir}, {...f, source: {...f.source, sha256: "a".repeat(64)}}), /checksum/);
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);noPartial(f);
  await assert.rejects(Setup.ensureNeuralModel({userDataDir: f.userDataDir}, {...f, downloadToFile: async (_url, file, {signal, onProgress}) => {
    fs.writeFileSync(file, "partial");onProgress({downloaded: f.source.bytes + 1, total: f.source.bytes + 1});signal.throwIfAborted();
  }}), /release size/);
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);noPartial(f);
});
test("abort during model import cleans download, extraction and partial copies", async t => {
  const f = fixture(t), controller = new AbortController();
  const result = await Setup.ensureNeuralModel({userDataDir: f.userDataDir, signal: controller.signal,
    onProgress: progress => { if (progress.phase === "import") controller.abort(); }}, f);
  assert.equal(result, null);assert.deepEqual(Models.listInstalled(f.userDataDir), []);noPartial(f);
  assert.equal(hash(fs.readFileSync(f.archive)), f.source.sha256);
});
test("backend shutdown cancels the registered download and waits for owned cleanup to settle", async t => {
  const f = fixture(t), downloads = new DownloadManager();let entered, releaseCleanup, reachedAbort, settled = false;
  const started = new Promise(resolve => {entered = resolve;}), cleanup = new Promise(resolve => {releaseCleanup = resolve;}),
    aborted = new Promise(resolve => {reachedAbort = resolve;});
  const job = Setup.ensureNeuralModel({userDataDir: f.userDataDir, downloads}, {...f,
    downloadToFile: async (_url, file, {signal}) => {
      assert.equal(downloads.list().length, 1, "task is registered before downloader starts");
      assert.equal(downloads.list()[0].managerId, Models.ID);fs.writeFileSync(file, "partial");entered();
      await new Promise(resolve => signal.addEventListener("abort", resolve, {once: true}));reachedAbort();
      await cleanup;signal.throwIfAborted();
    }}).finally(() => {settled = true;});
  await started;
  const backend = fs.readFileSync(require.resolve("../src/core/backend-operations"), "utf8"), start = backend.indexOf("    beginShutdown() {"),
    end = backend.indexOf("\n    removeGameData,", start);
  assert.ok(start >= 0 && end > start);
  const shutdown = vm.runInNewContext("({" + backend.slice(start, end) + "}).beginShutdown", {
    shuttingDown: false, downloads, importProgress: {clear() {}}, pendingImports: new Map(), launching: new Map(), moduleActions: new Map()
  });
  shutdown();await aborted;assert.equal(settled, false, "abort does not settle before importer cleanup");
  assert.equal(downloads.list()[0].status, "canceled");releaseCleanup();
  assert.equal(await job, null);assert.deepEqual(downloads.list(), []);noPartial(f);assert.deepEqual(Models.listInstalled(f.userDataDir), []);
});
test("download-task cancellation remains active through checksum and managed import", async t => {
  const f = fixture(t), downloads = new DownloadManager();let cancelled = false;
  const result = await Setup.ensureNeuralModel({userDataDir: f.userDataDir, downloads, onProgress: progress => {
    if (progress.phase === "import") {cancelled = true;assert.equal(downloads.list().length, 1);downloads.cancel(downloads.list()[0].id);}
  }}, f);
  assert.equal(result, null);assert.equal(cancelled, true);assert.deepEqual(downloads.list(), []);
  assert.deepEqual(Models.listInstalled(f.userDataDir), []);noPartial(f);assert.equal(hash(fs.readFileSync(f.archive)), f.source.sha256);
});
