const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Native = require("../src/modules/shared/runtime/bundled-native");
const Verify = require("../src/modules/shared/reshade/payload-verification");
const RuntimeRecord = require("../src/modules/shared/reshade/runtime-record");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const temporary = (t, prefix) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));return root;
};
const touch = file => {const time = new Date(Date.now() + 5000);fs.utimesSync(file, time, time);};

test("edits reuse payload files verified in this process while launches check their identities", t => {
  const root = temporary(t, "graphics-verify-reuse-");
  t.after(() => Verify.clear());
  const make = name => {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});fs.writeFileSync(path.join(root, name), "original");
    return {path: name, size: 8, mode: 0o644, sha256: sha("original")};
  };
  const manifest = {files: ["runtime.json", "libreshade-macos.dylib", "libvkd3d-shader.dylib", "fx-compile", "effects/crt.fx"].map(make)};
  const entry = {effects: {schema: 2, mode: "advanced", enabled: true, video: [{id: "crt", kind: "shader", enabled: true, shader: {preset: "crt"}}]}};
  assert.equal(Verify.verifyLaunch(root, entry, {manifest}).files, 5);
  const identity = Native.fileIdentity;let stats = 0;
  t.mock.method(Native, "fileIdentity", (...args) => {stats++;return identity(...args);});
  Verify.verifyLaunch(root, entry, {manifest, reuse: true});
  assert.equal(stats, 0, "an edit does not stat files verified earlier");
  Verify.verifyLaunch(root, entry, {manifest});
  assert.equal(stats, 5, "a launch checks each identity");
  fs.writeFileSync(path.join(root, "effects/crt.fx"), "modified");
  Verify.verifyLaunch(root, entry, {manifest, reuse: true});
  assert.throws(() => Verify.verifyLaunch(root, entry, {manifest}), /checksum/);
  assert.throws(() => Verify.verifyLaunch(root, entry, {manifest, reuse: true}), /checksum/,
    "a file that failed verification is not trusted by a later edit");
  const updated = {files: manifest.files.map(row => row.path === "effects/crt.fx" ? {...row, sha256: sha("modified")} : row)};
  stats = 0;Verify.verifyLaunch(root, entry, {manifest: updated, reuse: true});
  assert.equal(stats, 2, "a changed manifest row is verified again");
  assert.throws(() => Verify.verifyLaunch(root, entry, {manifest, reuse: true}), /checksum/, "the earlier row is not reused for different bytes");
});

test("runtime records are parsed once per file identity and read again after a rewrite or replacement", t => {
  const root = temporary(t, "graphics-runtime-record-"), file = path.join(root, "runtime.json");
  t.after(() => RuntimeRecord.clear());
  fs.writeFileSync(file, JSON.stringify({schema: 1, version: "a", features: {graphics: {effectPlanAPI: 1}}}));
  const read = fs.readFileSync;let reads = 0;
  t.mock.method(fs, "readFileSync", (target, ...args) => {if (target === file) reads++;return read(target, ...args);});
  const first = RuntimeRecord.read(root);
  assert.equal(RuntimeRecord.read(root), first);assert.equal(reads, 1);
  assert.ok(Object.isFrozen(first.features.graphics), "a shared record cannot be changed by one reader");
  fs.writeFileSync(file, JSON.stringify({schema: 1, version: "b", features: {graphics: {effectPlanAPI: 1}}}));
  assert.equal(RuntimeRecord.read(root).version, "b");assert.equal(reads, 2);
  fs.writeFileSync(file + ".next", JSON.stringify({schema: 1, version: "c"}));fs.renameSync(file + ".next", file);
  assert.equal(RuntimeRecord.read(root).version, "c");assert.equal(reads, 3);
  fs.unlinkSync(file);assert.throws(() => RuntimeRecord.read(root), {code: "ENOENT"});
});

test("neural model resolution hashes unchanged weights once and rehashes a touched or rewritten file", async t => {
  const Models = require("../src/modules/shared/reshade/neural/models");
  const root = temporary(t, "neural-model-stamp-"), userDataDir = path.join(root, "profile"), runtimePath = path.join(root, "Model.dlssmodel");
  fs.mkdirSync(userDataDir);fs.mkdirSync(runtimePath);
  const weights = Buffer.alloc(64 * 1024, 7);
  const manifest = {schemaVersion: 1, identifier: "org.example.stamp", architecture: "mlxdlss.neural-rendering-transformer.v1",
    inputs: [{name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16]}],
    outputs: [{name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4]}], state: {kind: "stateless"},
    weights: {file: "weights.safetensors", sha256: sha(weights), tensors: require("./helpers/neural-model-contract").nrTensors()}};
  fs.writeFileSync(path.join(runtimePath, "manifest.json"), JSON.stringify(manifest));fs.writeFileSync(path.join(runtimePath, "weights.safetensors"), weights);
  const imported = await Models.importModel({userDataDir, runtimePath});
  const open = fs.createReadStream, reads = [];
  t.mock.method(fs, "createReadStream", (file, ...args) => {reads.push(file);return open(file, ...args);});
  const {weightsPath} = await Models.resolveModel(userDataDir, imported.version);
  await Models.resolveModel(userDataDir, imported.version);
  assert.equal(reads.filter(file => file === weightsPath).length, 1);
  touch(weightsPath);await Models.resolveModel(userDataDir, imported.version);
  assert.equal(reads.filter(file => file === weightsPath).length, 2, "a new file stamp is hashed again");
  fs.chmodSync(weightsPath, 0o644);fs.writeFileSync(weightsPath, Buffer.alloc(weights.length, 8));
  await assert.rejects(Models.resolveModel(userDataDir, imported.version), /changed/);
  await assert.rejects(Models.resolveModel(userDataDir, imported.version), /changed/, "a rejected file is never cached as valid");
});

