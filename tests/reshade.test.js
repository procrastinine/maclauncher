const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ReShade = require("../src/modules/shared/reshade");
const Native = require("../src/modules/shared/runtime/bundled-native");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-reshade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime"), userDataDir = path.join(root, "profile");
  fs.mkdirSync(path.join(runtime, "effects"), { recursive: true });
  for (const file of ["libreshade-macos.dylib", "fx-compile", "effects/crt.fx"])
    fs.writeFileSync(path.join(runtime, file), "fixture");
  fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({ schema: 1, version: "test", minimumMacOS: "11.0" }));
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  return { root: runtime, userDataDir, diagnostics: false, gpuTiming: false, trace: false, verify: () => true };
}
test("ReShade is default-off and disabled launches never inspect or compile a runtime", async () => {
  assert.deepEqual(ReShade.normalizeSettings(), { enabled: false, preset: "crt", effectPath: null });
  assert.deepEqual(await ReShade.prepare({ reshade: { enabled: false } }, { root: "/missing", execute: () => assert.fail("disabled") }), {});
});
test("ordinary Advanced launch bypasses unavailable rows and preserves independent selected stages", async t => {
  const options = fixture(t), record = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json")));
  record.features = require("../src/modules/shared/reshade/features.json");
  fs.writeFileSync(path.join(options.root,"runtime.json"),JSON.stringify(record));
  const effects = {schema:1,mode:"advanced",video:[
    {id:"missing-scene",kind:"temporal",enabled:true,method:"metalfx",settings:{}},
    {id:"selected",kind:"spatial",enabled:true,method:"bilinear",settings:{}}
  ]};
  const entry = {gameId:"selected-stage",effects}, before = structuredClone(entry);
  const Effects = require("../src/modules/shared/effects/runtime"), prepare = Effects.prepare, requests = [];
  t.mock.method(Effects,"prepare",async (...args)=>{
    requests.push(args[1]);return prepare(...args);
  });
  const environment = await ReShade.prepare(entry,{...options,graphicsHost:"window",execute:()=>assert.fail("no selected shader")});
  const document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN),"launch.json")));
  assert.equal(requests.length,1);assert.equal(requests[0].fallback,true);assert.equal(requests[0].launchPreparation,true);
  assert.equal(document.nodes.find(row=>row.id==="missing-scene").enabled,false);
  assert.equal(document.nodes.find(row=>row.id==="selected").enabled,true);
  assert.deepEqual(launch.graphicsPreparation.applied.map(row=>row.id),["selected"]);
  assert.deepEqual(launch.graphicsPreparation.skipped.map(row=>row.id),["missing-scene"]);
  assert.equal(environment.RESHADE_TEMPORAL_METHOD,undefined);assert.deepEqual(entry,before);
});
test("standalone optional Simple availability failure reports skipped stages after preserving the legacy attempt", async t => {
  const options = fixture(t), record = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json")));
  record.features = require("../src/modules/shared/reshade/features.json");fs.writeFileSync(path.join(options.root, "runtime.json"), JSON.stringify(record));
  const Effects = require("../src/modules/shared/effects/runtime"), original = Effects.prepare, requests = [];
  t.mock.method(Effects, "prepare", async (...args) => {requests.push(args[1]);return original(...args);});
  const environment = await ReShade.prepare({gameId: "missing-model", graphics: {frameGeneration: "lsfg"}}, {
    ...options, graphicsHost: "window", execute: () => assert.fail("no selected shader")
  });
  assert.equal(requests.length, 1);assert.equal(requests[0].fallback, true);assert.equal(requests[0].fallbackPolicy, "simple");
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(launch.graphicsPreparation.applied, []);assert.deepEqual(launch.graphicsWarnings.map(row => row.kind), ["frame-generation"]);
  assert.match(launch.graphicsWarnings[0].reason, /Lossless Scaling Frame Generation.*models/);
});
test("Simple launch fallback preserves core verification, cancellation and actual temporal input requirements", async t => {
  const options = fixture(t), record = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json")));
  record.features = require("../src/modules/shared/reshade/features.json");fs.writeFileSync(path.join(options.root, "runtime.json"), JSON.stringify(record));
  const Effects = require("../src/modules/shared/effects/runtime"), prepare = Effects.prepare, requests = [];
  t.mock.method(Effects,"prepare",async (...args)=>{requests.push(args[1]);return prepare(...args);});
  const resolutions = [];
  t.mock.method(require("../src/modules/shared/reshade/models"), "resolveModel", (...args) => {
    resolutions.push(args);assert.fail("failed core or absent models cannot resolve a DLL");
  });
  const entry = {gameId: "retry-boundary", graphics: {frameGeneration: "lsfg"}};
  await assert.rejects(ReShade.prepare(entry, {...options, graphicsHost: "window", verify: () => {throw new Error("Core checksum changed");}}), /Core checksum changed/);
  assert.equal(fs.existsSync(options.userDataDir),false,"a rejected core never publishes graphics state");
  const attempts = requests.length;
  const Graphics = require("../src/modules/shared/reshade/graphics-settings");
  const prepareGraphics = Graphics.prepare;
  const abort = Object.assign(new Error("Cancelled"), {name: "AbortError", code: "GRAPHICS_OPTIONAL_UNAVAILABLE"});
  t.mock.method(Graphics, "prepare", async () => {throw abort;});
  await assert.rejects(ReShade.prepare(entry, {...options, graphicsHost: "window"}), {name: "AbortError"});
  assert.equal(requests.length,attempts,"cancellation cannot retry through the ordered processor");
  Graphics.prepare.mock.mockImplementation(prepareGraphics);
  const mixed = {...entry,graphics:{temporalMethod:"metalfx",frameGeneration:"lsfg"}}, before = structuredClone(mixed);
  const environment = await ReShade.prepare(mixed,{...options,graphicsHost:"window"});
  const document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN),"launch.json")));
  assert.ok(document.nodes.every(row=>row.enabled===false));
  assert.deepEqual(launch.graphicsPreparation.applied,[]);
  assert.deepEqual(launch.graphicsPreparation.skipped.map(row=>row.kind),["temporal","frame-generation"]);
  assert.equal(environment.RESHADE_TEMPORAL_METHOD,undefined);assert.equal(environment.RESHADE_LOSSLESS_MODEL,undefined);
  assert.deepEqual(resolutions,[],"even a caught discovery failure would violate this boundary");
  assert.deepEqual(mixed,before);
});
test("Simple CRT keeps its original shader path without resolution, neural or advanced stages", {skip: process.platform !== "darwin"}, async t => {
  const options = fixture(t), entry = {gameId: "crt-only", reshade: {enabled: true, preset: "crt"}}, before = structuredClone(entry);
  const record = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json")));
  record.features = {graphics: {effectPlanAPI: 1, presentation: {hosts: {window: {spatial: true}}}}};
  fs.writeFileSync(path.join(options.root, "runtime.json"), JSON.stringify(record));
  t.mock.method(require("../src/modules/shared/effects/runtime"), "prepare", () => assert.fail("CRT does not activate the advanced executor"));
  const Neural = require("../src/modules/shared/reshade/neural"), discovery = [];
  for (const method of ["prepare","resolve","listModels"])
    t.mock.method(Neural,method,()=>{discovery.push("neural."+method);assert.fail("CRT does not discover or prepare neural providers/models");});
  t.mock.method(require("../src/modules/shared/reshade/models"),"listInstalled",()=>{discovery.push("models.listInstalled");assert.fail("CRT does not inventory Lossless models");});
  const execute = async (_command, args) => {
    if (args[0] === "--prepare") fs.writeFileSync(args[2], "prepared CRT");
    else fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
  };
  const environment = await ReShade.prepare(entry, {...options, execute, graphicsHost: "window",
    graphicsInputs: {sourceResolution: {control: "engine", heights: true, multipliers: [1, 2]}}});
  assert.equal(JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)).mode, "simple");
  for (const key of ["RESHADE_RENDER_SOURCE_CONTROL", "RESHADE_RENDER_HEIGHT", "RESHADE_RENDER_MAX_HEIGHT", "RESHADE_RENDER_MULTIPLIER", "RESHADE_RESOLUTION_MULTIPLIER", "RESHADE_NEURAL_MODELS"])
    assert.equal(environment[key], undefined, key);
  assert.equal(environment.RESHADE_NEURAL_LIBRARY,Neural.libraryPath(options.root),"a pure candidate path permits future live activation without provider discovery");
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN),"launch.json")));
  assert.equal(launch.executionRequirements.needed.neural,false);
  assert.deepEqual(discovery,[],"a caught provider failure must not hide unwanted discovery");
  assert.ok(environment.RESHADE_LIVE_EFFECTS);assert.deepEqual(entry, before);
  assert.equal(fs.readFileSync(path.join(options.root, "effects/crt.fx"), "utf8"), "fixture");
});
for (const failure of ["throw", "reject"]) test(`prepared graphics survive informational notification ${failure}`, {skip: process.platform !== "darwin"}, async t => {
  const options = fixture(t), entry = {gameId: "info-boundary", reshade: {enabled: true, preset: "crt"}};
  const before = structuredClone(entry), messages = [];
  const execute = async (_command, args) => {
    if (args[0] === "--prepare") fs.writeFileSync(args[2], "prepared CRT");
    else fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
  };
  const environment = await ReShade.prepare(entry, {...options, execute, logger: {info(message) {
    messages.push(message);
    if (failure === "throw") throw new Error("notification unavailable");
    return Promise.reject(new Error("notification unavailable"));
  }}});
  await new Promise(setImmediate);
  assert.equal(messages.length, 1);assert.match(messages[0], /Prepared crt/);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, path.join(options.root, "libreshade-macos.dylib"));
  assert.equal(fs.readFileSync(environment.RESHADE_PREPARED_EFFECT, "utf8"), "prepared CRT");
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_CONTROL_FILE), "launch.json"))).phase, "prepared");
  assert.deepEqual(entry, before);
});
test("ordered-plan support does not inject an inactive processor into an unadapted publisher", async t => {
  const options = fixture(t), record = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json")));
  record.features = { graphics: { effectPlanAPI: 1 } };
  fs.writeFileSync(path.join(options.root, "runtime.json"), JSON.stringify(record));
  for (const graphicsHost of [undefined, null, "unadapted"]) assert.deepEqual(await ReShade.prepare({ gameId: "unadapted" },
    { ...options, graphicsHost, execute: () => assert.fail("inactive shader preparation"), verify: () => assert.fail("inactive payload inspection") }), {});
  assert.equal(fs.existsSync(options.userDataDir), false);
});
test("active Lossless Scaling binds its selected model once and rejects unsupported live activation", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t), Models = require("../src/modules/shared/reshade/models");
  const record = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json")));
  record.features = require("../src/modules/shared/reshade/features.json");
  fs.writeFileSync(path.join(options.root, "runtime.json"), JSON.stringify(record));
  const version = "sha256-" + "a".repeat(64), used = [], resolved = [];
  const model = { version, modelPath: "/installed/Lossless.dll", inspection: { capabilities: {
    lsfgFp16Quality: { compatible:true }, lsfgFp32Quality: { compatible:false }
  } } };
  t.mock.method(Models, "listInstalled", () => [model]);
  t.mock.method(Models, "resolveModel", async (_directory, selected, capability) => { resolved.push([selected, capability]);return model; });
  const Effects = require("../src/modules/shared/effects/runtime"), original = Effects.prepare, ordered = [];
  t.mock.method(Effects, "prepare", async (...args) => {ordered.push(args);return original(...args);});
  const inactive = { gameId: "inactive", graphics: { modelVersion: version } };
  const entry = { gameId: "active", graphics: { modelVersion: version, frameGeneration: "lsfg" } };
  const context = { ...options, graphicsHost:"window", execute: () => assert.fail("disabled shader compilation"), useModel: async selected => used.push(selected) };
  const ready = await ReShade.prepare(inactive, context);
  assert.equal(ready.DYLD_INSERT_LIBRARIES, path.join(options.root, "libreshade-macos.dylib"));
  assert.deepEqual(JSON.parse(fs.readFileSync(ready.RESHADE_EFFECT_PLAN)).nodes, []);
  assert.deepEqual(used, []);assert.deepEqual(resolved, []);
  const env = await ReShade.prepare(entry, context);
  assert.equal(env.RESHADE_LOSSLESS_MODEL, model.modelPath);assert.deepEqual(used, [version]);
  assert.deepEqual(resolved, [[version,"lsfgFp16Quality"]]);
  assert.equal(ordered.length, 0, "successful standalone LSFG keeps its original preparation path");
  assert.ok(env.RESHADE_LIVE_EFFECTS);assert.equal(env.RESHADE_EFFECT, undefined);
  await ReShade.validateLiveGraphics({ ...entry, graphics:{ frameGeneration:"lsfg" } }, context);
  assert.equal(resolved.length, 1, "live edits use launch metadata, without rereading or hashing the DLL");
  assert.equal(await ReShade.validateLiveGraphics({ ...entry, graphics:{ frameGeneration:"lsfg", lsfgFp16:false } }, context), false);
  t.mock.method(Models, "resolveModel", async () => { throw Error("damaged DLL"); });
  assert.ok((await ReShade.prepare(inactive, context)).RESHADE_EFFECT_PLAN, "an unused damaged model is never resolved");
  const before = structuredClone(entry), fallback = await ReShade.prepare(entry, context);
  const document = JSON.parse(fs.readFileSync(fallback.RESHADE_EFFECT_PLAN));
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(fallback.RESHADE_EFFECT_PLAN),"launch.json")));
  assert.equal(document.nodes.find(row=>row.kind==="frame-generation").enabled,false);
  assert.equal(fallback.RESHADE_LOSSLESS_MODEL,undefined,"a rejected model is never passed to the runtime");
  assert.deepEqual(launch.effectPlanModels,[]);assert.deepEqual(launch.effectPlanBindings,{});
  assert.deepEqual(launch.graphicsPreparation.applied,[]);
  assert.match(launch.graphicsWarnings.find(row=>row.kind==="frame-generation").reason,/damaged DLL/);
  assert.equal(ordered.length,1,"a rejected optional model bypasses its row without aborting the game");
  assert.deepEqual(entry,before,"fallback retains the saved selection");
  assert.deepEqual(await ReShade.prepare(inactive, { ...context, root:"/missing" }), {});
  await assert.rejects(ReShade.prepare({ ...entry, reshade:{ enabled:true } }, { ...context, root:"/missing" }), /not included/);
});
test("effect selections validate patches and preserve other game preferences", () => {
  const selected = { enabled: true, preset: "custom", effectPath: "/Effects/Colour.fx" };
  assert.deepEqual(ReShade.updateSettings(selected, { enabled: false }), { ...selected, enabled: false });
  assert.equal(ReShade.updateSettings(selected, { preset: "grayscale" }).preset, "grayscale");
  assert.ok(ReShade.PRESETS.some(preset => preset.id === "grayscale" && preset.label === "Grayscale"));
  assert.equal(ReShade.updateSettings(selected, { preset: "cas" }).preset, "cas");
  for (const patch of [{ enabled: "yes" }, { preset: "unknown" }, { effectPath: "relative.fx" }, { effectPath: "/tmp/effect.js" }, { injected: true }])
    assert.throws(() => ReShade.updateSettings(selected, patch));
});
test("explicit diagnostic capture uses only owned per-game paths and remains request-driven", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t), entry = { gameId: "capture" }, directory = path.join(options.userDataDir, "games/capture/effects/reshade");
  const env = await ReShade.prepare(entry, { ...options, graphicsHost: "window", diagnostics: true, capture: true });
  assert.equal(env.RESHADE_CAPTURE_PREFIX, path.join(directory, "frame-capture"));
  assert.equal(env.RESHADE_CAPTURE_TRIGGER, path.join(directory, "frame-capture.request"));
  assert.equal(fs.existsSync(env.RESHADE_CAPTURE_TRIGGER), false);
  const merged = ReShade.mergeEnvironment({ RESHADE_CAPTURE_PREFIX: "/outside", RESHADE_CAPTURE_FRAME: "1" }, env);
  assert.equal(merged.RESHADE_CAPTURE_PREFIX, env.RESHADE_CAPTURE_PREFIX);assert.equal(merged.RESHADE_CAPTURE_FRAME, undefined);
  const disabled = await ReShade.prepare(entry, { ...options, graphicsHost: "window", diagnostics: false, capture: true });
  assert.equal(disabled.RESHADE_CAPTURE_PREFIX, undefined);assert.equal(disabled.RESHADE_CAPTURE_TRIGGER, undefined);
});
test("explicit frame producers resolve the verified included presenter without effect preparation", { skip: process.platform !== "darwin" }, t => {
  const options = fixture(t), verified = [];
  const files = fs.readdirSync(options.root).sort();
  const library = ReShade.resolvePresentationLibrary({ ...options, verify: root => verified.push(root) });
  assert.equal(library, path.join(options.root, "libreshade-macos.dylib"));
  assert.deepEqual(verified, [options.root]);
  assert.deepEqual(fs.readdirSync(options.root).sort(), files);
  assert.equal(fs.existsSync(options.userDataDir), false);
  assert.throws(() => ReShade.resolvePresentationLibrary({ ...options, verify: () => { throw Error("checksum mismatch"); } }), /checksum mismatch/);
  fs.rmSync(library);
  assert.throws(() => ReShade.resolvePresentationLibrary({ ...options, verify: () => assert.fail("unavailable payload") }), /not included/);
});
test("runtime availability reports real platform and macOS limits", t => {
  const options = fixture(t);
  assert.equal(ReShade.getState({ ...options, platform: "darwin", macOSVersion: "27.0" }).available, true);
  assert.match(ReShade.getState({ ...options, platform: "darwin", macOSVersion: "10.15" }).reason, /requires macOS 11.0/);
  assert.equal(ReShade.getState({ ...options, platform: "linux" }).available, false);
  fs.rmSync(path.join(options.root, "fx-compile"));
  assert.equal(ReShade.getState({ ...options, platform: "darwin" }).available, false);
});
test("trusted effect environment preserves Steam libraries and stays idempotent", () => {
  const base = { DYLD_INSERT_LIBRARIES: "/steam.dylib:/shim.dylib", STEAM_DYLD_INSERT_LIBRARIES: "/steam.dylib", GAME: "original" };
  const effect = { DYLD_INSERT_LIBRARIES: "/effect.dylib", RESHADE_EFFECT: "/crt.fx" };
  const merged = ReShade.mergeEnvironment(base, effect);
  assert.equal(merged.DYLD_INSERT_LIBRARIES, "/steam.dylib:/shim.dylib:/effect.dylib");
  assert.equal(merged.STEAM_DYLD_INSERT_LIBRARIES, merged.DYLD_INSERT_LIBRARIES);
  assert.deepEqual(ReShade.mergeEnvironment(merged, effect), merged);
  assert.equal(base.RESHADE_EFFECT, undefined);
  assert.deepEqual(ReShade.mergeEnvironment(base, {}), base);
});
test("enabled preparation validates the full shader and writes only private per-game state", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t), calls = [];
  const execute = async (command, args, opts) => {
    calls.push(args);
    assert.equal(command, path.join(options.root, "fx-compile"));
    assert.equal(opts.env.DYLD_INSERT_LIBRARIES, undefined);
    if (args[0] === "--prepare") fs.writeFileSync(args[2], "prepared effect");
    else fs.writeFileSync(path.join(args[1], "validation.metal"), "compiled effect");
  };
  const result = await ReShade.prepare({ gameId: "game-1", reshade: { enabled: true } }, { ...options, execute });
  assert.equal(calls.length, 2);
  const owned = path.join(options.userDataDir, "games/game-1/effects/reshade");
  assert.equal(fs.readFileSync(result.RESHADE_PREPARED_EFFECT, "utf8"), "prepared effect");
  assert.equal(fs.statSync(result.RESHADE_WINDOW_STATE).size, 4096);
  assert.deepEqual(fs.readdirSync(owned).sort(), ["controls.bin", "launch.json", "prepared.fx", "window-state"]);
  const receipt = JSON.parse(fs.readFileSync(path.join(owned, "launch.json"), "utf8"));
  assert.equal(receipt.phase, "prepared");
  assert.equal(receipt.adapterVersion, "test");
  assert.equal(receipt.diagnostics, false);
  assert.equal(receipt.gpuTiming, false);
  assert.equal(receipt.trace, false);
  assert.equal(result.RESHADE_TRACE, undefined);
  assert.equal(result.RESHADE_DIAGNOSTICS, undefined);
  assert.equal(result.RESHADE_GPU_TIMING, undefined);
  assert.equal(fs.readFileSync(path.join(options.root, "effects/crt.fx"), "utf8"), "fixture");
});
test("native diagnostics and GPU timing are independent and use per-launch owned paths", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t);
  const entry = { gameId: "game-1", runtimeId: "default", reshade: { enabled: true } };
  const execute = async (_command, args) => { if (args[0] === "--prepare") fs.writeFileSync(args[2], "prepared effect"); };
  const first = await ReShade.prepare(entry, { ...options, execute, runtimeId: "nwjs", diagnostics: true, gpuTiming: false, trace: true });
  const owned = path.join(options.userDataDir, "games/game-1/effects/reshade");
  const receipt = JSON.parse(fs.readFileSync(path.join(owned, "launch.json"), "utf8"));
  assert.equal(receipt.runtimeId, "nwjs");
  assert.equal(first.RESHADE_DIAGNOSTICS, path.join(owned, "diagnostics-" + receipt.launchId));
  assert.equal(first.RESHADE_GPU_TIMING, undefined);
  assert.equal(ReShade.mergeEnvironment({ RESHADE_TRACE: "1" }, first).RESHADE_TRACE, "1");
  assert.equal(receipt.trace, true);
  const second = await ReShade.prepare(entry, { ...options, execute, diagnostics: false, gpuTiming: true });
  const next = JSON.parse(fs.readFileSync(path.join(owned, "launch.json"), "utf8"));
  assert.notEqual(next.launchId, receipt.launchId);
  assert.equal(second.RESHADE_DIAGNOSTICS, undefined);
  assert.equal(ReShade.mergeEnvironment({ RESHADE_TRACE: "1" }, second).RESHADE_TRACE, undefined);
  assert.equal(second.RESHADE_GPU_TIMING, path.join(owned, "gpu-timing-" + next.launchId));
  assert.equal(next.phase, "prepared", "preparation never claims successful presentation");
  assert.equal(JSON.stringify(next).includes("PATH"), false);
});
test("invalid custom shaders prevent launch without replacing a prior prepared effect", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t), owned = path.join(options.userDataDir, "games/game-1/effects/reshade");
  fs.mkdirSync(owned, { recursive: true }); fs.writeFileSync(path.join(owned, "prepared.fx"), "previous");
  const execute = async (_command, args) => {
    if (args[0] === "--prepare") fs.writeFileSync(args[2], "broken shader");
    else throw Object.assign(new Error("compile failed"), { stderr: "unsupported technique" });
  };
  await assert.rejects(ReShade.prepare({ gameId: "game-1", reshade: { enabled: true, preset: "custom", effectPath: path.join(options.root, "effects/crt.fx") } }, { ...options, execute }), /could not be prepared.*\nunsupported technique/);
  assert.equal(fs.readFileSync(path.join(owned, "prepared.fx"), "utf8"), "previous");
  assert.deepEqual(fs.readdirSync(owned), ["prepared.fx"]);
});
test("common scaling preparation shares injection without enabling or compiling a shader", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t);
  const manifest = path.join(options.root, "runtime.json"), record = JSON.parse(fs.readFileSync(manifest));
  record.features = { graphics: { presentation: { spatial: true }, spatialMethods: ["metalfx"] } };
  fs.writeFileSync(manifest, JSON.stringify(record));
  const environment = await ReShade.prepare({ gameId: "scaling", graphics: { spatialMethod: "metalfx" } },
    { ...options, execute: () => assert.fail("no shader requested") });
  assert.ok(environment.DYLD_INSERT_LIBRARIES);assert.equal(environment.RESHADE_SPATIAL_METHOD, "metalfx");
  assert.equal(environment.RESHADE_EFFECT, undefined);assert.equal(environment.RESHADE_PREPARED_EFFECT, undefined);
  const merged = ReShade.mergeEnvironment({ DYLD_INSERT_LIBRARIES: "/steam.dylib", RESHADE_EFFECT: "/stale.fx", RESHADE_LOSSLESS_MODEL: "/stale.dll" }, environment);
  assert.equal(merged.RESHADE_EFFECT, undefined);assert.equal(merged.RESHADE_LOSSLESS_MODEL, undefined);
  assert.equal(merged.DYLD_INSERT_LIBRARIES, "/steam.dylib:" + environment.DYLD_INSERT_LIBRARIES);
  const receipt = JSON.parse(fs.readFileSync(path.join(options.userDataDir, "games/scaling/effects/reshade/launch.json")));
  assert.equal(receipt.preset, null);assert.equal(receipt.graphics.spatialMethod, "metalfx");
  await assert.rejects(ReShade.prepare({ gameId: "unsupported", graphics: { frameGeneration: "lsfg" } }, options), /cannot be presented/);
  assert.equal(fs.existsSync(path.join(options.userDataDir, "games/unsupported")), false);
  const explicit = await ReShade.prepare({ gameId: "explicit", graphics: { spatialMethod: "metalfx" } },
    { ...options, explicitHost: true, execute: () => assert.fail("no shader requested") });
  assert.equal(explicit.RESHADE_EXPLICIT_HOST, "1");
  assert.equal(ReShade.mergeEnvironment({}, explicit).RESHADE_EXPLICIT_HOST, "1");
  assert.ok(fs.statSync(explicit.RESHADE_CONTROL_FILE).isFile());
  assert.equal(fs.readFileSync(explicit.RESHADE_CONTROL_FILE).subarray(0, 8).toString(), "MLFXCTL2");
});
