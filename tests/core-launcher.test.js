const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createLauncher } = require("../src/core/launcher");
const GameStore = require("../src/core/game-store");

// Saved graphics are an ordered effects plan.
const shaderPlan = (preset, enabled = true) => ({ schema: 2, mode: "advanced", enabled: true,
  video: [{ id: "shader", kind: "shader", enabled, shader: { enabled: true, preset } }] });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-core-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath);
  const userDataDir = path.join(root, "userData");
  const manifest = {
    id: "test", label: "Test engine", gameType: "native", settingsDefaults: { defaultRuntime: "runner" },
    runtime: { default: "runner", supported: ["runner", "native"], entries: {
      runner: { settings: { fields: [{ key: "flag", type: "boolean", default: true }] } }
    } }
  };
  const mod = { id: "test", manifest, ...options.mod };
  const registry = {
    listModules: () => [manifest], getModule: id => id === "test" ? mod : null,
    getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Test game", moduleData: { detected: true } })
  };
  const launcher = createLauncher({ userDataDir, registry, ...options.launcher });
  return { launcher, root, gamePath, userDataDir, mod, manifest };
}

test("network access resolves once and persists only the game override through the ordinary action", async t => {
  const { launcher, gamePath, userDataDir, manifest } = fixture(t);
  const entry = { gameId: "network-game", gamePath, moduleId: "test", runtimeId: "runner",
    runtimeSettings: { runner: { flag: false, networkIsolation: false, enableProtections: false } },
    moduleData: { retained: true }, launchArguments: "--literal" };
  GameStore.writeGameRecord(userDataDir, entry);
  const supplied = { flag: false, networkIsolation: true };
  const initial = launcher.getGameLaunchContext(entry, {}, { runtimeSettings: supplied });
  assert.equal(initial.networkAllowed, true, "explicit legacy choice survives normalized runtime settings");
  assert.equal(initial.runtimeSettings.networkIsolation, false);
  assert.equal(supplied.networkIsolation, true, "caller settings remain untouched");
  await launcher.runAction(entry, "setGameNetworkAccess", { networkAccess: false });
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.networkAccess, false);
  assert.deepEqual(stored.runtimeSettings, entry.runtimeSettings);
  assert.deepEqual(stored.moduleData, { retained: true });
  assert.equal(stored.launchArguments, "--literal");
  assert.equal(launcher.getGameLaunchContext(stored, {}).networkAllowed, false);
  const online = launcher.getGameLaunchContext(stored, { launcher: { networkAccess: true } });
  assert.equal(online.networkAllowed, false, "changing global defaults leaves an imported game unchanged");
  assert.equal(online.runtimeSettings.networkIsolation, true);
  await launcher.runAction(entry, "setGameNetworkAccess", { networkAccess: false });
  assert.equal(launcher.getGameLaunchContext(entry, { launcher: { networkAccess: true } }).networkAllowed, false);
  for (const value of [undefined, null, "true", 1, {}, []])
    await assert.rejects(launcher.runAction(entry, "setGameNetworkAccess", { networkAccess: value }), /Network access/);
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId).networkAccess, false);
  manifest.runtime.entries.runner.networkAccess = false;
  await launcher.runAction(entry, "setGameNetworkAccess", { networkAccess: true });
  const fixed = launcher.getGameLaunchContext(entry, { launcher: { networkAccess: true } });
  assert.equal(fixed.networkAllowed, false);
  assert.equal(fixed.runtimeSettings.networkIsolation, true);
  assert.equal(launcher.loadSettings().launcher.networkAccess, false);
});

test("ordinary import snapshots the global network default once and reimport preserves the game's choice", async t => {
  const {launcher, gamePath, root, userDataDir} = fixture(t);
  const settings = {modules: {}, launcher: {networkAccess: true}};
  const first = await launcher.resolveEntry(gamePath, {settings});
  assert.equal(first.networkAccess, true);
  assert.equal(GameStore.readGameRecord(userDataDir, first.gameId).networkAccess, true);
  settings.launcher.networkAccess = false;
  const again = await launcher.resolveEntry(gamePath, {settings});
  assert.equal(again.networkAccess, true, "later defaults do not alter an imported game");
  const secondPath = path.join(root, "second-game");fs.mkdirSync(secondPath);
  const second = await launcher.resolveEntry(secondPath, {settings});
  assert.equal(second.networkAccess, false);
  const legacy = {...second, networkAccess: null};GameStore.writeGameRecord(userDataDir, legacy);
  settings.launcher.networkAccess = true;
  assert.equal((await launcher.resolveEntry(secondPath, {settings})).networkAccess, true, "an old null becomes a concrete choice on normalization");
  settings.launcher.networkAccess = false;
  assert.equal((await launcher.resolveEntry(secondPath, {settings})).networkAccess, true);
});

test("tool process observers receive separate bounded game identity and retain legacy callback arguments", async t => {
  const child = { pid: 123 }, metadata = Object.freeze({ ownerName: "presenter", stopOnLauncherExit: true });
  const calls = [];
  const { launcher, gamePath } = fixture(t, { launcher: { onToolProcessSpawn: (...args) => calls.push(args) } });
  const entry = { gameId: "game-123", moduleId: "test", runtimeId: "runner", gamePath };
  const context = launcher.getGameLaunchContext(entry, {});
  await context.onToolProcessSpawn(child, metadata);
  assert.equal(calls[0][0], child); assert.equal(calls[0][1], metadata);
  assert.deepEqual(calls[0][2], { gameId: "game-123", moduleId: "test", runtimeId: "runner" });
  assert.deepEqual(metadata, { ownerName: "presenter", stopOnLauncherExit: true });
  calls[0][2].gameId = "changed"; assert.equal(entry.gameId, "game-123");
  const invalid = launcher.getGameLaunchContext({ ...entry, gameId: "/private/account-data", runtimeId: "x".repeat(129) }, {});
  await invalid.onToolProcessSpawn(child, metadata); assert.deepEqual(calls[1][2], { moduleId: "test" });
  let legacy;
  const second = fixture(t, { launcher: { onToolProcessSpawn: (originalChild, originalMetadata) => { legacy = [originalChild, originalMetadata]; } } });
  await second.launcher.getGameLaunchContext(entry, {}).onToolProcessSpawn(child, metadata);
  assert.deepEqual(legacy, [child, metadata]);
});

