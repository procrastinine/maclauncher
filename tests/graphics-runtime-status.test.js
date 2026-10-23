const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const {execFileSync} = require("node:child_process"), vm = require("node:vm");
const Status = require("../src/modules/shared/reshade/runtime-status"), Live = require("../src/modules/shared/reshade/live-controls");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-status-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = {gameId: "status", gamePath: "/Games/Status", reshade: {enabled: true, preset: "crt"},
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"}}, options = {userDataDir: root, runningPids: [process.pid]};
  const selected = Status.prepare(entry, {...options, launchId: "current"});assert.equal(fs.existsSync(path.dirname(selected.binding.file)), false);
  const directory = path.dirname(selected.binding.file);fs.mkdirSync(directory, {recursive: true});
  const controls = Buffer.alloc(19116);controls.write("MLFXCTL2");fs.writeFileSync(Live.file(entry, root), controls);
  const revision = "a".repeat(64), digest = crypto.createHash("sha256").update(controls).digest("hex");
  fs.writeFileSync(path.join(directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "simple", revision, nodes: []}));
  const launch = {schema: 1, launchId: "current", phase: "spawned", effectPlanAPI: 1, pid: process.pid, runtimeStatus: selected.binding,
    graphicsLivePreparation: {preparationStatus: {requested: [{id: "tone", method: "crt"}], pending: [{id: "generation", method: "lsfg", reason: "Model access is pending.", retained: false}]}}};
  const save = () => fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify(launch));save();
  return {root, entry, options, selected, revision, digest, launch, save, directory};
}
test("runtime status has no page or binding reads for Off and rejects stale process ownership", t => {
  const f = fixture(t), Binding = require("../src/modules/shared/reshade/launch-binding");
  const read = t.mock.method(Binding, "read", () => assert.fail("Off must not read a launch or create a consumer"));
  assert.deepEqual(Status.read({...f.entry, reshade: {enabled: false}, graphics: {}}, f.options), {state: "off", contexts: []});
  read.mock.restore();
  assert.equal(Status.read(f.entry, {...f.options, runningPids: [process.pid + 1000]}).state, "unbound");
  assert.equal(Status.read(f.entry, {...f.options, runningPids: []}).state, "stopped");
  assert.equal(fs.existsSync(f.selected.binding.file), false);
});
test("resource acceptance is separate from attempted revision and requires current unanimous leased contexts", t => {
  const f = fixture(t);assert.equal(Status.accepted(f.entry, f.options), null);
  assert.equal(fs.existsSync(f.selected.binding.file), false, "acceptance queries do not create a consumer page");
  Status.read(f.entry, f.options);
  const bytes = Buffer.alloc(32768), now = Date.now();bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(1n, 8);
  bytes.writeUInt32LE(6, 16);bytes.write("b".repeat(64), 112);bytes.writeBigUInt64LE(BigInt(now), 504);bytes.writeBigUInt64LE(1n, 512);
  const write = (offset = 4096) => {const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, offset);} finally {fs.closeSync(fd);}};
  write();assert.equal(Status.accepted(f.entry, f.options), null, "Prepared/Failed planRevision is not resource acceptance");
  bytes.write(f.revision, 528);bytes.write(f.digest, 593);bytes.writeBigUInt64LE(BigInt(now), 664);write();
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "advanced", revision: "b".repeat(64)}));
  const accepted = Status.accepted(f.entry, f.options);
  assert.equal(accepted.revision, f.revision, "the accepted revision need not match a rejected published pointer");
  assert.equal(accepted.launchId, "current");assert.equal(accepted.launchPid, process.pid);assert.equal(accepted.contexts[0].pid, process.pid);
  const admissionOnly = Buffer.alloc(32768);admissionOnly.writeUInt32LE(process.pid, 0);admissionOnly.writeBigUInt64LE(3n, 8);
  admissionOnly.writeBigUInt64LE(BigInt(now), 504);admissionOnly.writeBigUInt64LE(1n, 512);admissionOnly.writeUInt32LE(1, 672);
  const admissionFd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(admissionFd, admissionOnly, 0, admissionOnly.length, 4096 + 32768);} finally {fs.closeSync(admissionFd);}
  assert.equal(Status.accepted(f.entry, f.options).revision, f.revision, "admission checks alone neither adopt resources nor join the accepted-resource vote");
  bytes.writeBigUInt64LE(2n, 8);bytes.fill(0, 528, 593);bytes.write("c".repeat(64), 528);write(4096 + 32768);
  assert.equal(Status.accepted(f.entry, f.options), null, "different active contexts must agree before projection");
  bytes.writeUInt32LE(7, 16);write(4096 + 32768);assert.equal(Status.accepted(f.entry, f.options).revision, f.revision);
  bytes.writeUInt32LE(6, 16);bytes.writeBigUInt64LE(BigInt(now - 10000), 504);write();
  assert.equal(Status.accepted(f.entry, f.options), null, "stale status cannot authorize a new projection");
  bytes.writeBigUInt64LE(BigInt(now), 504);bytes.write(f.revision, 528);write();
  const fd = fs.openSync(f.selected.binding.file, "r+"), lease = Buffer.alloc(8);try {fs.writeSync(fd, lease, 0, 8, 16);} finally {fs.closeSync(fd);}
  assert.equal(Status.accepted(f.entry, f.options), null, "acceptance queries neither renew nor trust an expired lease");
  assert.equal(Status.accepted(f.entry, {...f.options, runningPids: [process.pid + 1000]}), null);
});
test("closed-panel transaction acquires actual CPU resource acceptance without inspector reads", {skip: process.platform !== "darwin"}, async t => {
  const f = fixture(t);
  const binary = path.join(f.root, "accepted-status-fixture"), native = path.resolve(__dirname, "../src/modules/shared/reshade/native");
  execFileSync("clang++", ["-std=c++17", "-UNDEBUG", "-I", native, path.join(native, "runtime-status.cpp"), path.join(native, "test/runtime-status.cpp"), "-o", binary], {stdio: "pipe"});
  assert.equal(fs.existsSync(f.selected.binding.file), false);
  const pending = Status.acquireAccepted(f.entry, {...f.options, launchBinding: f.launch});
  execFileSync(binary, [f.revision, f.digest, "--acceptance"], {env: {...process.env, ...f.selected.environment}, stdio: "pipe", timeout: 5000});
  assert.equal((await pending).revision, f.revision);
  const lease = fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16);assert.equal(lease, 0n, "the control lease ends after the transaction");
  const actual = Status.read(f.entry, f.options), row = actual.contexts[0], accepted = Status.accepted(f.entry, f.options);
  assert.equal(row.phase, "failed");assert.equal(row.planRevision, "c".repeat(64));assert.equal(row.acceptedRevision, f.revision);
  assert.equal(accepted.revision, f.revision);assert.equal(row.completed, 0);assert.equal(row.presentedReal, 0);
});
test("transaction acceptance timeout, abort and session replacement preserve files and release only their own lease", async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.directory, "effect-plan.json"));
  const lease = () => fs.readFileSync(f.selected.binding.file).readBigUInt64LE(16);
  assert.equal(await Status.acquireAccepted(f.entry, {...f.options, timeoutMs: 20}), null);assert.equal(lease(), 0n);
  const controller = new AbortController(), reason = Object.assign(new Error("Stop requested"), {code: "ABORT_ERR"});
  const aborting = Status.acquireAccepted(f.entry, {...f.options, signal: controller.signal, timeoutMs: 1000});
  controller.abort(reason);await assert.rejects(aborting, error => error === reason);assert.equal(lease(), 0n);
  let current = true;
  const stale = Status.acquireAccepted(f.entry, {...f.options, isCurrent: () => current, timeoutMs: 1000});current = false;
  await assert.rejects(stale, {code: "GRAPHICS_LIVE_STALE"});assert.equal(lease(), 0n);
  const replaced = Status.acquireAccepted(f.entry, {...f.options, timeoutMs: 1000});f.launch.launchId = "replacement";f.save();
  await assert.rejects(replaced, {code: "GRAPHICS_LIVE_STALE"});assert.equal(lease(), 0n);
  f.launch.launchId = "current";f.save();
  const timed = Status.acquireAccepted(f.entry, {...f.options, timeoutMs: 20});
  const fd = fs.openSync(f.selected.binding.file, "r+"), external = Buffer.alloc(8);external.writeBigUInt64LE(BigInt(Date.now() + 6000));
  try {fs.writeSync(fd, external, 0, 8, 16);} finally {fs.closeSync(fd);}
  assert.equal(await timed, null);assert.equal(lease(), external.readBigUInt64LE(0), "a concurrent inspector lease is not revoked");
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "effect-plan.json")), before);
});
test("actual CPU status-page producer preserves prepared, completed, fallback and presentation distinctions", {skip: process.platform !== "darwin"}, t => {
  const f = fixture(t), first = Status.read(f.entry, f.options);
  assert.equal(first.state, "prepared");assert.deepEqual(first.contexts, []);
  assert.equal(first.preparation.pending[0].method, "mlx-dlss");
  assert.equal(first.preparation.requested.some(row => row.id === "generation"), false, "an old prepared request is never labelled as the current selection");
  const binary = path.join(f.root, "status-fixture"), native = path.resolve(__dirname, "../src/modules/shared/reshade/native");
  execFileSync("clang++", ["-std=c++17", "-UNDEBUG", "-I", native, path.join(native, "runtime-status.cpp"), path.join(native, "test/runtime-status.cpp"), "-o", binary], {stdio: "pipe"});
  execFileSync(binary, [f.revision, f.digest], {env: {...process.env, ...f.selected.environment}, stdio: "pipe", timeout: 5000});
  execFileSync(binary, [], {stdio: "pipe", timeout: 5000});
  const actual = Status.read(f.entry, f.options), row = actual.contexts[0];
  assert.equal(actual.state, "observed");assert.equal(row.matchesPrepared, true);assert.notEqual(row.pid, process.pid);
  assert.deepEqual(row.input, {width: 8, height: 8});assert.deepEqual(row.output, {width: 16, height: 16});
  assert.equal(row.encoded, 1);assert.equal(row.completed, 1);assert.equal(row.presentedReal, 1);assert.equal(row.presentedGenerated, 2);
  assert.equal(row.admission.counts["frame-owner-accepted"], 1);assert.equal(row.admission.counts["frame-owner-missing"], 32);
  assert.equal(row.admission.queue, "100");assert.equal(row.admission.format, 80);assert.equal(row.admission.generation, 1);
  assert.equal(row.stages[2].id.length, 128);assert.notEqual(row.stages[2].id, row.stages[3].id);
  assert.equal(row.stages[1].phase, "bypassed");assert.equal(row.stages[1].requestedMethod, "lsfg");assert.equal(row.stages[1].activeMethod, "passthrough");
  assert.equal(row.stages[1].completed, 0);assert.match(row.stages[1].reason, /model unavailable/);
  assert.ok(row.observedAt > 0);assert.ok(row.presentedTime > 0);
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, revision: "b".repeat(64)}));
  const pending = Status.read(f.entry, f.options);assert.equal(pending.state, "prepared");assert.equal(pending.contexts[0].matchesPrepared, false);
  const descriptor = fs.openSync(f.selected.binding.file, "r+"), odd = Buffer.alloc(4);odd.writeUInt32LE(1);fs.writeSync(descriptor, odd, 0, 4, 4096 + 4);fs.closeSync(descriptor);
  assert.deepEqual(Status.read(f.entry, f.options).contexts, [], "a concurrent incomplete slot never becomes an accepted observation");
});
test("status never follows an untrusted page link or accepts another launch's metadata", t => {
  const f = fixture(t), target = path.join(f.root, "keep");fs.writeFileSync(target, "preserve");fs.symlinkSync(target, f.selected.binding.file);
  assert.equal(Status.read(f.entry, f.options).state, "unavailable");assert.equal(fs.readFileSync(target, "utf8"), "preserve");
  fs.unlinkSync(f.selected.binding.file);f.launch.runtimeStatus.launchId = "previous";f.save();
  assert.equal(Status.read(f.entry, f.options).state, "unavailable");assert.equal(fs.existsSync(f.selected.binding.file), false);
});
test("Advanced revisions confirm ordered work without invented controls; missing Simple identity stays unverified", t => {
  const f = fixture(t);Status.read(f.entry, f.options);
  const bytes = Buffer.alloc(32768);bytes.writeUInt32LE(process.pid, 0);bytes.writeBigUInt64LE(1n, 8);
  bytes.writeUInt32LE(3, 16);bytes.writeBigUInt64LE(1n, 40);bytes.write(f.revision, 112);
  bytes.writeBigUInt64LE(BigInt(Date.now()), 504);bytes.writeBigUInt64LE(1n, 512);
  const write = () => {const fd = fs.openSync(f.selected.binding.file, "r+");try {fs.writeSync(fd, bytes, 0, bytes.length, 4096);} finally {fs.closeSync(fd);}};
  write();let current = Status.read(f.entry, f.options);
  assert.equal(current.state, "unverified");assert.equal(current.contexts[0].identityState, "unverified");
  fs.writeFileSync(path.join(f.directory, "effect-plan.json"), JSON.stringify({schema: 1, mode: "advanced", revision: f.revision}));
  current = Status.read(f.entry, f.options);
  assert.equal(current.state, "observed");assert.equal(current.contexts[0].identityState, "matching");
  assert.equal(current.contexts[0].controlsDigest, "", "the reader never supplies a requested digest as an actual observation");
  bytes.write("b".repeat(64), 177);write();current = Status.read(f.entry, f.options);
  assert.equal(current.contexts[0].identityState, "previous");assert.equal(current.contexts[0].matchesPrepared, false);
  bytes.fill(0, 112, 242);write();current = Status.read(f.entry, f.options);
  assert.equal(current.state, "unverified");assert.equal(current.contexts[0].identityState, "unverified");
});
test("catalog pending reasons survive only for the exact current model and mode selection", t => {
  const f = fixture(t), {selectionKey} = require("../src/modules/shared/effects/live-plan");
  const row = {id: "generation", kind: "frame-generation", method: "lsfg", enabled: true, settings: {modelVersion: null}};
  f.entry.effects = {schema: 1, mode: "advanced", video: [row]};
  const store = path.join(f.root, "runtimes", "lossless-models");fs.mkdirSync(store, {recursive: true});
  f.launch.effectPlanLiveResources = {schema: 1, modelRoots: {lossless: store}};
  const reason = "Compatible installed models are required.";
  f.launch.graphicsLivePreparation = {preparationStatus: {pending: [{id: row.id, reason, retained: true, requestKey: selectionKey(row)}]}};f.save();
  assert.equal(Status.read(f.entry, f.options).preparation.pending[0].reason, reason);
  row.settings.lsfgMode = "performance";
  assert.deepEqual(Status.read(f.entry, f.options).preparation.pending, [], "a stale compatibility result does not follow a different quality mode");
  row.settings.modelVersion = "sha256-" + "f".repeat(64);
  const selected = path.join(store, row.settings.modelVersion);fs.mkdirSync(selected);fs.writeFileSync(path.join(selected, "Lossless.dll"), "owned model path");
  assert.deepEqual(Status.read(f.entry, f.options).preparation.pending, [], "a stale missing-model result does not follow a new managed selection");
});
test("prepared rows do not prove retention; only the exact acknowledged projection does", t => {
  const f = fixture(t), {selectionKey} = require("../src/modules/shared/effects/live-plan");
  const row = {id: "neural", kind: "neural", method: "mlx-dlss", enabled: true,
    settings: {modelPath: "/Models/Unavailable.dlssmodel", intensity: 1}};
  f.entry.effects = {schema: 1, mode: "advanced", video: [row]};
  const preparation = {applied: [{id: row.id, kind: row.kind, method: row.method}]};
  f.launch.graphicsLivePreparation = {preparationStatus: preparation};f.save();
  let result = Status.read(f.entry, f.options);
  assert.match(result.preparation.pending[0].reason, /unavailable to this running game/);
  assert.equal(result.contexts.length, 0, "no native resource acceptance has been reported");
  assert.equal(result.preparation.pending[0].retained, false, "a prepared or rejected row cannot establish retention");

  preparation.pending = [{id: row.id, reason: "The accepted model is retained.", retained: true, requestKey: selectionKey(row)}];f.save();
  assert.equal(Status.read(f.entry, f.options).preparation.pending[0].retained, true,
    "the matching projection already obtained native resource acceptance");
  row.settings.intensity = .5;
  assert.equal(Status.read(f.entry, f.options).preparation.pending[0].retained, false,
    "an earlier projection does not establish retention for a different request");
});
test("main status IPC uses current process identity without module, model or catalog discovery", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8"), handlers = new Map(), received = [];
  const entry = {gamePath: "/Game"}, session = {pid: 123}, stopped = {pid: 456, stopRequested: true};
  const start = source.indexOf('ipcMain.handle("launcher:getGameGraphicsStatus"'), end = source.indexOf('ipcMain.handle(', start + 1);
  vm.runInNewContext(source.slice(start, end), {ipcMain: {handle: (id, callback) => handlers.set(id, callback)}, userDataDir: "/Profile",
    loadGamesHydrated: () => [entry], findGameByPath: () => entry, runningGameSessions: new Map([[entry.gamePath, new Map([["current", session], ["stopped", stopped]])]]),
    require: id => {assert.equal(id, "../modules/shared/reshade/runtime-status");return {read: (game, options) => {received.push([game, options]);return {state: "prepared"};}};}});
  assert.equal(handlers.get("launcher:getGameGraphicsStatus")(null, entry.gamePath).state, "prepared");
  assert.equal(received[0][0], entry);assert.deepEqual([...received[0][1].runningPids], [123]);
  let api;const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8"), {require: () => ({
    contextBridge: {exposeInMainWorld: (_, value) => {api = value.launcher;}}, ipcRenderer: {invoke: (...args) => {calls.push(args);}}, webUtils: {}})});
  assert.deepEqual(calls, []);await api.getGameGraphicsStatus("/Game");assert.deepEqual(calls, [["launcher:getGameGraphicsStatus", "/Game"]]);
});
