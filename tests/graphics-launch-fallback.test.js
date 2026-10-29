const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createLauncher} = require("../src/core/launcher"), ReShade = require("../src/modules/shared/reshade");
test("failed graphics preparation preserves original game launch and explicit cancellation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-fallback-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const manifest = {id: "fixture", runtime: {supported: ["native"], default: "native", entries: {native: {graphicsHost: "window"}}}};
  const warnings = [], registry = {listModules: () => [manifest], getModule: () => ({manifest}), getModuleInfo: () => manifest,
    detectGame: input => ({moduleId: "fixture", gamePath: input, name: "Example"})};
  const launcher = createLauncher({userDataDir: root, registry, logger: {warn: (...args) => warnings.push(args)}});
  const entry = await launcher.resolveEntry(root);
  t.mock.method(require("../src/modules/shared/reshade/live-resources"), "supported", () => true);
  t.mock.method(ReShade, "prepare", async (_entry, options) => {options.signal?.throwIfAborted();throw new Error("The selected shader is unavailable.");});
  const context = launcher.getLaunchContext(entry, undefined, {gameEffects: true});
  assert.deepEqual(await context.applyGameEnvironment({KEEP: "yes"}), {KEEP: "yes"});
  assert.deepEqual(await context.getGameEffectsEnvironment(), {});assert.equal(warnings.length, 1);
  const selected = launcher.getLaunchContext({...entry, reshade: {enabled: true, preset: "crt"}}, undefined, {gameEffects: true});
  assert.deepEqual(await selected.applyGameEnvironment({KEEP: "yes"}), {KEEP: "yes"}, "failed selected graphics never blocks ordinary game environment");
  assert.match(selected.graphicsPreparationFailure.reason, /shader is unavailable/);
  assert.equal(warnings.length, 2);assert.match(warnings[1][0], /original rendering/);
  const controller = new AbortController();controller.abort();
  const cancelled = launcher.getLaunchContext(entry, undefined, {gameEffects: true, signal: controller.signal});
  await assert.rejects(cancelled.getGameEffectsEnvironment(), error => error.name === "AbortError");
});

test("graphics fallback and optional process binding do not depend on the warning sink", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-warning-sink-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const info = {id: "fixture", runtime: {default: "runner", supported: ["runner"], entries: {runner: {graphicsHost: "window"}}}};
  const registry = {listModules: () => [info], getModule: () => ({manifest: info}), getModuleInfo: () => info};
  for (const asynchronous of [false, true]) {
    const launcher = createLauncher({userDataDir: root, registry, logger: {warn: () => {
      if (asynchronous) return Promise.reject(Error("Log sink unavailable."));
      throw Error("Log sink unavailable.");
    }}});
    let succeeds = false;
    t.mock.method(ReShade, "prepare", async () => {if (!succeeds) throw Error("Shader unavailable.");return {DYLD_INSERT_LIBRARIES: "/graphics.dylib"};});
    t.mock.method(ReShade, "bindLaunchProcess", () => {throw Error("Live binding unavailable.");});
    const context = launcher.getGameLaunchContext({moduleId: "fixture", gamePath: root, effects: {schema: 2, mode: "advanced", enabled: true,
      video: [{id: "crt", kind: "shader", enabled: true, shader: {preset: "crt"}}]}}, {});
    assert.deepEqual(await context.getGameEffectsEnvironment(), {});
    assert.match(context.graphicsPreparationFailure.reason, /Shader unavailable/);
    succeeds = true;
    assert.deepEqual(await context.getGameEffectsEnvironment({needsRosetta: true}), {DYLD_INSERT_LIBRARIES: "/graphics.dylib"});
    assert.equal(context.graphicsPreparationFailure, undefined, "a successful architecture retry clears the old failure");
    assert.doesNotThrow(() => context.bindGameEffectsProcess({pid: 12345}));
    await new Promise(resolve => setImmediate(resolve));
  }
});

function processFixture(t, launchRuntime, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-launch-process-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const manifest = {id: "fixture", label: "Fixture", runtime: {supported: ["runner"], default: "runner", entries: {runner: {graphicsHost: "window"}}}};
  const mod = {manifest, launchRuntime}, warnings = [];
  const registry = {listModules: () => [manifest], getModule: () => mod, getModuleInfo: () => manifest,
    detectGame: gamePath => ({moduleId: "fixture", gamePath, name: "Example"})};
  const launcher = createLauncher({userDataDir: root, registry, logger: {warn: (...args) => warnings.push(args)}, ...options});
  // These children exercise graphics and lease ownership, not network isolation,
  // which cannot be applied inside an already sandboxed test process.
  const resolveEntry = launcher.resolveEntry;launcher.resolveEntry = async (...args) => ({...await resolveEntry(...args), networkAccess: true});
  return {root, launcher, warnings, mod};
}

