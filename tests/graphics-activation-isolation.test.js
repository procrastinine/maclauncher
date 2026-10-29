const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ReShade = require("../src/modules/shared/reshade");
const Requirements = require("../src/modules/shared/effects/execution-requirements"), Effects = require("../src/modules/shared/effects/runtime");

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-activation-")));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.join(directory, "runtime"), userDataDir = path.join(directory, "profile");
  fs.mkdirSync(root);
  for (const file of ["libreshade-macos.dylib", "fx-compile"]) fs.writeFileSync(path.join(root, file), "fixture");
  const host = {spatial: true, temporal: true, frameGeneration: true, resolutionMultipliers: [1, 2]};
  const record = {schema: 1, version: "activation-test", minimumMacOS: "13.0", features: {
    shaders: {formats: ["fx", "libplacebo", "slangp"], liveSwitching: true}, graphics: {
      effectPlanAPI: 1, spatialMethods: ["bilinear", "ls1"], frameGenerationMethods: ["lsfg"], temporalMethods: ["fsr2", "fsr3", "fsr4"],
      virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1, virtualSourceAutoAPI: 1,
      presentationHoldAPI: 1, presentation: {hosts: Object.fromEntries(["window", "remote", "explicit", "catalyst"].map(name => [name, host]))}
    }}};
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(record));
  return {root, userDataDir, options: {root, userDataDir, platform: "darwin", macOSVersion: "27.0",
    graphicsArchitecture: "arm64", diagnostics: false, capture: false, gpuTiming: false, trace: false, verify: () => true}};
}

function forbidDiscovery(t) {
  const calls = [];
  const forbid = (object, method, label) => t.mock.method(object, method, () => {
    calls.push(label || method);throw new Error("Unexpected processing discovery: " + (label || method));
  });
  for (const [module, methods] of [
    ["neural", ["resolve", "prepare", "listModels", "model"]], ["models", ["listInstalled", "resolveModel"]],
    ["filter-library", ["list", "resolve", "identity"]], ["managed-shaders", ["listEffects", "resolveEffect"]],
    ["shader-packs", ["listEffects", "resolveEffect"]], ["shader-providers", ["packaged", "availability", "requireAvailable"]],
    ["shader-traits", ["analyzeFile"]], ["temporal/fsr", ["resolve"]], ["temporal/fsr4", ["resolve"]],
    ["graphics-settings", ["prepare"]], ["diagnostic-retention", ["pruneDiagnostics"]]
  ]) for (const method of methods) forbid(require("../src/modules/shared/reshade/" + module), method, module + "." + method);
  forbid(ReShade, "getState", "full UI catalog");
  forbid(require("../src/modules/shared/effects/runtime"), "prepare", "ordered GPU plan preparation");
  return calls;
}

test("activation is explicit pure demand and never implies a processing component", () => {
  const entry = {reshade: {enabled: false, preset: "custom", effectPath: "/missing/disabled.hook"}, graphics: {
    spatialMethod: "off", temporalMethod: "off", frameGeneration: "off", neuralMethod: "off",
    spatialMultiplier: 3, modelVersion: "sha256-" + "a".repeat(64), neuralModelPath: "/missing/disabled.dlssmodel"}};
  const before = structuredClone(entry), dormant = Requirements.analyze(entry, {activation: true});
  assert.equal(dormant.needed.activation, true);
  for (const [component, needed] of Object.entries(dormant.needed)) if (component !== "activation") assert.equal(needed, false, component);
  assert.deepEqual(dormant.methods, {spatial: [], temporal: [], neural: [], generation: []});
  assert.deepEqual(dormant.shaders, []);assert.equal(dormant.source, null);assert.deepEqual(entry, before);
  assert.equal(Requirements.analyze(entry).needed.activation, false);
  const advanced = Requirements.analyze({effects: {schema: 1, mode: "advanced", video: [
    {id: "disabled-shader", kind: "shader", enabled: false, shader: {preset: "custom", effectPath: "/missing.hook"}},
    {id: "disabled-model", kind: "neural", method: "mlx-dlss", enabled: false, settings: {modelPath: "/missing.dlssmodel"}}
  ]}}, {activation: true});
  assert.equal(advanced.mode, "activation");assert.equal(advanced.needed.processor, false);assert.deepEqual(advanced.shaders, []);
  assert.equal(Requirements.analyze(entry, {activation: true, diagnostics: true}).needed.processor, true,
    "explicit recording is separate processing demand");
});