test("ordinary tool role logging contains only validated identity and cannot affect launch", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("function logRuntimeToolSpawn(");
  const callback = source.slice(start, source.indexOf("\nconst launcherService = createLauncher({", start));
  const calls = [], logger = { info: (...args) => calls.push(args) }, Modules = require("../src/modules/registry");
  const absentModule = "runtime-tool-missing-module";
  assert.ok(Modules.getModule("web"));
  assert.ok(Modules.getModuleInfo(absentModule), "unknown module metadata intentionally has a fallback");
  assert.equal(Modules.getModule(absentModule), null);
  const observe = new Function("logger", "Modules", "return (" + callback + ");")(logger, Modules);
  const child = { pid: 321, spawnargs: ["/private/executable", "account-data"] };
  const metadata = Object.freeze({ ownerName: "window-root", command: "/private/executable", environment: { TOKEN: "private" } });
  const identity = { gameId: "game-123", moduleId: "web", runtimeId: "runner", gamePath: "/private/game" };
  assert.doesNotThrow(() => observe(child, metadata, identity));
  assert.equal(calls[0][0], "[runtime-tool] %s");
  assert.deepEqual(JSON.parse(calls[0][1]), { event: "spawn", pid: 321, owner: "window-root", gameId: "game-123", moduleId: "web", runtimeId: "runner" });
  assert.doesNotMatch(JSON.stringify(calls), /private|TOKEN|command|environment|gamePath|spawnargs/);
  for (const pid of [0, -1, 1.5, NaN]) observe({ pid }, metadata, identity);
  for (const ownerName of ["invalid\nrole", "x".repeat(129)]) observe(child, { ownerName }, identity);
  for (const bad of [{ ...identity, gameId: "/private/game" }, { ...identity, moduleId: absentModule }]) observe(child, metadata, bad);
  assert.equal(calls.length, 1);
  logger.info = () => { throw new Error("log unavailable"); };
  assert.doesNotThrow(() => observe(child, metadata, identity));
});

test("per-game effects survive rediscovery, prepare once on Play and stay out of tool contexts", async t => {
  const ReShade = require("../src/modules/shared/reshade");
  let prepared = 0, inputsResolved = 0;
  const graphicsInputs = { cameraProjection: true, source: "test", methods: ["fsr2"] };
  t.mock.method(ReShade, "prepare", async (entry, options) => {
    prepared++; assert.equal(entry.effects.video[0].shader.preset, "vibrance");
    assert.deepEqual(options.graphicsInputs, graphicsInputs);
    return { DYLD_INSERT_LIBRARIES: "/included/effect.dylib", RESHADE_EFFECT: "/included/vibrance.fx" };
  });
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    resolveGraphicsInputs: async () => { inputsResolved++;return graphicsInputs; },
    launchRuntime: async (_runtime, _entry, context) => {
      const base = { ORIGINAL: "1", DYLD_INSERT_LIBRARIES: "/steam.dylib" };
      const first = await context.applyGameEnvironment(base);
      assert.deepEqual(await context.applyGameEnvironment(base), first);
      assert.equal(first.DYLD_INSERT_LIBRARIES, "/steam.dylib:/included/effect.dylib");
      assert.equal(base.RESHADE_EFFECT, undefined);
      return { pid: 1 };
    },
    actions: { inspect: async (_entry, _payload, context) => context.applyGameEnvironment({ TOOL: "1" }) }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  // A v0.4.0 selection is upgraded once when its record is read.
  entry.reshade = { enabled: true, preset: "vibrance", effectPath: null };
  GameStore.writeGameRecord(userDataDir, entry);
  const rediscovered = await launcher.resolveEntry(gamePath);
  assert.equal(Object.hasOwn(rediscovered, "reshade"), false);
  assert.deepEqual(rediscovered.effects.video.map(row => [row.kind, row.enabled, row.shader.preset]), [["shader", true, "vibrance"]]);
  assert.deepEqual(await launcher.runAction(rediscovered, "inspect"), { TOOL: "1" });
  assert.equal(prepared, 0);
  assert.equal(inputsResolved, 0);
  await launcher.launchEntry(rediscovered);
  assert.equal(prepared, 1);
  assert.equal(inputsResolved, 1);
});