test("ordinary child retirement reports the original lease failure once even when the warning sink fails", {timeout: 5000}, async t => {
  const {once} = require("node:events");
  t.mock.method(require("../src/modules/shared/reshade/live-resources"), "supported", () => false);
  for (const asynchronous of [false, true]) {
    let child, releases = 0;const warnings = [], failure = Error("Original lease release failure.");
    const coordinator = {acquireGameUse: async () => "game", acquireUse: async () => "runtime", bindUse: async () => {},
      release: async token => {if (token === "runtime") {releases++;throw failure;}}};
    const f = processFixture(t, async (_runtime, _entry, context) => {
      await context.useRuntime({managerId: "fixture-runtime", version: "1"});
      child = await context.spawnOwnedChecked(process.execPath, ["-e",
        'process.stdin.once("data",()=>process.exit(0));console.log("ready")'], {env: {PATH: process.env.PATH}, stdio: "pipe"});
      await once(child.stdout, "data");return child;
    }, {runtimeCoordinator: coordinator, logger: {warn: (...args) => {
      warnings.push(args);
      if (asynchronous) return Promise.reject(Error("Warning sink unavailable."));
      throw Error("Warning sink unavailable.");
    }}});
    f.mod.runtimeManagers = [{id: "fixture-runtime"}];
    t.after(() => {if (child?.pid && child.exitCode == null && child.signalCode == null) child.kill();});
    const entry = await f.launcher.resolveEntry(f.root);
    const result = await f.launcher.launchEntry(entry, {autoInstallRuntime: false});
    assert.equal(result.child, child);
    const closed = once(child, "close");child.stdin.end("stop");
    assert.deepEqual(await closed, [0, null]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases, 1, "exit and close share the same release owner");
    assert.deepEqual(warnings, [["[runtime] lease release failed", failure.message]]);
  }
});

test("a failed launch keeps its own error when the runtime lease release also fails", {timeout: 5000}, async t => {
  t.mock.method(require("../src/modules/shared/reshade/live-resources"), "supported", () => false);
  let releases = 0;const warnings = [], leaseFailure = Error("Lease release failure."), launchFailure = Error("The runtime could not start.");
  const coordinator = {acquireGameUse: async () => "game", acquireUse: async () => "runtime", bindUse: async () => {},
    release: async token => {if (token === "runtime") {releases++;throw leaseFailure;}}};
  const f = processFixture(t, async (_runtime, _entry, context) => {
    await context.useRuntime({managerId: "fixture-runtime", version: "1"});throw launchFailure;
  }, {runtimeCoordinator: coordinator, logger: {warn: (...args) => warnings.push(args)}});
  f.mod.runtimeManagers = [{id: "fixture-runtime"}];
  const entry = await f.launcher.resolveEntry(f.root);
  await assert.rejects(f.launcher.launchEntry(entry, {autoInstallRuntime: false}), error => error === launchFailure);
  assert.equal(releases, 1);assert.deepEqual(warnings, [["[runtime] lease release failed", leaseFailure.message]]);
});

test("a selected graphics failure still reaches the ordinary owned CPU child with its original environment", {timeout: 5000}, async t => {
  let preparations = 0, child, finalHandoffs = 0;
  t.mock.method(ReShade, "prepare", async () => {preparations++;throw Error("Optional shader preparation rejected");});
  t.mock.method(ReShade, "bindLaunchProcess", () => assert.fail("a failed graphics preparation must not bind a child"));
  const f = processFixture(t, async (_runtime, _entry, context) => {
    const base = {KEEP: "original", PATH: process.env.PATH};
    assert.deepEqual(await context.applyGameEnvironment(base), base);
    child = await context.spawnOwnedChecked(process.execPath, ["-e",
      "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({keep:process.env.KEEP,graphics:Object.keys(process.env).filter(k=>k.startsWith('RESHADE_')||k.startsWith('DYLD_'))}))",
      path.join(f.root, "child.json")], {env: base});
    return child;
  });
  t.after(() => {if (child?.pid && child.exitCode == null && child.signalCode == null) child.kill();});
  const entry = await f.launcher.resolveEntry(f.root);entry.reshade = {enabled: true, preset: "crt"};
  const saved = structuredClone(entry);
  const launched = await f.launcher.launchEntry(entry, {autoInstallRuntime: false,
    processAdapter: (command, args, options, translation, launch) => {
      finalHandoffs++;assert.deepEqual(options.env, {KEEP: "original", PATH: process.env.PATH});
      return launch(command, args, options, translation);
    }});
  assert.equal(launched.kind, "process");assert.equal(launched.child, child);
  assert.equal(launched.graphicsWarnings.length, 1);
  assert.match(launched.graphicsWarnings[0], /original rendering.*Optional shader preparation rejected/);
  const [code, signal] = await new Promise(resolve => child.once("close", (...result) => resolve(result)));
  assert.equal(code, 0);assert.equal(signal, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "child.json"))), {keep: "original", graphics: []});
  assert.equal(preparations, 1, "cached failure cannot retry during the process adapter's final merge");
  assert.equal(finalHandoffs, 1);assert.equal(f.warnings.length, 1);assert.deepEqual(entry, saved);
});