test("all-off live bootstrap preserves activation without selected provider, shader, model or source work", async t => {
  const f = fixture(t), forbidden = forbidDiscovery(t), sourceRequests = [];
  const Source = require("../src/modules/shared/reshade/source-controls"), original = Source.prepare;
  t.mock.method(Source, "prepare", (entry, options) => {sourceRequests.push(options.source);return original(entry, options);});
  const entry = {gameId: "activation-game", gamePath: "/Games/Example", reshade: {enabled: false, preset: "custom", effectPath: "/missing/disabled.hook"},
    graphics: {spatialMethod: "off", temporalMethod: "off", neuralMethod: "off", frameGeneration: "off", spatialMultiplier: 3,
      modelVersion: "sha256-" + "a".repeat(64), neuralModelPath: "/missing/disabled.dlssmodel"}};
  const disabledRows = [
    {id: "disabled-filter", kind: "shader", enabled: false, shader: {preset: "custom", effectPath: "/missing/disabled.hook"}},
    {id: "disabled-neural", kind: "neural", method: "mlx-dlss", enabled: false, settings: {modelPath: "/missing/disabled.dlssmodel"}}
  ];
  const legacyOn = {...entry, reshade: {...entry.reshade, enabled: true, preset: "filter:11111111-1111-4111-8111-111111111111"},
    graphics: {...entry.graphics, spatialMethod: "ls1", temporalMethod: "fsr4", frameGeneration: "lsfg", neuralMethod: "mlx-dlss"}};
  const selections = [entry, {...entry, reshade: {...entry.reshade, preset: "filter:11111111-1111-4111-8111-111111111111"}},
    {...legacyOn, effects: {schema: 1, mode: "advanced", video: []}},
    {...legacyOn, effects: {schema: 1, mode: "advanced", video: disabledRows}}];
  const before = structuredClone(selections);
  for (const selected of selections) for (const graphicsHost of ["window", "remote", "explicit", "catalyst"]) {
    const environment = await ReShade.prepare(selected, {...f.options, graphicsHost, explicitHost: graphicsHost === "explicit",
      graphicsInputs: {presentationHold: true}, execute: () => assert.fail("Off cannot invoke a compiler")});
    assert.equal(environment.DYLD_INSERT_LIBRARIES, path.join(f.root, "libreshade-macos.dylib"), graphicsHost);
    assert.ok(environment.RESHADE_EFFECT_PLAN, "the inert launch can accept a later live plan");
    const plan = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
    assert.equal(plan.mode, "advanced");assert.deepEqual(plan.nodes, []);assert.equal(plan.revision, Effects.emptyDocument().revision);
    const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
    assert.ok(launch.launchId);assert.equal(launch.effectPlanAPI, 1);
    assert.equal(launch.executionRequirements.needed.processor, false);
    assert.equal(launch.executionRequirements.needed.activation, true);
    for (const name of ["RESHADE_EFFECT", "RESHADE_PREPARED_EFFECT", "RESHADE_LOSSLESS_MODEL", "RESHADE_SPATIAL_METHOD",
      "RESHADE_TEMPORAL_METHOD", "RESHADE_FRAME_GENERATION", "RESHADE_RENDER_AUTO", "RESHADE_RENDER_HEIGHT", "RESHADE_RENDER_MULTIPLIER",
      "RESHADE_CAPTURE_PREFIX", "RESHADE_GPU_TIMING", "RESHADE_DIAGNOSTICS", "FSR4_ROOT"])
      assert.equal(environment[name], undefined, graphicsHost + ": " + name);
    if (launch.sourceControl) assert.equal(JSON.parse(fs.readFileSync(launch.sourceControl.file)).source, null,
      "metadata-only source activation must not change the producer allocation");
    const merged = ReShade.mergeEnvironment({KEEP: "original", DYLD_INSERT_LIBRARIES: "/required-config.dylib", STEAM_DYLD_INSERT_LIBRARIES: "/steam.dylib"}, environment);
    assert.equal(merged.KEEP, "original");assert.ok(merged.DYLD_INSERT_LIBRARIES.split(":").includes("/required-config.dylib"));
    assert.ok(merged.STEAM_DYLD_INSERT_LIBRARIES.split(":").includes("/steam.dylib"));
  }
  assert.ok(sourceRequests.every(value => value === null));
  assert.deepEqual(forbidden, []);assert.deepEqual(selections, before);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "runtimes")), false, "permission metadata must not create model stores");
});

