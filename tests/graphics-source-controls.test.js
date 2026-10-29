const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Controls = require("../src/modules/shared/reshade/source-controls");
const Source = require("../src/modules/shared/reshade/source-resolution");
test("custom source percentages require the actual parser capability without changing discrete engine requests",()=>{
  const request={multiplier:100/63}, virtual={control:"virtual",live:true,activationAPI:1,percentages:true,multipliers:[1,2]};
  assert.deepEqual(Controls.normalize(request,virtual),request);
  assert.throws(()=>Controls.normalize(request,{...virtual,percentages:false}),/source percentage/);
  assert.deepEqual(Controls.normalize({multiplier:2},{...virtual,percentages:false}),{multiplier:2});
  for(const multiplier of [0,.5,Infinity,NaN,"2"])
    assert.throws(()=>Controls.normalize({multiplier},virtual),/render percentage/);
});
const {createPublication} = require("../src/modules/shared/reshade/live-publication");
const support = {control: "engine", live: true, heights: true, multipliers: [1, 1.5, 2, 3], methods: ["bilinear", "metalfx", "fsr1"]};
function fixture(t) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-source-controls-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const entry = {gameId: "source-game"}, prepared = Controls.prepare(entry, {userDataDir, support, launchId: "owned-launch"});
  return {entry, userDataDir, ...prepared};
}
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function acknowledge(binding, command, patch = {}) {
  const geometry = binding.control === "virtual" ? {
    applied: command.source === null ? null : {width: 640, height: 360, outputWidth: 1920, outputHeight: 1080, virtual: true},
    observed: {width: 640, height: 360}
  } : {};
  const status = {schema: 1, launchId: command.launchId, epoch: command.epoch, revision: command.revision, control: command.control,
    requested: command.source, applied: command.source === null ? null : {scale: 0.5, scalingMode: 0, viewportWidth: 1920, viewportHeight: 1080}, reason: "", ...geometry, ...patch};
  fs.writeFileSync(binding.statusFile + ".next", JSON.stringify(status));fs.renameSync(binding.statusFile + ".next", binding.statusFile);
}
function responder(t, binding) {
  let seen = 0;
  const timer = setInterval(() => { const value = read(binding.file);if (value.epoch !== seen) {seen = value.epoch;acknowledge(binding, value);} }, 2);
  t.after(() => clearInterval(timer));
}
test("adaptive virtual source controls retain their launch identity and require verified applied pixels", async t => {
  const f = fixture(t), support = {control: "virtual", live: true, activationAPI: 1, automatic: true, heights: true, multipliers: [1, 2, 3]};
  const {binding} = Controls.prepare(f.entry, {userDataDir: f.userDataDir, support, launchId: "adaptive"});
  assert.throws(() => Controls.normalize({automatic: true}, {...support, automatic: false}), /automatic source sizing/);
  const transaction = Controls.stage({automatic: true}, {binding});
  assert.deepEqual(transaction.command.source, {automatic: true});assert.equal(Controls.completed(binding), null);
  acknowledge(binding, transaction.command, {sessionReady: true});await transaction.wait();
  assert.deepEqual(Controls.completed(binding).dimensions, {width: 640, height: 360});
  const bytes = fs.readFileSync(binding.file);
  assert.equal(Controls.stage({automatic: true}, {binding}).changed, false, "window resize needs no new command or epoch");
  assert.deepEqual(fs.readFileSync(binding.file), bytes);
  const original = Controls.stage(null, {binding});acknowledge(binding, original.command, {sessionReady: false, observed: undefined});await original.wait();
  assert.equal(Controls.completed(binding), null, "Original acknowledgement is not a fabricated allocation proof");
});
test("Original restoration remains available when an accepted automatic source has no current completed receipt", async t => {
  const f = fixture(t), virtual = {control: "virtual", live: true, activationAPI: 1, automatic: true, heights: true, multipliers: [1, 2, 3]};
  for (const state of ["waiting", "rejected", "missing", "stale"]) {
    const {binding} = Controls.prepare(f.entry, {userDataDir: f.userDataDir, support: virtual, launchId: "restore-" + state, source: {automatic: true}});
    const accepted = {...read(binding.file), epoch: 3};
    fs.writeFileSync(binding.file, JSON.stringify(accepted));
    acknowledge(binding, accepted, {sessionReady: true});
    assert.ok(Controls.completed(binding), "start from an actually acknowledged source contract");
    if (state === "missing") fs.unlinkSync(binding.statusFile);
    else acknowledge(binding, state === "stale" ? {...accepted, epoch: 2} : accepted,
      state === "waiting" ? {reason: "Waiting for a completed image."} : state === "rejected" ? {reason: "The source image is unavailable.", applied: null} : {});
    assert.equal(Controls.completed(binding), null, state);
    const bytes = fs.readFileSync(binding.file);
    assert.throws(() => Controls.stage({multiplier: 3}, {binding}), {code: "GRAPHICS_SOURCE_UNAVAILABLE"}, state);
    assert.deepEqual(fs.readFileSync(binding.file), bytes, "unverified reduction cannot replace the accepted command");
    const original = Controls.stage(null, {binding, timeoutMs: 20, pollIntervalMs: 1});
    assert.equal(original.changed, true);assert.equal(original.command.epoch, 4);
    assert.equal(read(binding.file).source, null);
    assert.equal(Controls.completed(binding), null, "issuing Original does not fabricate a completed receipt");
    await assert.rejects(original.wait(), {code: "GRAPHICS_SOURCE_TIMEOUT"}, "Original still requires its actual native acknowledgement");
    acknowledge(binding, original.command, {reason: "Original could not be restored."});
    await assert.rejects(original.wait(), {code: "GRAPHICS_SOURCE_REJECTED"}, "a native restoration failure remains visible");
    acknowledge(binding, original.command, {sessionReady: false, observed: undefined});
    assert.equal((await original.wait()).applied, null);
    assert.equal(Controls.completed(binding), null, "a null restoration acknowledgement is not allocation evidence");
  }
});
test("unsupported source controls do no I/O and live capability stays renderer-declared", t => {
  const absent = path.join(os.tmpdir(), "source-absent-" + process.pid + "-" + Date.now());
  assert.equal(Controls.prepare({}, {userDataDir: absent, support: {live: false}}), null);assert.equal(fs.existsSync(absent), false);
  assert.equal(Source.capabilities("window", {sourceResolution: support}).live, true);
  assert.equal(Source.capabilities("window", {sourceResolution: {...support, live: false}}).live, undefined);
  assert.equal(Source.capabilities("remote", {sourceResolution: support}).live, undefined);
  assert.equal(Source.capabilities("window", {sourceResolution: false}, [], true).live, undefined);
  assert.deepEqual(Controls.normalize({height: 480, maximum: true, method: "fsr1"}, support), {height: 480, maximum: true, method: "fsr1"});
  for (const value of [{height: 0}, {height: 480, multiplier: 2}, {multiplier: 4}, {multiplier: true}, {height: 480, method: "unknown"}])
    assert.throws(() => Controls.normalize(value, support));
});
test("source channel paths are unique per launch and null all-off staging changes nothing", async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.binding.file);
  const other = Controls.prepare(f.entry, {userDataDir: f.userDataDir, support, launchId: "other-launch"});
  assert.notEqual(other.binding.file, f.binding.file);
  assert.equal(f.environment.RESHADE_RENDER_SOURCE_LAUNCH_ID, f.binding.launchId);
  const transaction = Controls.stage(null, {binding: f.binding});
  assert.equal(transaction.changed, false);assert.equal(await transaction.wait(), null);assert.equal(await transaction.rollback(), true);
  assert.deepEqual(fs.readFileSync(f.binding.file), bytes);assert.equal(fs.existsSync(f.binding.statusFile), false);
});
test("native and dormant virtual channels share one launch without sharing commands or acknowledgements", async t => {
  const f = fixture(t), virtual = Controls.prepare(f.entry, {userDataDir: f.userDataDir, launchId: f.binding.launchId,
    channel: "virtual", support: {control: "virtual", live: true, activationAPI: 1, heights: true, percentages: true, multipliers: [1, 2]}});
  assert.equal(virtual.binding.launchId, f.binding.launchId);
  assert.notEqual(virtual.binding.file, f.binding.file);
  assert.equal(path.basename(virtual.binding.file), "source-control-owned-launch-virtual.json");
  assert.equal(virtual.environment.RESHADE_RENDER_SOURCE_CONTROL_FILE, undefined);
  assert.equal(virtual.environment.RESHADE_VIRTUAL_SOURCE_CONTROL_FILE, virtual.binding.file);
  const launch = {sourceControl: f.binding, sourceControls: {engine: f.binding, virtual: virtual.binding}};
  assert.deepEqual(Controls.active(launch), []);
  const update = Controls.stage({multiplier: 100 / 63}, {binding: virtual.binding});
  acknowledge(f.binding, update.command);
  assert.equal(Controls.completed(virtual.binding), null, "an engine receipt cannot acknowledge the virtual channel");
  acknowledge(virtual.binding, update.command, {sessionReady: true});await update.wait();
  assert.deepEqual(Controls.active(launch), [virtual.binding]);
  assert.equal(read(f.binding.file).source, null, "the original native command remains untouched");
  assert.throws(() => Controls.stage(null, {binding: {...virtual.binding, file: f.binding.file}}), /no live render source channel/);
});
for (const shape of ["both-channels", "virtual-only", "legacy-single"]) test(`Clear effects restores the actual source owner (${shape})`, async t => {
  const f = fixture(t), Effects = require("../src/modules/shared/effects/runtime"), Live = require("../src/modules/shared/reshade/live-controls"),
    Update = require("../src/main/graphics-update");
  const directory = path.dirname(f.binding.file), entry = {...f.entry, effects: null},
    virtual = Controls.prepare(entry, {userDataDir: f.userDataDir, launchId: f.binding.launchId, channel: "virtual",
      source: {multiplier: 2}, support: {control: "virtual", live: true, activationAPI: 1, multipliers: [1, 2]}}).binding;
  let launch = {schema: 1, launchId: f.binding.launchId, pid: 4242, phase: "spawned", live: true, effectPlanAPI: 1};
  if (shape === "legacy-single") {
    const selected = Controls.stage({multiplier: 2}, {binding: f.binding});acknowledge(f.binding, selected.command);
    launch.sourceControl = f.binding;
  } else {
    acknowledge(virtual, read(virtual.file), {sessionReady: true});
    launch.sourceControls = shape === "virtual-only" ? {virtual} : {engine: f.binding, virtual};
    if (shape === "both-channels") launch.sourceControl = f.binding;
  }
  fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify(launch));
  const planFile = path.join(directory, "effect-plan.json");fs.writeFileSync(planFile, JSON.stringify({schema: 1, mode: "advanced", revision: "accepted", nodes: []}));
  const owner = shape === "legacy-single" ? f.binding : virtual;responder(t, owner);
  assert.equal(Controls.active(launch).length, 1);
  // The launcher's Clear effects route: inert controls and an empty Simple document.
  await Update.apply(entry, {running: true, isCurrent: () => true, launchBinding: launch, userDataDir: f.userDataDir}, options => {
    Live.write(entry, f.userDataDir, options);Effects.publishSimple(entry, f.userDataDir, options);
  }, createPublication);
  assert.deepEqual(Controls.active(launch), []);
  assert.equal(read(owner.file).source, null);
  assert.equal(read(owner.statusFile).epoch, read(owner.file).epoch, "restoration waits for this channel's actual ACK");
  assert.equal(read(planFile).mode, "advanced");assert.deepEqual(read(planFile).nodes, []);
});
test("unchanged reductions still require the exact current receipt without rewriting their command", async t => {
  const f = fixture(t), initial = Controls.stage({multiplier: 2}, {binding: f.binding});
  acknowledge(f.binding, initial.command);await initial.wait();
  const bytes = fs.readFileSync(f.binding.file);
  const repeated = Controls.stage({multiplier: 2}, {binding: f.binding, timeoutMs: 20, pollIntervalMs: 1});
  assert.equal(repeated.changed, false);assert.deepEqual(repeated.command, initial.command);
  for (const state of ["missing", "stale", "waiting", "rejected", "invalid"]) {
    if (state === "missing") fs.unlinkSync(f.binding.statusFile);
    else acknowledge(f.binding, state === "stale" ? {...initial.command, epoch: initial.command.epoch - 1} : initial.command,
      state === "waiting" ? {reason: "Waiting for a completed resized producer."} :
        state === "rejected" ? {reason: "The publisher retained a different extent."} : state === "invalid" ? {applied: {scale: 0}} : {});
    const code = state === "rejected" ? "GRAPHICS_SOURCE_REJECTED" : state === "invalid" ? "GRAPHICS_SOURCE_ACK_INVALID" : "GRAPHICS_SOURCE_TIMEOUT";
    await assert.rejects(repeated.wait(), {code}, state);
    assert.deepEqual(fs.readFileSync(f.binding.file), bytes, state + " does not create a new native command");
  }
  acknowledge(f.binding, initial.command);
  const open = fs.openSync;let reads = 0;
  t.mock.method(fs, "openSync", (file, ...args) => {if (file === f.binding.statusFile) reads++;return open(file, ...args);});
  assert.equal((await repeated.wait()).epoch, initial.command.epoch);
  assert.equal(reads, 1, "an accepted current receipt returns on its first read");
  assert.equal(await repeated.rollback(), true);assert.deepEqual(fs.readFileSync(f.binding.file), bytes);
});
test("virtual controls require a previously completed proxy and Original keeps re-enable available", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-virtual-source-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const entry = {gameId: "virtual"}, virtual = {control: "virtual", live: true, heights: true, multipliers: [1, 1.5, 2, 3]};
  for (const source of [null, {multiplier: 1}]) {
    assert.equal(Controls.prepare(entry, {userDataDir, support: virtual, launchId: "off", source}), null);
    assert.deepEqual(fs.readdirSync(userDataDir), []);
  }
  const prepared = Controls.prepare(entry, {userDataDir, support: virtual, launchId: "active", source: {multiplier: 2}});
  const before = fs.readFileSync(prepared.binding.file), initial = read(prepared.binding.file);
  assert.equal(Controls.stage({multiplier: 2}, {binding: prepared.binding}).changed, false, "unchanged source does not block an independent shader update");
  assert.throws(() => Controls.stage({multiplier: 3}, {binding: prepared.binding}), /virtual render source has not completed/);
  acknowledge(prepared.binding, initial, {sessionReady: false});
  assert.throws(() => Controls.stage({multiplier: 3}, {binding: prepared.binding}), /virtual render source has not completed/);
  assert.deepEqual(fs.readFileSync(prepared.binding.file), before);
  acknowledge(prepared.binding, initial, {sessionReady: true});
  const original = Controls.stage(null, {binding: prepared.binding});acknowledge(prepared.binding, original.command, {sessionReady: true});await original.wait();
  const enabled = Controls.stage({multiplier: 3}, {binding: prepared.binding});assert.equal(enabled.command.source.multiplier, 3);
});
test("virtual activation is selected-core gated and starts with metadata only", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-virtual-dormant-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const virtual = Source.capabilities("window", {}, [], {activationAPI: 1});
  assert.equal(virtual.activationAPI, 1);assert.equal(virtual.live, true);
  assert.equal(Source.capabilities("window", {}, [], true).activationAPI, undefined);
  const prepared = Controls.prepare({gameId: "dormant"}, {userDataDir, support: virtual, launchId: "dormant", source: {multiplier: 1}});
  assert.equal(prepared.binding.activationAPI, 1);assert.equal(read(prepared.binding.file).source, null);
  assert.equal(prepared.environment.RESHADE_RENDER_SOURCE_ACTIVATION_API, "1");
  assert.equal(prepared.environment.RESHADE_RENDER_SOURCE_CONTROL, "virtual");
  assert.equal(fs.existsSync(prepared.binding.statusFile), false);assert.equal(Controls.completed(prepared.binding), null);
  assert.deepEqual(fs.readdirSync(path.dirname(prepared.binding.file)), [path.basename(prepared.binding.file)]);
  const next = Controls.stage({multiplier: 2}, {binding: prepared.binding, timeoutMs: 30, pollIntervalMs: 2});
  assert.equal(next.command.epoch, 2);
  // A requested proxy, layout acknowledgement, or old null status is not a
  // completed allocation. First activation still needs actual producer pixels.
  acknowledge(prepared.binding, next.command, {reason: "Waiting for a completed frame.", applied: null, observed: undefined});
  await assert.rejects(next.wait(), {code: "GRAPHICS_SOURCE_TIMEOUT"});
  assert.throws(() => Controls.stage({multiplier: 3}, {binding: prepared.binding}), {code: "GRAPHICS_SOURCE_UNAVAILABLE"});
  acknowledge(prepared.binding, next.command, {sessionReady: true});await next.wait();
  const off = Controls.stage(null, {binding: prepared.binding});
  acknowledge(prepared.binding, off.command, {applied: null, observed: undefined, sessionReady: false});await off.wait();
  assert.equal(Controls.completed(prepared.binding), null, "a no-allocation ACK is not a completed frame receipt");
  const again = Controls.stage({height: 480}, {binding: prepared.binding});assert.equal(again.changed, true);
});
test("dormant virtual activation rejects stale null acknowledgements", t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-virtual-dormant-stale-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const support = {control: "virtual", live: true, activationAPI: 1, heights: true, multipliers: [1, 2, 3]};
  const {binding} = Controls.prepare({gameId: "dormant"}, {userDataDir, support, launchId: "stale"});
  const first = Controls.stage({multiplier: 2}, {binding});acknowledge(binding, first.command, {sessionReady: true});
  const off = Controls.stage(null, {binding});
  acknowledge(binding, off.command, {epoch: off.command.epoch - 1, applied: null, observed: undefined});
  assert.throws(() => Controls.stage({multiplier: 3}, {binding}), {code: "GRAPHICS_SOURCE_UNAVAILABLE"});
});
test("legacy virtual launch binds only a selected live-source core and a requested reduction", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-virtual-launch-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const root = path.join(userDataDir, "runtime");fs.mkdirSync(path.join(root, "effects"), {recursive: true});
  for (const file of ["libreshade-macos.dylib", "fx-compile"]) fs.writeFileSync(path.join(root, file), "fixture");
  const record = {schema: 1, version: "test", minimumMacOS: "11.0", features: structuredClone(require("../src/modules/shared/reshade/features.json"))};
  delete record.features.graphics.virtualSourceActivationAPI;
  const save = () => fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(record));save();
  t.mock.method(require("../src/modules/shared/runtime/bundled-native"), "systemVersionSync", () => "27.0");
  const ReShade = require("../src/modules/shared/reshade"), options = {root, userDataDir, graphicsHost: "window", verify: () => true,
    diagnostics: false, gpuTiming: false, trace: false, execute: () => assert.fail("bilinear launch has no shader compilation")};
  const environment = await ReShade.prepare({gameId: "reduced", graphics: {spatialMethod: "bilinear", spatialMultiplier: 2}}, options);
  const launch = read(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json"));
  assert.equal(launch.sourceControl.control, "virtual");assert.equal(launch.sourceControl.support.live, true);
  assert.deepEqual(read(launch.sourceControl.file).source, {multiplier: 2});
  assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL_FILE, launch.sourceControl.file);
  for (const [gameId, graphics] of [["off", {}], ["original", {spatialMethod: "bilinear", spatialMultiplier: 1}]]) {
    const unchanged = await ReShade.prepare({gameId, graphics}, options);
    assert.equal(unchanged.RESHADE_RENDER_SOURCE_CONTROL_FILE, undefined);
    assert.equal(read(path.join(path.dirname(unchanged.RESHADE_EFFECT_PLAN), "launch.json")).sourceControl, undefined);
  }
  delete record.features.graphics.virtualSourceControlAPI;save();
  const old = await ReShade.prepare({gameId: "old", graphics: {spatialMethod: "bilinear", spatialMultiplier: 2}}, options);
  assert.equal(old.RESHADE_RENDER_SOURCE_CONTROL, "virtual");assert.equal(old.RESHADE_RENDER_SOURCE_CONTROL_FILE, undefined);
});
test("ordinary preparation reserves a dormant virtual fallback beside an engine only on a declaring core", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-multiple-source-launch-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const root = path.join(userDataDir, "runtime");fs.mkdirSync(root, {recursive: true});
  for (const file of ["libreshade-macos.dylib", "fx-compile"]) fs.writeFileSync(path.join(root, file), "fixture");
  const record = {schema: 1, version: "test", minimumMacOS: "13.0", features: structuredClone(require("../src/modules/shared/reshade/features.json"))};
  record.features.graphics.virtualSourceChannelAPI = 1;
  const save = () => fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(record));save();
  t.mock.method(require("../src/modules/shared/runtime/bundled-native"), "systemVersionSync", () => "13.0");
  const ReShade = require("../src/modules/shared/reshade"), options = {root, userDataDir, graphicsHost: "window",
    graphicsInputs: {sourceResolution: support}, verify: () => true, diagnostics: false, gpuTiming: false, trace: false,
    execute: () => assert.fail("Off must not compile or load a provider")};
  const environment = await ReShade.prepare({gameId: "dormant-multiple"}, options);
  const launch = read(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json"));
  assert.deepEqual(Object.keys(launch.sourceControls), ["engine", "virtual"]);
  assert.equal(launch.sourceControl.control, "engine");
  assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL_FILE, launch.sourceControls.engine.file);
  assert.equal(environment.RESHADE_VIRTUAL_SOURCE_CONTROL_FILE, launch.sourceControls.virtual.file);
  assert.equal(launch.sourceControls.engine.launchId, launch.sourceControls.virtual.launchId);
  assert.deepEqual(Controls.active(launch), []);
  for (const key of ["RESHADE_RENDER_MULTIPLIER", "RESHADE_RENDER_HEIGHT", "RESHADE_RENDER_AUTO"])
    assert.equal(environment[key], undefined, key);
  assert.equal(fs.existsSync(environment.RESHADE_NEURAL_LIBRARY), false, "a fixed future provider path does not load or create it");
  for (const directory of JSON.parse(environment.RESHADE_EFFECT_MODEL_ROOTS)) assert.equal(fs.existsSync(directory), false);
  delete record.features.graphics.virtualSourceChannelAPI;save();
  const legacy = await ReShade.prepare({gameId: "legacy-single"}, options);
  assert.equal(legacy.RESHADE_VIRTUAL_SOURCE_CONTROL_FILE, undefined, "older native readers retain their original single channel");
});
test("source changes stage with the publication and require the exact renderer acknowledgement", async t => {
  const f = fixture(t), publication = createPublication({isCurrent: () => true});
  const transaction = Controls.stage({multiplier: 2, method: "fsr1"}, {binding: f.binding, publication, timeoutMs: 200, pollIntervalMs: 2});
  assert.equal(read(f.binding.file).epoch, 1);assert.equal(read(f.binding.file).source, null);
  assert.equal(JSON.parse(publication.read(f.binding.file, "utf8")).epoch, 2);
  publication.commit();acknowledge(f.binding, transaction.command, {launchId: "foreign-launch"});
  assert.equal(Controls.readStatus(f.binding), null);
  setTimeout(() => acknowledge(f.binding, transaction.command), 8);
  const status = await transaction.wait();assert.equal(status.epoch, 2);assert.equal(status.applied.scale, 0.5);
});
test("rollback restores the prior source with a higher epoch after publication byte restoration", async t => {
  const f = fixture(t), publication = createPublication();
  const transaction = Controls.stage({height: 480}, {binding: f.binding, publication, timeoutMs: 200, pollIntervalMs: 2});
  publication.commit();acknowledge(f.binding, transaction.command);await transaction.wait();
  assert.equal(publication.rollback(), true);assert.equal(read(f.binding.file).epoch, 1);
  responder(t, f.binding);assert.equal(await transaction.rollback(), true);
  const restored = read(f.binding.file);assert.equal(restored.epoch, 3);assert.equal(restored.source, null);
  assert.equal(Controls.readStatus(f.binding).epoch, 3);
});
test("cancellation releases the status wait and still restores the owned source", async t => {
  const f = fixture(t), publication = createPublication(), controller = new AbortController();
  const transaction = Controls.stage({multiplier: 2}, {binding: f.binding, publication, signal: controller.signal, timeoutMs: 200, pollIntervalMs: 2});
  publication.commit();const waiting = transaction.wait();controller.abort();
  await assert.rejects(waiting, error => error.name === "AbortError");publication.rollback();
  responder(t, f.binding);assert.equal(await transaction.rollback(), true);assert.equal(read(f.binding.file).source, null);
});
test("stopped sessions and newer commands are not overwritten by source rollback", async t => {
  const f = fixture(t);let current = true;
  const transaction = Controls.stage({multiplier: 2}, {binding: f.binding, isCurrent: () => current});
  const accepted = fs.readFileSync(f.binding.file);current = false;
  await assert.rejects(transaction.wait(), {code: "GRAPHICS_LIVE_STALE"});assert.equal(await transaction.rollback(), false);
  assert.deepEqual(fs.readFileSync(f.binding.file), accepted);
  assert.throws(() => Controls.stage(null, {binding: f.binding, isCurrent: () => false}), {code: "GRAPHICS_LIVE_STALE"});
  current = true;const newer = Controls.stage({multiplier: 3}, {binding: f.binding});
  assert.equal(await transaction.rollback(), false);assert.equal(read(f.binding.file).epoch, newer.command.epoch);
});
test("missing or mismatched renderer results fail without claiming the source applied", async t => {
  const f = fixture(t), transaction = Controls.stage({height: 480}, {binding: f.binding, timeoutMs: 20, pollIntervalMs: 2});
  await assert.rejects(transaction.wait(), /did not apply/);
  acknowledge(f.binding, transaction.command, {requested: {height: 360}});
  await assert.rejects(transaction.wait(), /different source settings/);
});
test("source acknowledgements require concrete applied geometry and virtual producer observations", async t => {
  const f = fixture(t), transaction = Controls.stage({multiplier: 2}, {binding: f.binding, timeoutMs: 20, pollIntervalMs: 2});
  for (const applied of [{}, {scale: 0}, {scale: .5}, {width: 640, height: -1},
    {scale: .5, viewportWidth: 0, viewportHeight: 1080}]) {
    acknowledge(f.binding, transaction.command, {applied});
    await assert.rejects(transaction.wait(), /invalid applied source dimensions/);
  }
  const virtual = {...f.binding, control: "virtual", support: {...support, control: "virtual"}};
  const original = read(f.binding.file);original.control = "virtual";
  const crypto = require("node:crypto");
  original.revision = crypto.createHash("sha256").update(JSON.stringify({control: "virtual", source: original.source})).digest("hex");
  fs.writeFileSync(virtual.file, JSON.stringify(original));
  acknowledge(virtual, original, {sessionReady: true});
  const changed = Controls.stage({multiplier: 3}, {binding: virtual, timeoutMs: 20, pollIntervalMs: 2});
  acknowledge(virtual, changed.command, {observed: undefined, sessionReady: true, applied: {width: 640, height: 360, virtual: true, outputWidth: 1920, outputHeight: 1080}});
  await assert.rejects(changed.wait(), /invalid applied source dimensions/);
  acknowledge(virtual, changed.command, {observed: {width: 640, height: 480}, sessionReady: true,
    applied: {width: 640, height: 360, virtual: true, outputWidth: 1920, outputHeight: 1080}});
  await assert.rejects(changed.wait(), /invalid applied source dimensions/);
  acknowledge(virtual, changed.command, {observed: {width: 640, height: 360}, sessionReady: true,
    applied: {width: 640, height: 360, virtual: true, outputWidth: 1920, outputHeight: 1080}});
  assert.equal((await changed.wait()).applied.width, 640);
});
test("restoring Original waits for the completed source frame and rejects a fullscreen refusal", async t => {
  const f = fixture(t);Controls.stage({multiplier: 2}, {binding: f.binding});
  const transaction = Controls.stage(null, {binding: f.binding, timeoutMs: 200, pollIntervalMs: 2});
  acknowledge(f.binding, transaction.command, {reason: "Waiting for a completed frame at the original render source size."});
  let completed = false;const waiting = transaction.wait().then(value => {completed = true;return value;});
  await new Promise(resolve => setTimeout(resolve, 10));assert.equal(completed, false);
  acknowledge(f.binding, transaction.command);assert.equal((await waiting).applied, null);
  acknowledge(f.binding, transaction.command, {reason: "Exit fullscreen before restoring the original game window."});
  await assert.rejects(transaction.wait(), /Exit fullscreen/);
});
test("completed source receipts match the current command and expose actual engine dimensions", t => {
  const f = fixture(t), transaction = Controls.stage({multiplier: 2}, {binding: f.binding});
  assert.equal(Controls.completed(f.binding), null);
  acknowledge(f.binding, transaction.command);
  const receipt = Controls.completed(f.binding);
  assert.equal(receipt.verified, true);assert.deepEqual(receipt.dimensions, {width: 960, height: 540});
  assert.deepEqual(receipt.outputSize, {width: 1920, height: 1080});
  acknowledge(f.binding, transaction.command, {epoch: transaction.command.epoch - 1});
  assert.equal(Controls.completed(f.binding), null);
  acknowledge(f.binding, transaction.command, {reason: "Waiting for a completed frame."});
  assert.equal(Controls.completed(f.binding), null);
  acknowledge(f.binding, transaction.command, {requested: {multiplier: 3}});
  assert.equal(Controls.completed(f.binding), null);
});
test("a completed non-proxy source can acknowledge already-satisfied dimensions without a proxy", async t => {
  const f = fixture(t), virtual = {...support, control: "virtual", methods: undefined};
  const prepared = Controls.prepare(f.entry, {userDataDir: f.userDataDir, support: virtual, launchId: "physical", source: {multiplier: 2}});
  const initial = read(prepared.binding.file);
  acknowledge(prepared.binding, initial, {sessionReady: false, applied: {width: 1920, height: 1080, virtual: false}, observed: {width: 1920, height: 1080}});
  const receipt = Controls.completed(prepared.binding);
  assert.equal(receipt.verified, true);assert.equal(receipt.status.applied.virtual, false);
  const decision = Source.resolve(initial.source, {host: "window", virtualWindow: true, outputSize: {width: 3840, height: 2160}, completedSource: receipt});
  assert.equal(decision.satisfied, true);assert.equal(decision.requiresSourceChange, false);
  const next = Controls.stage({multiplier: 3}, {binding: prepared.binding, timeoutMs: 200, pollIntervalMs: 2});
  let finished = false;const waiting = next.wait().then(value => {finished = true;return value;});
  await new Promise(resolve => setTimeout(resolve, 8));assert.equal(finished, false, "old physical receipt cannot acknowledge a new request");
  acknowledge(prepared.binding, next.command, {sessionReady: true});assert.equal((await waiting).epoch, next.command.epoch);
});
test("a stale ready flag cannot admit a new virtual source change", t => {
  const f = fixture(t), virtual = {...support, control: "virtual", methods: undefined};
  const prepared = Controls.prepare(f.entry, {userDataDir: f.userDataDir, support: virtual, launchId: "stale-ready", source: {multiplier: 2}});
  const initial = read(prepared.binding.file), before = fs.readFileSync(prepared.binding.file);
  for (const patch of [{epoch: initial.epoch + 1}, {revision: "f".repeat(64)}, {requested: {multiplier: 3}}, {reason: "Waiting for a completed frame."}]) {
    acknowledge(prepared.binding, initial, {sessionReady: true, ...patch});
    assert.throws(() => Controls.stage({multiplier: 3}, {binding: prepared.binding}), /virtual render source has not completed/);
    assert.deepEqual(fs.readFileSync(prepared.binding.file), before);
  }
});