test("graphics input inspection works independently of runtime setup status", async t => {
  const inputs = { cameraProjection: true, source: "renderer", methods: ["fsr3"] };
  const { launcher, gamePath } = fixture(t, { mod: {
    resolveGraphicsInputs: (_entry, context) => { assert.equal(context.runtimeId, "runner");return inputs; }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  assert.deepEqual(await launcher.runAction(entry, "graphicsInputs"), { runtimeId: "runner", graphicsInputs: inputs });
});

test("selected graphics preparation errors keep the original game starting and report the unavailable processing", async t => {
  const ReShade = require("../src/modules/shared/reshade");
  t.mock.method(ReShade, "prepare", async () => { throw new Error("The selected shader is missing. Choose an installed shader."); });
  let spawned = false;
  const {launcher, gamePath} = fixture(t, {launcher: {logger: {warn() {}}}, mod: {launchRuntime: async (_runtime, _entry, context) => {
    assert.deepEqual(await context.applyGameEnvironment({ORIGINAL: "1"}), {ORIGINAL: "1"});
    spawned = true; return {pid: 1};
  }}});
  const entry = await launcher.resolveEntry(gamePath);
  entry.effects = shaderPlan("crt");
  const result = await launcher.launchEntry(entry);
  assert.equal(spawned, true);
  assert.equal(result.graphicsWarnings.length, 1);
  assert.match(result.graphicsWarnings[0], /original rendering.*selected shader is missing/);
});
test("unfiltered Play skips graphics input adapters and preparation entirely", async t => {
  const ReShade = require("../src/modules/shared/reshade");
  t.mock.method(ReShade, "prepare", () => assert.fail("no graphics preparation"));
  t.mock.method(ReShade, "bindLaunchProcess", () => assert.fail("no graphics record reads or writes"));
  const {launcher, gamePath} = fixture(t, {mod: {
    resolveGraphicsInputs: () => assert.fail("no renderer discovery"),
    launchRuntime: async (_runtime, _entry, context) => {
      assert.deepEqual(await context.applyGameEnvironment({ORIGINAL: "1"}), {ORIGINAL: "1"});
      return {pid: 1};
    }
  }});
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
});

test("supported all-off game contexts prepare one live presenter while tools and unavailable hosts stay lazy", async t => {
  const ReShade = require("../src/modules/shared/reshade");
  let prepared = 0, inputs = 0;
  const {launcher, root, gamePath, manifest} = fixture(t, {mod: {
    resolveGraphicsInputs: () => {inputs++;return {architecture: "arm64"};},
    launchRuntime: async (_runtime, _entry, context) => {
      const first = await context.applyGameEnvironment({ORIGINAL: "1"});
      assert.deepEqual(await context.applyGameEnvironment({ORIGINAL: "1"}), first);
      assert.equal(first.RESHADE_EFFECT_PLAN, "/owned/live-plan.json");
      return {pid: 1};
    }
  }});
  manifest.runtime.entries.runner.graphicsHost = "explicit";
  const graphicsRuntimeRoot = path.join(root, "graphics");fs.mkdirSync(graphicsRuntimeRoot);
  fs.writeFileSync(path.join(graphicsRuntimeRoot, "runtime.json"), JSON.stringify({features: {graphics: {effectPlanAPI: 1}}}));
  t.mock.method(ReShade, "prepare", async (_entry, request) => {
    prepared++;assert.equal(request.graphicsHost, "explicit");assert.equal(request.root, fs.realpathSync(graphicsRuntimeRoot));
    return {DYLD_INSERT_LIBRARIES: "/owned/presenter.dylib", RESHADE_EFFECT_PLAN: "/owned/live-plan.json"};
  });
  const entry = await launcher.resolveEntry(gamePath);
  const tool = launcher.getLaunchContext(entry, {modules: {}, runtimes: {}}, {graphicsRuntimeRoot});
  assert.deepEqual(await tool.applyGameEnvironment({ORIGINAL: "1"}), {ORIGINAL: "1"});
  await launcher.launchEntry(entry, {graphicsRuntimeRoot, autoInstallRuntime: false});
  assert.equal(prepared, 1);assert.equal(inputs, 1);
  const missing = launcher.getGameLaunchContext(entry, {modules: {}, runtimes: {}}, {graphicsRuntimeRoot: path.join(root, "missing")});
  assert.deepEqual(await missing.applyGameEnvironment({ORIGINAL: "1"}), {ORIGINAL: "1"});
  assert.equal(prepared, 1);assert.equal(inputs, 1);
});

test("unfiltered launches retain their optional diagnostics failure behavior", async t => {
  const values={MACLAUNCHER_RESHADE_DIAGNOSTICS:"1",MACLAUNCHER_RESHADE_CAPTURE:"1"};
  for(const [key,value] of Object.entries(values)){
    const previous=process.env[key];process.env[key]=value;
    t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  }
  t.mock.method(require("../src/modules/shared/reshade"),"prepare",async()=>{throw new Error("Optional capture is unavailable");});
  const warnings=[];
  const {launcher,gamePath}=fixture(t,{launcher:{logger:{warn:message=>warnings.push(message)}},mod:{
    launchRuntime:async(_runtime,_entry,context)=>{
      assert.deepEqual(await context.applyGameEnvironment({ORIGINAL:"1"}),{ORIGINAL:"1"});return {pid:1};
    }
  }});
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  assert.equal(warnings.length,1);assert.match(warnings[0],/Graphics processing could not be prepared.*original rendering/);
});
test("prepared graphics bind the actual returned child once without triggering lazy setup at spawn", async t => {
  const ReShade = require("../src/modules/shared/reshade"), bindings = [], child = {pid: process.pid};
  let prepares = 0;
  t.mock.method(ReShade, "prepare", async () => { prepares++;return {DYLD_INSERT_LIBRARIES: "/included/graphics.dylib"}; });
  t.mock.method(ReShade, "bindLaunchProcess", (entry, pid) => { bindings.push([entry.gameId, pid]);return true; });
  const {launcher, gamePath} = fixture(t, {mod: {launchRuntime: async (_runtime, _entry, context) => {
    await context.onProcessSpawn(child);
    assert.equal(prepares, 0, "an unrelated spawn does not demand graphics setup");
    await context.applyGameEnvironment({});
    await context.onProcessSpawn(child);
    return child;
  }}});
  const entry = await launcher.resolveEntry(gamePath);entry.effects = shaderPlan("crt");
  await launcher.launchEntry(entry);
  assert.equal(prepares, 1);assert.deepEqual(bindings, [[entry.gameId, process.pid]]);
});

test("graphics input queries resolve Play's effective runtime without changing stored choices", async t => {
  const seen = [], inputs = { depth: true, source: "renderer" };
  const { launcher, gamePath, userDataDir, manifest } = fixture(t, { mod: {
    resolveGraphicsInputs: (entry, context) => {
      assert.equal(entry.runtimeId, context.runtimeId);
      seen.push(context.runtimeId);
      entry.moduleData.inspected = true;
      return inputs;
    }
  } });
  manifest.runtime.supported = ["runner", "alternate"];
  manifest.runtime.entries.alternate = {};
  const entry = await launcher.resolveEntry(gamePath);
  const settings = { modules: { test: { defaultRuntime: "alternate" } } };
  for (const [requested, expected] of [[undefined, "alternate"], ["retired", "alternate"], [" RUNNER ", "runner"]]) {
    if (requested === undefined) delete entry.runtimeId;else entry.runtimeId = requested;
    GameStore.writeGameRecord(userDataDir, entry);
    const before = structuredClone(entry), stored = GameStore.readGameRecord(userDataDir, entry.gameId);
    assert.deepEqual(await launcher.runAction(entry, "graphicsInputs", {}, { settings }), { runtimeId: expected, graphicsInputs: inputs });
    assert.deepEqual(entry, before);
    assert.deepEqual(GameStore.readGameRecord(userDataDir, entry.gameId), stored);
  }
  assert.deepEqual(seen, ["alternate", "alternate", "runner"]);
});

test("game notes use the shared backend and survive rediscovery and runtime updates", async t => {
  const { launcher, gamePath, userDataDir } = fixture(t);
  const entry = await launcher.resolveEntry(gamePath);
  const result = await launcher.runAction(entry, "setGameNotes", { notes: "Chapter 3\nUse the west exit." });
  assert.equal(result.notes, entry.notes);
  const discovered = await launcher.resolveEntry(gamePath);
  assert.equal(discovered.notes, result.notes);
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.notes, result.notes);
  assert.equal(stored.moduleData.detected, true);
});

test("backend dispatch passes settings and preserves staged state without Electron", async t => {
  let context;
  const child = { pid: 1 };
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    launchRuntime: async (_runtimeId, entry, value) => {
      context = value;
      value.onEntryChange({ contentRootDir: "/staged", moduleData: { ...entry.moduleData, staged: true }, gameId: "hijack" });
      return child;
    }
  } });
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ modules: { test: { runtimeSettings: { runner: { flag: false } } } } }));
  const entry = await launcher.resolveEntry(gamePath);
  const result = await launcher.launchEntry(entry);
  assert.equal(result.child, child);
  assert.equal(result.runtimeId, "runner");
  assert.deepEqual(context.runtimeSettings, { flag: false, networkIsolation: true });
  assert.equal(Object.hasOwn(context, "runtimeSettingsOverrides"), false, "Inherited defaults remain distinguishable from caller overrides");
  const explicit = launcher.getLaunchContext(entry, undefined, { runtimeSettings: { flag: true } });
  assert.deepEqual(explicit.runtimeSettingsOverrides, { flag: true });
  assert.deepEqual(explicit.runtimeSettings, { flag: true, networkIsolation: true });
  assert.equal(context.ui, undefined);
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.contentRootDir, "/staged");
  assert.equal(stored.gameId, entry.gameId);
  assert.equal(stored.moduleData.staged, true);
});

test("already signalled children release the save-editing guard", async t => {
  const { EventEmitter } = require("node:events");
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: "SIGTERM" });
  const { launcher, gamePath } = fixture(t, { mod: { launchRuntime: async () => child } });
  const entry = await launcher.resolveEntry(gamePath);
  await launcher.launchEntry(entry);
  assert.doesNotThrow(() => launcher.getLaunchContext(entry).assertSaveWriteAllowed());
});