test("Stop during selected graphics preparation cancels before the actual spawn handoff", {timeout: 5000}, async t => {
  const controller = new AbortController();let reachedSpawn = false;
  t.mock.method(ReShade, "prepare", async (_entry, options) => {controller.abort();options.signal.throwIfAborted();});
  const f = processFixture(t, async (_runtime, _entry, context) =>
    context.spawnOwnedChecked(process.execPath, ["-e", "process.exit(98)"], {env: {PATH: process.env.PATH}}));
  const entry = await f.launcher.resolveEntry(f.root);entry.graphics = {frameGeneration: "lsfg"};
  const result = await f.launcher.launchEntry(entry, {autoInstallRuntime: false, signal: controller.signal,
    processAdapter: () => {reachedSpawn = true;assert.fail("Stop cannot become original-rendering fallback");}});
  assert.equal(result.kind, "cancelled");assert.equal(reachedSpawn, false);assert.deepEqual(f.warnings, []);
});

test("whole-preparation warnings survive the backend process reply", {timeout: 5000}, async t => {
  const {createBackendOperations} = require("../src/core/backend-operations");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-backend-warning-")), gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath);t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const info = {id: "fixture", label: "Fixture", gameType: "native", runtime: {default: "runner", supported: ["runner"],
    entries: {runner: {graphicsHost: "window"}}}};
  let child;
  const mod = {manifest: info, launchRuntime: async (_runtime, _entry, context) => {
    child = await context.spawnOwnedChecked(process.execPath, ["-e", "setTimeout(()=>{},150)"], {env: {PATH: process.env.PATH}});
    return child;
  }};
  const registry = {listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod, getModuleInfo: () => info,
    getModuleDir: () => root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async () => ({moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture"})};
  t.after(() => {if (child?.pid && child.exitCode == null && child.signalCode == null) child.kill();});
  t.mock.method(ReShade, "prepare", async () => {throw Error("Shader compiler unavailable.");});
  const operations = createBackendOperations({userDataDir: path.join(root, "data"), registry});
  const entry = await operations.importEntry(gamePath, {});
  entry.reshade = {enabled: true, preset: "crt"};entry.networkAccess = true;
  require("../src/core/game-store").writeGameRecord(path.join(root, "data"), entry);
  const result = await operations.launchEntry(entry, {settings: {}, autoInstallRuntime: false});
  assert.equal(result.kind, "process");assert.equal(result.process.pid, child.pid);
  assert.equal(result.graphicsWarnings.length, 1);assert.match(result.graphicsWarnings[0], /original rendering.*Shader compiler unavailable/);
  const [code] = await new Promise(resolve => child.once("close", (...args) => resolve(args)));
  assert.equal(code, 0);
});
test("upgraded Simple creates correctly sized imported upscaler stages without changing the saved record", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-simple-upscale-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, "example.hook"), StoredPlan = require("../src/modules/shared/effects/stored-plan");
  fs.writeFileSync(file, "//!DESC Example CNN\n//!HOOK MAIN\n//!WIDTH MAIN.w 2 *\n//!HEIGHT MAIN.h 2 *\nvec4 hook(){return vec4(1);}");
  const entry = {reshade: {enabled: true, preset: "custom", effectPath: file}, graphics: {spatialMethod: "metalfx", spatialMultiplier: 2}};
  const sourceOptions = {userDataDir: root, graphicsHost: "window", graphicsInputs: {
    sourceResolution: {control: "engine", heights: true, multipliers: [1, 2]}}};
  const before = structuredClone(entry), plan = StoredPlan.upgradeLegacy(entry, sourceOptions).effects;
  assert.equal(entry.effects, undefined);assert.deepEqual(entry, before);
  assert.deepEqual(plan.renderResolution, {multiplier: 2});assert.equal(plan.video[0].kind, "shader");
  assert.equal(plan.video[1].settings.spatialMultiplier, null);
  const unsupported = StoredPlan.upgradeLegacy(entry, {userDataDir: root}).effects;
  assert.deepEqual(unsupported.renderResolution, {multiplier: 2}, "preserve the requested source budget independently of its implementation");
  assert.equal(require("../src/modules/shared/reshade/source-resolution").resolve(unsupported.renderResolution, {processing: true}).strategy, "processing",
    "the request does not invent a renderer allocation API");
  assert.deepEqual(StoredPlan.upgradeLegacy({...entry, reshade: {...entry.reshade, enabled: false}}).effects.renderResolution, {multiplier: 2},
    "an explicit spatial source request remains independent of shader selection");
});