test("unavailable future model grants do not discard an otherwise prepared dormant live launch", async t => {
  const f = fixture(t), forbidden = forbidDiscovery(t), warnings = [];
  t.mock.method(require("../src/modules/shared/reshade/live-resources"), "prepare", () => {throw Error("Future model grant unavailable");});
  const environment = await ReShade.prepare({gameId: "activation-grant", graphics: {spatialMethod: "off"}}, {...f.options,
    graphicsHost: "window", logger: {warn: (...args) => warnings.push(args)}, execute: () => assert.fail("no compiler")});
  assert.equal(environment.DYLD_INSERT_LIBRARIES, path.join(f.root, "libreshade-macos.dylib"));
  assert.ok(environment.RESHADE_EFFECT_PLAN);assert.ok(environment.RESHADE_CONTROL_FILE);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(launch.effectPlanAPI, 1);assert.equal(launch.executionRequirements.mode, "activation");
  assert.equal(launch.graphicsHost, "window");assert.equal(launch.graphicsArchitecture, "arm64");
  assert.equal(launch.graphicsInputs, null);
  assert.equal(launch.effectPlanNeuralLibrary || null, null);
  assert.ok(warnings.some(args => /Future model grant unavailable/.test(args.join(" "))));assert.deepEqual(forbidden, []);
});

test("admitted live effect roots can cross isolation with shaders Off without provisioning direct Off queries", async t => {
  const LiveEffect = require("../src/modules/shared/reshade/live-effect"), Sandbox = require("../src/modules/shared/runtime/macos-sandbox");
  const inert = fixture(t), disabled = {gameId: "inert-query", reshade: {enabled: false, preset: "crt"}};
  await LiveEffect.prepare(disabled, {...inert.options, execute: () => assert.fail("Off cannot compile")});
  assert.equal(fs.existsSync(inert.userDataDir), false, "a disabled shader query creates no folders");
  for (const graphics of [{}, {spatialMethod: "bilinear"}]) {
    const f = fixture(t);
    // Existing immutable provider and model-store grants isolate the live
    // shader namespace contract from optional, future resource bindings.
    fs.mkdirSync(path.join(f.root, "neural"));fs.writeFileSync(path.join(f.root, "neural/libMacLauncherNeural.dylib"), "fixture");
    for (const name of ["lossless-models", "graphics-neural-models"]) fs.mkdirSync(path.join(f.userDataDir, "runtimes", name), {recursive: true});
    const environment = await ReShade.prepare({...disabled, gameId: "isolated-live", graphics}, {...f.options,
      graphicsHost: "window", execute: () => assert.fail("a disabled shader cannot compile")});
    const scoped = await Sandbox.isolateGraphics(environment, path.join(path.dirname(f.root), "sandbox-input"), path.join(path.dirname(f.root), "sandbox-output"));
    assert.ok(scoped.readableDirectories.includes(fs.realpathSync(environment.RESHADE_LIVE_EFFECTS)));
    assert.deepEqual(fs.readdirSync(environment.RESHADE_LIVE_EFFECTS), [], "only an empty live resource namespace is needed");
    assert.equal(scoped.graphics.RESHADE_LIVE_EFFECTS, environment.RESHADE_LIVE_EFFECTS);
  }
});