test("module tools launch through the independent backend with transient options and tracked ownership", async t => {
  const { EventEmitter } = require("node:events");
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  let launchContext, notifications = 0;
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    launchRuntime: async (_runtime, _entry, context) => { launchContext = context; return child; },
    actions: { openTool: (entry, _payload, context) => context.launchForTools({ runtimeId: "runner", moduleOptions: { mode: "debugger" } }) }
  }, launcher: { onToolLaunch: (entry, result) => { assert.equal(entry.gamePath, gamePath); assert.equal(result.child, child); notifications++; } } });
  const entry = await launcher.resolveEntry(gamePath);
  const result = await launcher.runAction(entry, "openTool");
  assert.equal(result.child, child);
  assert.deepEqual(launchContext.moduleLaunchOptions, { mode: "debugger" });
  assert.equal(launcher.getLaunchContext(entry).isGameRunning(), true);
  await assert.rejects(launcher.runAction(entry, "openTool"), /Quit the game/);
  assert.equal(notifications, 1);
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId).moduleOptions, undefined);
  child.exitCode = 0; child.emit("exit", 0);
  await new Promise(resolve => setImmediate(resolve)); // ownership retires after process-stop settlement
  assert.equal(launcher.getLaunchContext(entry).isGameRunning(), false);
});

test("read-only resolution neither invokes import hooks nor writes files", async t => {
  let imports = 0;
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    onImport: async () => { imports++; }
  } });
  const detected = await launcher.resolveEntry(gamePath, { persist: false });
  assert.equal(detected.runtimeId, "runner");
  assert.equal(imports, 0);
  assert.equal(fs.existsSync(userDataDir), false);
  await launcher.resolveEntry(gamePath);
  assert.equal(imports, 1);
  await launcher.resolveEntry(gamePath);
  assert.equal(imports, 1);
});

test("an original native app keeps its detected runtime while explicit game and module choices win", async t => {
  const { launcher, root, userDataDir, manifest } = fixture(t);
  const appPath = path.join(root, "Original.app"); fs.mkdirSync(appPath);
  const detected = { moduleId: "test", gamePath: appPath, nativeAppPath: appPath, name: "Original", runtimeId: "native" };
  const detectionReport = { input: { requestedPath: appPath }, detected };
  assert.equal((await launcher.resolveEntry(appPath, { detectionReport, persist: false })).runtimeId, "native");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ modules: { test: { defaultRuntime: "runner" } } }));
  assert.equal((await launcher.resolveEntry(appPath, { detectionReport, persist: false })).runtimeId, "native");
  assert.equal((await launcher.resolveEntry(appPath, { detectionReport, runtimeId: "runner" })).runtimeId, "runner");
  assert.equal((await launcher.resolveEntry(appPath, { detectionReport })).runtimeId, "runner");
  const otherApp = path.join(root, "Other.app"); fs.mkdirSync(otherApp);
  manifest.settingsDefaults.defaultRuntime = "native";
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ modules: { test: { defaultRuntime: "runner" } } }));
  assert.equal((await launcher.resolveEntry(otherApp, { detectionReport: { input: { requestedPath: otherApp }, detected: { ...detected, gamePath: otherApp, nativeAppPath: otherApp } } })).runtimeId, "runner");
});

test("an eligible runtime provider supplies playback when the engine default cannot launch", async t => {
  const { launcher, gamePath, userDataDir, manifest } = fixture(t, { mod: {
    filterRuntimeSupport: () => ["portable"], canLaunchRuntime: id => id === "portable"
  } });
  manifest.runtime.supported.push("portable");
  manifest.runtime.entries.portable = { runtimeProvider: true };
  assert.equal((await launcher.resolveEntry(gamePath, { persist: false })).runtimeId, "portable");
  assert.equal((await launcher.resolveEntry(gamePath, { persist: false, runtimeId: "portable" })).runtimeId, "portable");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ modules: { test: { defaultRuntime: "portable" } } }));
  assert.equal((await launcher.resolveEntry(gamePath, { persist: false })).runtimeId, "portable");
  fs.writeFileSync(path.join(userDataDir, "settings.json"), "{}");
  manifest.runtime.default = "portable"; manifest.settingsDefaults.defaultRuntime = "portable";
  assert.equal((await launcher.resolveEntry(gamePath, { persist: false })).runtimeId, "portable");
});

test("a module can select an eligible provider as its automatic default", async t => {
  const { launcher, gamePath, userDataDir, manifest } = fixture(t, { mod: {
    resolveDefaultRuntime: () => "portable"
  } });
  manifest.settingsDefaults = {};
  manifest.runtime.supported.push("portable");
  manifest.runtime.entries.portable = { runtimeProvider: true };
  assert.equal((await launcher.resolveEntry(gamePath, { persist: false })).runtimeId, "portable");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ modules: { test: { defaultRuntime: "runner" } } }));
  assert.equal((await launcher.resolveEntry(gamePath, { persist: false })).runtimeId, "runner");
});

test("Play prepares a compatible runtime once without changing global defaults or concurrent notes", async t => {
  let installs = 0, launches = 0, release;
  const installation = new Promise(resolve => { release = resolve; });
  const events = [], child = { pid: 123 };
  const manager = { id: "test-runtime", label: "Test runtime",
    installRuntime: async payload => { installs++; assert.equal(payload.version, "2.0"); assert.equal(payload.variant, "arm64"); await installation; return { version: "2.0" }; },
    updateSettingsAfterInstall: () => { throw new Error("Automatic installation must preserve global preferences"); }
  };
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: { onPreparationChange: event => events.push(event.phase), confirmRuntimeInstall: async () => true }, mod: {
    runtimeManagers: [manager],
    ensureRuntime: async (entry, context) => {
      assert.equal(context.runtimeId, "runner"); assert.equal(context.autoInstallRuntime, true);
      assert.equal(context.ui, undefined);
      entry.runtimeData = { runner: { version: "2.0" } };
      return { managerId: manager.id, version: "2.0", installOptions: { variant: "arm64" } };
    },
    prepareLaunch: async entry => { entry.moduleData.prepared = true; },
    launchRuntime: async (_id, entry) => { assert.equal(entry.moduleData.prepared, true); launches++; return child; }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  const first = launcher.launchEntry(entry), second = launcher.launchEntry(entry);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, 1);
  GameStore.setGameNotes(userDataDir, entry.gameId, "Notes edited while installing");
  release();
  assert.equal((await first).child, child); assert.equal((await second).child, child);
  assert.equal(launches, 1);
  const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(stored.notes, "Notes edited while installing");
  assert.equal(stored.runtimeData.runner.version, "2.0");
  assert.deepEqual(events, ["check", "install", "prepare", "launch", "done"]);
  assert.equal(fs.existsSync(path.join(userDataDir, "settings.json")), false);
});