test("Lossless Scaling model resolution hashes an unchanged copy once per file identity", async t => {
  const Models = require("../src/modules/shared/reshade/models");
  const root = temporary(t, "lossless-model-stamp-"), original = path.join(root, "Lossless.dll");fs.writeFileSync(original, Buffer.alloc(128, 65));
  const inspection = {schema: 1, version: "3.2.2.0", contentHash: sha(fs.readFileSync(original)), resourceLayoutHash: "a".repeat(64), size: 128, resourceCount: 300,
    capabilities: Object.fromEntries(Models.CAPABILITIES.map(key => [key, {compatible: true, reason: ""}]))};
  const options = {userDataDir: path.join(root, "profile"), runtimePath: original, inspect: async () => inspection};
  const installed = await Models.importModel(options);
  const open = fs.createReadStream;let reads = 0;
  t.mock.method(fs, "createReadStream", (file, ...args) => {if (file === installed.modelPath) reads++;return open(file, ...args);});
  for (const capability of ["lsfgFp16Quality", "lsfgFp32Performance", "ls1Quality"]) await Models.resolveModel(options.userDataDir, installed.version, capability);
  assert.equal(reads, 1);
  fs.chmodSync(installed.modelPath, 0o644);fs.writeFileSync(installed.modelPath, Buffer.alloc(128, 66));
  await assert.rejects(Models.resolveModel(options.userDataDir, installed.version, "ls1Quality"), /has changed/);
  assert.equal(reads, 2);
});

test("the XeSS compute broker watches requests only while a prepared XeSS row needs it", t => {
  const Broker = require("../src/modules/shared/runtime/gpu-compute-broker");
  const userDataDir = temporary(t, "gpu-broker-lazy-"), binding = {...Broker.reserve({userDataDir, launchId: "lazy"}), namespace: "org.maclauncher.xess.test."};
  t.after(() => Broker.release(binding));
  t.mock.timers.enable({apis: ["setInterval"]});
  const watchers = [];
  t.mock.method(fs, "watch", () => {
    const watcher = {closed: false, close() {this.closed = true;}, on() {return this;}, unref() {}};watchers.push(watcher);return watcher;
  });
  const config = {executable: process.execPath, arguments: [], hostPath: "/trusted/helper.exe", originalLibrary: "/trusted/original.dll", environment: {}};
  Broker.bind(binding, process.pid);
  assert.equal(watchers.length, 0, "a launch without a XeSS row starts no watcher or timer");
  Broker.register(binding, config);
  assert.equal(watchers.length, 1, "the first prepared row starts the watcher");
  t.mock.timers.tick(3000);assert.equal(watchers[0].closed, false);
  Broker.demand(binding, false);t.mock.timers.tick(1000);
  assert.equal(watchers[0].closed, true, "a plan without XeSS releases the idle watcher");
  Broker.register(binding, config);
  assert.equal(watchers.length, 2);assert.equal(watchers[1].closed, false, "a later XeSS row starts it again");
  Broker.release(binding);assert.equal(watchers[1].closed, true);
});

test("launch preparation reuses an unchanged compiled custom shader and recompiles an edited source", {skip: process.platform !== "darwin"}, async t => {
  const ReShade = require("../src/modules/shared/reshade");
  const root = temporary(t, "graphics-launch-compile-"), runtime = path.join(root, "runtime"), userDataDir = path.join(root, "profile");
  fs.mkdirSync(path.join(runtime, "effects"), {recursive: true});
  for (const file of ["libreshade-macos.dylib", "fx-compile", "effects/crt.fx"]) fs.writeFileSync(path.join(runtime, file), "fixture");
  fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({schema: 1, version: "test", minimumMacOS: "11.0", features: {graphics: {effectPlanAPI: 1}}}));
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  const source = path.join(root, "Custom.fx");fs.writeFileSync(source, "technique Custom {}");
  const entry = {gameId: "custom-launch", effects: {schema: 2, mode: "advanced", enabled: true,
    video: [{id: "shader", kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: source}}]}};
  let compiles = 0;
  const execute = async (_command, args) => {
    if (args[0] === "--prepare") {compiles++;fs.writeFileSync(args[2], "prepared effect");}
    else fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
  };
  const options = {root: runtime, userDataDir, graphicsHost: "window", verify: () => true, execute};
  const revision = () => JSON.parse(fs.readFileSync(path.join(userDataDir, "games/custom-launch/effects/reshade/plan-nodes/shader/live-selection.json"))).revision;
  await ReShade.prepare(entry, options);
  const first = revision();assert.equal(compiles, 1);
  await ReShade.prepare(entry, options);
  assert.equal(compiles, 1, "an unchanged source and compiler identity is not recompiled");assert.equal(revision(), first);
  touch(source);await ReShade.prepare(entry, options);
  assert.equal(compiles, 2, "an edited source is compiled again");assert.notEqual(revision(), first);
});