test("an unavailable admitted live directory falls back before the game isolation handoff", async t => {
  const f = fixture(t), entry = {gameId: "blocked-live", moduleId: "fixture", runtimeId: "native", gamePath: path.dirname(f.root)};
  const effects = path.join(f.userDataDir, "games", entry.gameId, "effects", "reshade", "live-effects");
  fs.mkdirSync(path.dirname(effects), {recursive: true});fs.writeFileSync(effects, "unrelated existing file");
  const manifest = {id: "fixture", runtime: {default: "native", supported: ["native"], entries: {native: {graphicsHost: "window"}}}};
  const registry = {listModules: () => [manifest], getModule: () => ({manifest}), getModuleInfo: () => manifest};
  const prepare = ReShade.prepare;
  t.mock.method(ReShade, "prepare", (selected, options) => prepare(selected, {...options, ...f.options,
    execute: () => assert.fail("Off cannot compile")}));
  const launcher = require("../src/core/launcher").createLauncher({userDataDir: f.userDataDir, registry});
  const context = launcher.getGameLaunchContext(entry, {}, {graphicsRuntimeRoot: f.root});
  const base = {KEEP: "original"};assert.deepEqual(await context.applyGameEnvironment(base), base);
  assert.match(context.graphicsPreparationFailure.reason, /Writable game directories/);
  assert.equal(fs.readFileSync(effects, "utf8"), "unrelated existing file");
});

test("cold live preparation reaches provider isolation without creating prospective model stores", {skip: process.platform !== "darwin"}, async t => {
  const Sandbox = require("../src/modules/shared/runtime/macos-sandbox"), Policy = require("../src/modules/android/policy");
  const f = fixture(t), forbidden = forbidDiscovery(t);
  t.mock.method(console, "warn", () => {});
  const environment = await ReShade.prepare({gameId: "cold-provider", graphics: {spatialMethod: "off"}}, {...f.options,
    graphicsHost: "window", execute: () => assert.fail("Off cannot compile")});
  const storage = await require("../src/modules/android/provider-storage").prepareStorage({gameId: "cold-provider"}, f.userDataDir);
  const descriptor = {command: process.execPath, args: [], env: {KEEP: "original"}};
  const canonical = Sandbox.canonical;
  t.mock.method(Sandbox, "canonical", (file, kind) => {
    assert.notEqual(file, environment.RESHADE_CONTROL_FILE, "graphics validation belongs inside the optional attachment boundary");
    return canonical(file, kind);
  });
  const isolated = await Policy.prepareIsolation(descriptor, storage, {networkAllowed: false}, {graphics: environment});
  assert.equal(isolated.graphics.DYLD_INSERT_LIBRARIES, path.join(f.root, "libreshade-macos.dylib"));
  assert.equal(isolated.graphics.RESHADE_CONTROL_FILE, environment.RESHADE_CONTROL_FILE);
  assert.equal(isolated.graphics.RESHADE_LIVE_EFFECTS, environment.RESHADE_LIVE_EFFECTS);
  assert.equal(isolated.environment.KEEP, "original");
  assert.equal(isolated.graphics.RESHADE_NEURAL_LIBRARY, undefined, "an absent future provider is not required for the core");
  assert.equal(isolated.graphics.RESHADE_NEURAL_ROOT, undefined);
  const roots = JSON.parse(environment.RESHADE_EFFECT_MODEL_ROOTS);
  for (const root of roots) {
    assert.equal(fs.existsSync(root), false, "granting a future store cannot create it");
    assert.ok(isolated.profile.includes('(subpath "' + root + '")'), root);
  }
  assert.deepEqual(forbidden, []);
  assert.deepEqual(await Sandbox.isolateGraphics({}, "/unavailable/input", "/unavailable/output"),
    {graphics: {}, readable: [], readableDirectories: [], executables: [], capabilities: "", fileExtensions: {read: [], readWrite: []}},
    "no attachment grants no graphics filesystem, executable or extension access");
});