test("module compatibility preflight rejects before a download and offline launch can skip preparation", async t => {
  let downloads = 0, launches = 0;
  const { launcher, gamePath } = fixture(t, { mod: {
    runtimeManagers: [{ id: "test-runtime", installRuntime: () => { downloads++; } }],
    ensureRuntime: () => { throw new Error("Unsupported game format"); },
    launchRuntime: () => { launches++; return { pid: 123 }; }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  await assert.rejects(launcher.launchEntry(entry), /Unsupported game format/);
  assert.equal(downloads, 0); assert.equal(launches, 0);
  await launcher.launchEntry(entry, { autoInstallRuntime: false });
  assert.equal(launches, 1); assert.equal(downloads, 0);
});

test("declining a missing runtime cancels before installation, preparation, or launch", async t => {
  const events = [];
  const manager = { id: "test-runtime", label: "Test runtime", installRuntime: () => assert.fail("cancelled download") };
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: {
    confirmRuntimeInstall: (plan, entry) => {
      assert.equal(plan.managerId, manager.id); assert.equal(plan.version, "2.0"); assert.equal(entry.gamePath, gamePath);
      events.push("prompt"); return false;
    }, onPreparationChange: event => events.push(event.phase)
  }, mod: { runtimeManagers: [manager],
    ensureRuntime: entry => { entry.runtimeData = { runner: { version: "2.0" } }; return { managerId: manager.id, version: "2.0" }; },
    prepareLaunch: () => assert.fail("cancelled preparation"), launchRuntime: () => assert.fail("cancelled launch")
  } });
  const entry = await launcher.resolveEntry(gamePath);
  assert.equal((await launcher.launchEntry(entry)).kind, "cancelled");
  assert.deepEqual(events, ["check", "prompt", "done"]);
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId).runtimeData?.runner?.version, undefined);
});

test("required download consent precedes installation and all preparation", async t => {
  const calls = [];
  const manager = { id: "test-runtime", installRuntime: () => { calls.push("install"); return { version: "2.0" }; } };
  const { launcher, gamePath } = fixture(t, { launcher: {
    confirmRuntimeInstall: () => { calls.push("confirm"); return true; }
  }, mod: { runtimeManagers: [manager], ensureRuntime: () => ({ managerId: manager.id, version: "2.0" }),
    prepareLaunch: () => calls.push("prepare"), launchRuntime: () => { calls.push("launch"); return { pid: 1 }; }
  } });
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  assert.deepEqual(calls, ["confirm", "install", "prepare", "launch"]);
});

test("bundled runtimes install offline without a download prompt", async t => {
  let installed = false; const events = [];
  const manager = { id: "test-runtime", label: "Test runtime", getState: () => ({ catalog: { versionRequirements: { "2.0": { requiresDownload: false } } } }),
    installRuntime: async ({ onProgress }) => {
      onProgress({ phase: "copy", percent: 37.25 });
      // Allow one throttled progress update before the final installation stage.
      await new Promise(resolve => setTimeout(resolve, 260));
      onProgress({ phase: "copy", percent: 37.4 });
      onProgress({ phase: "copy", percent: NaN });
      onProgress({ phase: "ready", percent: 100 });
      installed = true; return { version: "2.0", source: "bundled" };
    } };
  const { launcher, gamePath } = fixture(t, { launcher: {
      confirmRuntimeInstall: () => assert.fail("offline bundle has no download"),
      onPreparationChange: event => events.push(event)
    },
    mod: { runtimeManagers: [manager], ensureRuntime: () => ({ managerId: manager.id, version: "2.0" }),
      launchRuntime: () => { assert.equal(installed, true); return { pid: 1 }; } }
  });
  await launcher.launchEntry(await launcher.resolveEntry(gamePath));
  const progress = events.filter(event => event.phase === "install");
  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map(event => event.percent), [undefined, 37, 100]);
  for (const event of progress) {
    assert.equal(event.managerId, manager.id);
    assert.equal(event.version, "2.0");
    assert.equal(event.gamePath, gamePath);
    assert.equal(event.label, "Installing Test runtime…");
  }
  assert.equal(events.at(-1).phase, "done");
});

test("manual tool progress cannot leave the game stuck preparing after success or failure", async t => {
  const preparation = [];
  const { launcher, gamePath } = fixture(t, { launcher: { onPreparationChange: event => preparation.push(event) }, mod: {
    actions: {
      buildTool: (_entry, _payload, context) => { context.onProgress({ phase: "copy", percent: 100 }); return { ready: true }; },
      failedTool: (_entry, _payload, context) => { context.onProgress({ phase: "build", percent: 20 }); throw new Error("tool build failed"); }
    }
  } });
  const entry = await launcher.resolveEntry(gamePath);
  assert.deepEqual(await launcher.runAction(entry, "buildTool"), { ready: true });
  await assert.rejects(launcher.runAction(entry, "failedTool"), /tool build failed/);
  assert.deepEqual(preparation, []);
  const progress = [];
  launcher.getLaunchContext(entry, undefined, { onProgress: value => progress.push(value) }).onProgress({ percent: 25 });
  assert.deepEqual(progress, [{ percent: 25 }]);
  assert.deepEqual(preparation, []);
});

test("aborted library preparation cancels the launch without starting an incomplete game", async t => {
  const { launcher, gamePath } = fixture(t, { mod: {
    prepareLaunch: () => { throw Object.assign(new Error("Cancelled"), { name: "AbortError" }); },
    launchRuntime: () => assert.fail("required library is absent")
  } });
  assert.equal((await launcher.launchEntry(await launcher.resolveEntry(gamePath))).kind, "cancelled");
});

test("native process prerequisites receive this game's consent callback before spawning", async t => {
  const { EventEmitter } = require("node:events");
  const events = [], child = new EventEmitter();
  child.unref = () => {};
  let available = false;
  const rosetta = {
    requiresForExecutable: () => true, isAvailable: () => available,
    ensure: async context => {
      assert.equal(context.userDataDir, userDataDir);
      const consent = await context.confirmRuntimeInstall({ label: "Rosetta", licenseRequired: true });
      assert.deepEqual(consent, { approved: true, licenseAccepted: true });
      available = true; events.push("install");
    }
  };
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: {
    rosetta, confirmRuntimeInstall: (plan, entry) => {
      assert.equal(entry.gamePath, gamePath); assert.equal(plan.label, "Rosetta");
      events.push("confirm"); return { approved: true, licenseAccepted: true };
    }, spawn: () => { events.push("spawn"); process.nextTick(() => child.emit("spawn")); return child; }
  }, mod: { launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/intel/runner", []) } });
  // Direct spawn expectations need access; isolated launches wrap the process in the native policy.
  const result = await launcher.launchEntry({ ...await launcher.resolveEntry(gamePath), networkAccess: true });
  assert.equal(result.child, child);
  assert.deepEqual(events, ["confirm", "install", "spawn"]);
});

test("native module preparation retains Steam identity, bundle executable and working directory", { skip: process.platform !== "darwin" }, async t => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter(); child.unref = () => {};
  let appPath, executable, launches = 0;
  const { launcher, root } = fixture(t, { mod: {
    prepareNativeLaunch: async (_entry, _context, selected) => {
      assert.deepEqual(selected, { appPath, executable });
      return { args: ["--main-pack", "/private/game.pck"], environment: { CAMERA_BRIDGE: "1" } };
    }
  }, launcher: {
    rosetta: { requiresForExecutable: () => false },
    steamClientService: async selected => {
      assert.equal(selected, appPath);
      return { environment: { SteamAppId: "480", SteamGameId: "480", DYLD_INSERT_LIBRARIES: "/effects.dylib", RESHADE_CONFIG: "/game/ReShade.ini" } };
    },
    spawn: (cmd, args, options) => {
      assert.equal(cmd, executable); assert.deepEqual(args, ["--main-pack", "/private/game.pck"]);
      assert.equal(options.env.CAMERA_BRIDGE, "1");
      assert.equal(options.env.SteamAppId, "480"); assert.equal(options.env.SteamGameId, "480");
      assert.equal(options.env.DYLD_INSERT_LIBRARIES, "/effects.dylib"); assert.equal(options.env.RESHADE_CONFIG, "/game/ReShade.ini");
      assert.equal(options.cwd, path.dirname(executable));
      launches++; process.nextTick(() => child.emit("spawn")); return child;
    }
  } });
  appPath = path.join(root, "Publisher.app"); executable = path.join(appPath, "Contents", "MacOS", "Publisher");
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const entry = { ...await launcher.resolveEntry(appPath, { runtimeId: "native" }), networkAccess: true };
  assert.equal((await launcher.launchEntry(entry)).child, child); assert.equal(launches, 1);
  child.exitCode = 0; child.emit("exit", 0);
});

test("native app shell executables transport enabled effects and leave disabled launches unchanged", { skip: process.platform !== "darwin" }, async t => {
  const { EventEmitter } = require("node:events");
  const ReShade = require("../src/modules/shared/reshade");
  t.mock.method(ReShade, "prepare", async entry => entry.effects?.video.some(row => row.enabled) ? { DYLD_INSERT_LIBRARIES: "/owned/effect.dylib", RESHADE_CONFIG: "/owned/game.ini" } : {});
  const launches = [];
  const { launcher, root } = fixture(t, { launcher: {
    rosetta: { requiresForExecutable: () => false },
    steamClientService: async () => ({ environment: { SteamAppId: "105600", RENPY_PLATFORM: "unchanged" } }),
    spawn: (cmd, args, options) => {
      const child = new EventEmitter(); child.unref = () => {}; launches.push({ cmd, args, options });
      process.nextTick(() => child.emit("spawn")); return child;
    }
  } });
  const app = path.join(root, "Publisher.app"), executable = path.join(app, "Contents/MacOS/Publisher");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const source = '#!/bin/bash\ncd "`dirname "$0"`"\n./game.bin.osx "$@"\n';
  fs.writeFileSync(executable, source, { mode: 0o755 });
  for (const enabled of [false, true]) {
    const entry = await launcher.resolveEntry(app, { runtimeId: "native" });
    entry.networkAccess = true;
    entry.effects = shaderPlan("grayscale", enabled);
    const result = await launcher.launchEntry(entry);
    const actual = launches.at(-1);
    assert.equal(actual.cmd, enabled ? "/bin/bash" : executable);
    assert.equal(actual.options.cwd, path.dirname(executable));
    assert.equal(actual.options.env.SteamAppId, "105600");
    if (enabled) {
      assert.equal(actual.args[0], "-c");
      assert.equal(actual.args[2], executable);
      assert.equal(actual.args[3], "/owned/effect.dylib");
      assert.match(actual.args[1], /export DYLD_INSERT_LIBRARIES="\$1"; shift; \. "\$0"/);
    } else assert.deepEqual(actual.args, []);
    result.child.exitCode = 0; result.child.emit("exit", 0);
  }
  assert.equal(fs.readFileSync(executable, "utf8"), source);
});

test("module native API requirements are prepared automatically before process spawn", async t => {
  const { EventEmitter } = require("node:events");
  const events = [], child = new EventEmitter(); child.unref = () => {};
  const { launcher, gamePath, userDataDir } = fixture(t, { launcher: {
    rosetta: { requiresForExecutable: () => false },
    steamApiService: async (request, context) => {
      events.push("api");
      assert.equal(request.appId, 480);
      assert.ok(request.ownedDirectory.startsWith(path.join(userDataDir, "games") + path.sep));
      assert.equal(context.baseEnvironment.DYLD_INSERT_LIBRARIES, "/graphics.dylib");
      return { environment: { ...context.baseEnvironment, SteamAppId: "480" }, libraryPath: "/shared/libsteam_api.dylib" };
    },
    spawn: (cmd, args, options) => {
      events.push("spawn"); assert.equal(cmd, "/native/runner");
      assert.equal(options.env.SteamAppId, "480"); assert.equal(options.env.DYLD_INSERT_LIBRARIES, "/graphics.dylib");
      assert.deepEqual(args, ["game", "--mapped"]);
      process.nextTick(() => child.emit("spawn")); return child;
    }
  }, mod: {
    getSteamApiRequirement: (_entry, _context, plan) => {
      events.push("inspect"); assert.equal(plan.cmd, "/native/runner");
      return { required: true, appId: 480, arch: "arm64", symbols: ["SteamAPI_Init"] };
    },
    applySteamApi: (_entry, prepared, _context, plan) => {
      events.push("map"); assert.equal(prepared.libraryPath, "/shared/libsteam_api.dylib");
      return { ...plan, args: [...plan.args, "--mapped"] };
    },
    launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/native/runner", ["game"], {
      env: { DYLD_INSERT_LIBRARIES: "/graphics.dylib" }
    })
  } });
  await launcher.launchEntry({ ...await launcher.resolveEntry(gamePath), networkAccess: true });
  assert.deepEqual(events, ["inspect", "api", "map", "spawn"]);
});

test("non-Steam consumers and auxiliary tool processes skip API preparation", async t => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter(); child.unref = () => {};
  const { launcher, gamePath } = fixture(t, { launcher: {
    rosetta: { requiresForExecutable: () => false },
    steamApiService: () => assert.fail("no actual Steam consumer"),
    spawn: (_cmd, _args, options) => {
      assert.equal(options.env.SteamAppId, undefined);
      process.nextTick(() => child.emit("spawn")); return child;
    }
  }, mod: {
    getSteamApiRequirement: (_entry, _context, plan) => plan.cmd === "/tools/decompiler" ? null : { required: false },
    launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/tools/decompiler", [], { env: {} })
  } });
  await launcher.launchEntry({ ...await launcher.resolveEntry(gamePath), networkAccess: true });
});