test("post-preparation graphics isolation failure preserves the provider launch, while cancellation and runtime isolation stay fatal", {skip: process.platform !== "darwin"}, async t => {
  const Policy = require("../src/modules/android/policy"), Sandbox = require("../src/modules/shared/runtime/macos-sandbox");
  const f = fixture(t), warnings = [];
  t.mock.method(console, "warn", (...args) => {warnings.push(args.join(" "));return Promise.reject(Error("Unavailable warning sink"));});
  const environment = await ReShade.prepare({gameId: "failed-attachment", graphics: {spatialMethod: "bilinear"}}, {...f.options,
    graphicsHost: "window", execute: () => assert.fail("No shader compiler")});
  const storage = await require("../src/modules/android/provider-storage").prepareStorage({gameId: "failed-attachment"}, f.userDataDir);
  const requiredAdapter = path.join(path.dirname(f.root), "required-runtime.dylib");fs.writeFileSync(requiredAdapter, "runtime");
  const descriptor = {command: process.execPath, args: ["--version"], env: {KEEP: "original", DYLD_INSERT_LIBRARIES: requiredAdapter}};
  // The selected control vanishes after successful preparation, outside the
  // central preparation catch. Optional attachment must still permit Play.
  fs.unlinkSync(environment.RESHADE_CONTROL_FILE);
  const isolated = await Policy.prepareIsolation(descriptor, storage, {networkAllowed: false}, {graphics: environment});
  assert.deepEqual(isolated.graphics, {});assert.equal(isolated.environment.KEEP, "original");
  assert.equal(isolated.environment.DYLD_INSERT_LIBRARIES, requiredAdapter);
  assert.ok(isolated.args.includes("DYLD_INSERT_LIBRARIES=" + requiredAdapter));
  assert.equal(isolated.environment.RESHADE_EFFECT_PLAN, undefined);
  assert.ok(!isolated.profile.includes('(literal "' + environment.DYLD_INSERT_LIBRARIES + '")'));
  assert.ok(warnings.some(message => /original rendering/.test(message)));
  await assert.rejects(Policy.prepareIsolation({...descriptor, readDirectories: [path.join(storage.root, "missing-runtime-data")]}, storage,
    {networkAllowed: false}, {graphics: environment}), /ENOENT/);
  const abort = new AbortController();abort.abort();
  await assert.rejects(Sandbox.isolateGraphics(environment, storage.runtimeRoot, storage.cacheRoot, abort.signal), {name: "AbortError"});
  await new Promise(resolve => setImmediate(resolve));
});

test("optional live channels fail independently after a selected shader has been prepared", async t => {
  const channels = [
    ["source-controls", "sourceControlWarning", "sourceControl", "RESHADE_RENDER_SOURCE_CONTROL_FILE"],
    ["presentation-hold", "presentationHoldWarning", "presentationHold", "RESHADE_PRESENTATION_CONTROL_FILE"],
    ["live-resources", "liveResourceWarning", "effectPlanLiveResources", "RESHADE_EFFECT_MODEL_ROOTS"]
  ];
  for (const [module, warning, binding, environmentKey] of channels) await t.test(module, async t => {
    const f = fixture(t), warnings = [], inputs = {architecture: "x86_64", opaque: false, presentationHold: true,
      sourceResolution: {control: "engine", live: true, heights: true, multipliers: [1, 2]}};
    fs.mkdirSync(path.join(f.root, "effects"));fs.writeFileSync(path.join(f.root, "effects/crt.fx"), "selected CRT");
    t.mock.method(require("../src/modules/shared/reshade/" + module), "prepare", () => {throw Error(module + " unavailable");});
    const entry = {gameId: "channel-" + module, effects: {schema: 2, mode: "advanced", enabled: true,
      video: [{id: "crt", kind: "shader", enabled: true, shader: {preset: "crt"}}]}}, before = structuredClone(entry);
    const environment = await ReShade.prepare(entry, {...f.options, graphicsArchitecture: "x86_64", graphicsHost: "window", graphicsInputs: inputs,
      logger: {warn: (...args) => {warnings.push(args);if (module === "source-controls") throw Error("Warning sink unavailable");}}, execute: async (_file, args) => {
        if (args[0] === "--prepare") fs.writeFileSync(args[2], "prepared selected CRT");
        else fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
      }});
    assert.equal(environment.DYLD_INSERT_LIBRARIES, path.join(f.root, "libreshade-macos.dylib"));
    const document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)), directory = path.dirname(environment.RESHADE_EFFECT_PLAN);
    assert.equal(document.mode, "advanced");assert.equal(document.nodes[0].enabled, true);
    assert.equal(fs.readFileSync(document.nodes[0].file, "utf8"), "prepared selected CRT");
    const launch = JSON.parse(fs.readFileSync(path.join(directory, "launch.json")));
    assert.equal(launch[warning], module + " unavailable");assert.equal(launch[binding], undefined);assert.equal(environment[environmentKey], undefined);
    assert.equal(launch.graphicsHost, "window");assert.equal(launch.graphicsArchitecture, "x86_64");assert.deepEqual(launch.graphicsInputs, inputs);
    for (const [, , otherBinding] of channels) if (otherBinding !== binding) assert.ok(launch[otherBinding], otherBinding);
    assert.ok(warnings.some(args => args.includes(module + " unavailable")));assert.deepEqual(entry, before);
  });
});

test("optional live channel cancellation remains a launch cancellation", async t => {
  const f = fixture(t), cancelled = Object.assign(Error("Cancelled"), {name: "AbortError"});
  t.mock.method(require("../src/modules/shared/reshade/source-controls"), "prepare", () => {throw cancelled;});
  await assert.rejects(ReShade.prepare({gameId: "cancel-channel"}, {...f.options, graphicsHost: "window",
    execute: () => assert.fail("no compiler")}), error => error === cancelled);
});

test("a failed final live metadata update retains the prepared processing environment", async t => {
  const f = fixture(t), Writable = require("../src/modules/shared/writable-input"), write = Writable.atomicWrite, warnings = [];
  t.mock.method(Writable, "atomicWrite", (file, bytes, options) => {
    if (path.basename(file) === "launch.json" && JSON.parse(bytes).graphicsHost) throw Object.assign(Error("Live metadata is read-only"), {code: "EACCES"});
    return write(file, bytes, options);
  });
  const environment = await ReShade.prepare({gameId: "metadata-failure", effects: {schema: 2, mode: "advanced", enabled: true,
    video: [{id: "fit", kind: "spatial", enabled: true, method: "bilinear", settings: {}}]}}, {...f.options,
    graphicsHost: "window", logger: {warn: (...args) => warnings.push(args)}, execute: () => assert.fail("no compiler")});
  assert.ok(environment.RESHADE_EFFECT_PLAN);
  assert.deepEqual(JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)).nodes.map(node => [node.method, node.enabled]), [["bilinear", true]]);
  assert.ok(warnings.some(args => args.includes("Live metadata is read-only")));
});