test("declining a native prerequisite cancels before spawning", async t => {
  const rosetta = { requiresForExecutable: () => true, isAvailable: () => false,
    ensure: async context => {
      assert.equal(await context.confirmRuntimeInstall({ label: "Rosetta" }), false);
      throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    }
  };
  const { launcher, gamePath } = fixture(t, { launcher: {
    rosetta, confirmRuntimeInstall: () => false, spawn: () => assert.fail("declined prerequisite")
  }, mod: { launchRuntime: (_id, _entry, context) => context.spawnDetachedChecked("/intel/runner", []) } });
  assert.equal((await launcher.launchEntry(await launcher.resolveEntry(gamePath))).kind, "cancelled");
});

test("explicit unsupported or unlaunchable runtime fails without switching engines", async t => {
  let launches = 0;
  const { launcher, gamePath, userDataDir, mod } = fixture(t, { mod: {
    launchRuntime: () => { launches++; }
  } });
  await assert.rejects(launcher.resolveEntry(gamePath, { runtimeId: "wine" }), /not supported/);
  assert.equal(fs.existsSync(userDataDir), false);
  mod.canLaunchRuntime = runtimeId => runtimeId !== "runner";
  await assert.rejects(launcher.resolveEntry(gamePath, { runtimeId: "runner" }), /cannot launch/);
  assert.equal(launches, 0);
});

test("same backend dispatches a hosted game through its supplied adapter", async t => {
  let calls = 0;
  const win = {};
  const { launcher, gamePath, manifest } = fixture(t, { launcher: {
    launchHosted: async (entry, runtimeId, context) => {
      calls++;
      assert.equal(runtimeId, "host");
      assert.equal(context.runtimeId, "host");
      assert.ok(entry.indexHtml);
      return { win };
    }
  } });
  manifest.gameType = "web";
  manifest.runtime = { supported: ["host"], default: "host", hosted: { id: "host" } };
  manifest.settingsDefaults.defaultRuntime = "host";
  const entry = await launcher.resolveEntry(gamePath);
  entry.indexHtml = path.join(gamePath, "index.html");
  assert.equal((await launcher.launchEntry(entry)).win, win);
  assert.equal(calls, 1);
  entry.indexHtml = null;
  await assert.rejects(launcher.launchEntry(entry), /Missing index.html/);
  assert.equal(calls, 1);
});

test("running games protect a shared save folder across different library records", async t => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const { launcher, gamePath, root } = fixture(t, { mod: { launchRuntime: () => child } });
  const entry = await launcher.resolveEntry(gamePath);
  entry.defaultSaveDir = path.join(root, "shared-saves");
  fs.mkdirSync(entry.defaultSaveDir);
  await launcher.launchEntry(entry);
  const other = { ...entry, gameId: "different-game", gamePath: path.join(root, "other-game") };
  assert.throws(() => launcher.saveService.assertWriteAllowed(other), /Stop the game/);
  child.emit("exit", 0);
  child.emit("close", 0);
  await new Promise(resolve => setImmediate(resolve)); // ownership retires after process-stop settlement
  assert.doesNotThrow(() => launcher.saveService.assertWriteAllowed(other));
});

test("existing saved entry identity, per-game overrides, and module merge hook survive detection", async t => {
  const { launcher, gamePath, userDataDir } = fixture(t, { mod: {
    mergeEntry: (existing, merged) => ({ ...merged, defaultSaveDir: existing?.defaultSaveDir || "/new" })
  } });
  GameStore.writeGameRecord(userDataDir, {
    gameId: "stable-id", moduleId: "test", gamePath, importPath: gamePath,
    defaultSaveDir: "/saves", saveDirOverride: "/custom-saves", runtimeId: "runner",
    runtimeSettings: { runner: { flag: false } }, moduleData: { kept: true }
  });
  const entry = await launcher.resolveEntry(gamePath);
  assert.equal(entry.gameId, "stable-id");
  assert.equal(entry.defaultSaveDir, "/saves");
  assert.equal(entry.saveDirOverride, "/custom-saves");
  assert.equal(entry.moduleData.kept, true);
  assert.deepEqual(launcher.getLaunchContext(entry).runtimeSettings, { flag: false, networkIsolation: true });
});

function runCli(root, ...args) {
  const overrides = args[0] && typeof args[0] === "object" ? args.shift() : {};
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const guard = path.join(root, "no-electron.cjs");
  fs.writeFileSync(guard, `const Module=require('node:module'); const load=Module._load; Module._load=function(name,...args){ if(name==='electron') throw Error('Unexpected Electron import'); return load.call(this,name,...args); };`);
  return spawnSync(process.execPath, ["--require", guard,
    path.join(__dirname, "..", "scripts/run-game.mjs"), ...args], { env, encoding: "utf8", timeout: 20000 });
}

test("CLI inspects a web game offline without Electron or creating launcher state", t => {
  const { root, gamePath, userDataDir } = fixture(t);
  fs.writeFileSync(path.join(gamePath, "index.html"), "<title>Web test</title>");
  const result = runCli(root, "--game", gamePath, "--user-data", userDataDir, "--inspect");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).entry.moduleId, "web");
  assert.equal(fs.existsSync(userDataDir), false);
});

test("CLI explicitly selects the standalone hosted entry and waits for its acknowledged child", t => {
  const { root, gamePath, userDataDir } = fixture(t);
  fs.writeFileSync(path.join(gamePath, "index.html"), "<title>Hosted test</title>");
  const host = path.join(root, "host.cjs");
  const reporterPath = require.resolve("../src/core/hosted-startup-reporter");
  fs.writeFileSync(host, `#!/usr/bin/env node
if (!process.argv.includes("--maclauncher-runtime-host")) {
  console.error("Missing standalone runtime entry flag"); process.exit(2);
}
const { createHostedStartupReporter } = require(${JSON.stringify(reporterPath)});
createHostedStartupReporter().ready({ windowId: 1, url: "http://127.0.0.1:1234/index.html" });
setTimeout(() => process.exit(7), 100);
`, { mode: 0o755 });
  const result = runCli(root, { MACLAUNCHER_ELECTRON_PATH: host }, "--game", gamePath,
    "--runtime", "electron", "--user-data", userDataDir, "--wait", "--offline");
  assert.equal(result.status, 7, result.stderr);
  const games = GameStore.loadGames(userDataDir);
  assert.equal(games[0].runtimeId, "electron");
  assert.ok(games[0].lastPlayedAt > 0);
});