test("a damaged activation library is dropped even when its warning sink throws", async t => {
  const f = fixture(t), Verify = require("../src/modules/shared/reshade/payload-verification"), crypto = require("node:crypto");
  fs.writeFileSync(path.join(f.root, "libvkd3d-shader.dylib"), "dependency");
  const manifest = {files: ["runtime.json", "libreshade-macos.dylib", "libvkd3d-shader.dylib"].map(name => {
    const file = path.join(f.root, name), bytes = fs.readFileSync(file), stat = fs.statSync(file);
    return {path: name, size: bytes.length, mode: stat.mode & 0o777, sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
  })};
  fs.writeFileSync(path.join(f.root, "libreshade-macos.dylib"), "changed");
  const verify = Verify.verifyLaunch, warnings = [];let checks = 0;
  t.mock.method(Verify, "verifyLaunch", (root, entry, options) => {
    checks++;assert.equal(options.activation, true);
    return verify(root, entry, {...options, manifest});
  });
  t.after(() => Verify.clear());
  const environment = await ReShade.prepare({gameId: "damaged-activation"}, {...f.options, verify: undefined,
    graphicsHost: "window", logger: {warn: (...args) => {warnings.push(args);throw Error("Warning sink unavailable");}}, execute: () => assert.fail("no compiler")});
  assert.equal(checks, 1);assert.deepEqual(environment, {});
  assert.equal(fs.existsSync(f.userDataDir), false, "failed activation creates no game state");
  assert.ok(warnings.some(args => /checksum/.test(args.join(" "))));
});

test("cancelled activation verification propagates instead of becoming an optional warning", async t => {
  for (const name of ["AbortError", "Error"]) {
    const f = fixture(t), cancelled = Object.assign(Error("Cancelled"), name === "AbortError" ? {name} : {code: "ABORT_ERR"});
    await assert.rejects(ReShade.prepare({gameId: "cancel-verification"}, {...f.options, graphicsHost: "window",
      verify: () => {throw cancelled;}, logger: {warn: () => assert.fail("cancellation is not a warning")},
      execute: () => assert.fail("no compiler")}), error => error === cancelled);
    assert.equal(fs.existsSync(f.userDataDir), false, "cancelled activation creates no game state");
  }
});

test("tools and hosts without live activation never resolve graphics inputs or preparation", async t => {
  const f = fixture(t), {createLauncher} = require("../src/core/launcher"), Resources = require("../src/modules/shared/reshade/live-resources");
  t.mock.method(ReShade, "prepare", () => assert.fail("no optional bootstrap on this route"));
  t.mock.method(ReShade, "bindLaunchProcess", () => assert.fail("no graphics launch record"));
  t.mock.method(Resources, "supported", () => false);
  const manifest = {id: "fixture", runtime: {supported: ["native"], default: "native", entries: {native: {graphicsHost: "window"}}}};
  const mod = {manifest, resolveGraphicsInputs: () => assert.fail("no renderer discovery")};
  const registry = {listModules: () => [manifest], getModule: () => mod, getModuleInfo: () => manifest};
  const launcher = createLauncher({userDataDir: f.userDataDir, registry});
  const entry = {gameId: "no-bootstrap", moduleId: "fixture", runtimeId: "native", gamePath: "/Games/Example"};
  const settings = {modules: {}, runtimes: {}}, base = {KEEP: "original", DYLD_INSERT_LIBRARIES: "/required-config.dylib"};
  const tools = launcher.getLaunchContext(entry, settings, {graphicsRuntimeRoot: f.root});
  assert.deepEqual(await tools.applyGameEnvironment(base), base);
  const unavailable = launcher.getGameLaunchContext(entry, settings, {graphicsRuntimeRoot: f.root});
  assert.deepEqual(await unavailable.applyGameEnvironment(base), base);unavailable.bindGameEffectsProcess({pid: 123});
  manifest.runtime.entries.native.graphicsHost = null;
  const unsupported = launcher.getGameLaunchContext(entry, settings, {graphicsRuntimeRoot: f.root});
  assert.deepEqual(await unsupported.applyGameEnvironment(base), base);unsupported.bindGameEffectsProcess({pid: 123});
  assert.equal(fs.existsSync(path.join(f.userDataDir, "games")), false);
});