test("CLI runs a native app directly and returns its exit status without loading Electron", t => {
  if (process.platform !== "darwin") return t.skip("macOS app fixture");
  const { root, userDataDir } = fixture(t);
  const appPath = path.join(root, "Native Test.app");
  const macos = path.join(appPath, "Contents/MacOS");
  const resources = path.join(appPath, "Contents/Resources/app.nw");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "index.html"), "<title>Native fixture</title>");
  const marker = path.join(root, "ran.txt");
  const escaped = marker.replaceAll("'", "'\\''");
  fs.writeFileSync(path.join(macos, "Native Test"), `#!/bin/sh\nprintf native-output\\n\nprintf ran > '${escaped}'\nexit 7\n`, { mode: 0o755 });
  const result = runCli(root, "--game", appPath, "--runtime", "native", "--user-data", userDataDir, "--wait");
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /native-output/);
  assert.equal(fs.readFileSync(marker, "utf8"), "ran");
  const games = GameStore.loadGames(userDataDir);
  assert.equal(games.length, 1);
  assert.equal(games[0].runtimeId, "native");
  assert.ok(games[0].lastPlayedAt > 0);
});

test("CLI imports an extensionless publisher bundle and runs its original script with native cwd", t => {
  if (process.platform !== "darwin") return t.skip("macOS application fixture");
  const { root, userDataDir } = fixture(t), appPath = path.join(root, "Publisher Game");
  const macos = path.join(appPath, "Contents/MacOS"), executable = path.join(macos, "runner");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>runner</string></dict></plist>');
  const script = '#!/bin/sh\nprintf "publisher:%s\\nworking:%s\\n" "$0" "$PWD"\nexit 7\n';
  fs.writeFileSync(executable, script, { mode: 0o755 });
  const result = runCli(root, "--game", appPath, "--user-data", userDataDir, "--wait");
  assert.equal(result.status, 7, result.stderr);
  assert.ok(result.stdout.includes(`publisher:${executable}`));
  assert.equal(fs.realpathSync(result.stdout.match(/^working:(.+)$/m)?.[1] || "missing"), fs.realpathSync(macos));
  const games = GameStore.loadGames(userDataDir); assert.equal(games.length, 1);
  assert.equal(games[0].runtimeId, "native"); assert.equal(games[0].nativeAppPath, appPath);
  assert.equal(fs.readFileSync(executable, "utf8"), script); assert.equal(fs.existsSync(appPath + ".app"), false);
});

test("scripted Intel launches select graphics for the actual process before preparation", async t => {
  const ReShade = require("../src/modules/shared/reshade"), calls = [];
  t.mock.method(ReShade, "prepare", async (_entry, options) => {
    calls.push(options.graphicsArchitecture);
    assert.equal(options.graphicsInputs.architecture, "x86_64");
    assert.equal(options.graphicsInputs.cameraProjection, true);
    return {DYLD_INSERT_LIBRARIES: "/included/universal.dylib", SELECTED_ARCH: options.graphicsArchitecture};
  });
  const {launcher, gamePath} = fixture(t, {mod: {
    resolveGraphicsInputs: () => ({architecture: "arm64", cameraProjection: true}),
    launchRuntime: async (_runtime, _entry, context) => {
      const selected = await context.getGameEffectsEnvironment({needsRosetta: true});
      assert.equal(selected.SELECTED_ARCH, "x86_64");
      assert.equal((await context.applyGameEnvironment({}, {needsRosetta: true})).SELECTED_ARCH, "x86_64");
      return {pid: 1};
    }
  }});
  const entry = await launcher.resolveEntry(gamePath);entry.effects = shaderPlan("crt");
  await launcher.launchEntry(entry);assert.deepEqual(calls, ["x86_64"]);
});

test("a late script architecture selection serializes unused preparation before replacing its publication", async t => {
  const ReShade = require("../src/modules/shared/reshade"), calls = [];
  let release, entered;
  const firstStarted = new Promise(resolve => {entered = resolve;}), firstDone = new Promise(resolve => {release = resolve;});
  t.mock.method(ReShade, "prepare", async (_entry, options) => {
    const architecture = options.graphicsArchitecture;calls.push(architecture);
    if (calls.length === 1) {entered();await firstDone;}
    return {DYLD_INSERT_LIBRARIES: "/included/universal.dylib", SELECTED_ARCH: architecture};
  });
  const {launcher, gamePath} = fixture(t, {mod: {
    resolveGraphicsInputs: () => ({architecture: "arm64"}),
    launchRuntime: async (_runtime, _entry, context) => {
      const inspected = context.getGameEffectsEnvironment();await firstStarted;
      const selected = context.getGameEffectsEnvironment({needsRosetta: true});
      await new Promise(resolve => setImmediate(resolve));assert.deepEqual(calls, ["arm64"]);
      release();assert.equal((await inspected).SELECTED_ARCH, "arm64");
      assert.equal((await selected).SELECTED_ARCH, "x86_64");
      assert.equal((await context.applyGameEnvironment({})).SELECTED_ARCH, "x86_64");
      return {pid: 1};
    }
  }});
  const entry = await launcher.resolveEntry(gamePath);entry.effects = shaderPlan("crt");
  await launcher.launchEntry(entry);assert.deepEqual(calls, ["arm64", "x86_64"]);
});

test("Play preparation actions see the runtime being launched, not the stored one", async t => {
  const seen = [];
  const { launcher, gamePath, manifest } = fixture(t, { launcher: { confirmRuntimeInstall: async () => true }, mod: {
    actions: { probe: async (_entry, _payload, context) => { seen.push(context.runtimeId); return { ready: true }; } },
    launchRuntime: async () => ({ pid: 1 })
  } });
  manifest.runtime.supported = [...manifest.runtime.supported, "alternate"];
  manifest.runtime.preLaunch = { alternate: { statusAction: "probe" } };
  const entry = await launcher.resolveEntry(gamePath);
  assert.equal(entry.runtimeId, "runner");
  assert.equal((await launcher.launchEntry(entry, { runtimeId: "alternate" })).runtimeId, "alternate");
  assert.deepEqual(seen, ["alternate"]);
});

test("Play asks once for a planned download; the manager's own check for that plan does not ask again", async t => {
  const prompts = [];
  const { confirmToolInstall } = require("../src/modules/shared/runtime/tool-install");
  const manager = { id: "test-runtime", label: "Test runtime",
    installRuntime: async context => {
      await confirmToolInstall(context, { managerId: "test-runtime", version: "2.0", requiresDownload: true });
      await assert.rejects(confirmToolInstall(context, { managerId: "other-tool", version: "1", requiresDownload: true }), /canceled/);
      return { version: "2.0" };
    } };
  const { launcher, gamePath } = fixture(t, { launcher: { confirmRuntimeInstall: async plan => { prompts.push(plan.managerId); return plan.managerId === "test-runtime"; } }, mod: {
    runtimeManagers: [manager],
    ensureRuntime: async () => ({ managerId: manager.id, version: "2.0" }),
    launchRuntime: async () => ({ pid: 1 })
  } });
  const entry = await launcher.resolveEntry(gamePath);
  await launcher.launchEntry(entry);
  assert.deepEqual(prompts, ["test-runtime", "other-tool"]);
});
