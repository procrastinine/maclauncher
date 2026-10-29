const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const Plan = require("../src/modules/shared/effects/plan"), StoredPlan = require("../src/modules/shared/effects/stored-plan"), ReShade = require("../src/modules/shared/reshade");
const shaderPlan = (preset = "grayscale") => ({schema: 2, mode: "advanced", enabled: true, video: [{id: "shader", kind: "shader", enabled: true, shader: {enabled: true, preset}}]});
// The main effects section (queue, status owner, handlers) with module work
// stubbed. `live` gives the game a running session with a live binding.
function fixture(t, {live = false} = {}) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "effects-ipc-")));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = { gameId: "game-a", gamePath: "/Games/A", runtimeId: "player", moduleId: "example", notes: "Keep", runtimeSettings: { networkIsolation: true }, effects: null };
  const calls = [], handlers = new Map(), replies = [], saved = [], sent = [], invalidated = [], owner = {}, timers = [];
  const session = {id: "session", pid: 4242}, binding = {effectPlanAPI: 1, pid: session.pid, launchId: "launch"};
  const EffectsRuntime = { info: (entry, options) => { calls.push(["info", options]);return { mode: "advanced", plan: entry.effects, catalog: [] }; },
    describe: async (entry, id, draft, options) => { calls.push(["describe", id, draft, options]);return { key: "key", parameters: [] }; },
    prepare: async (entry, options) => { calls.push(["prepare", structuredClone(entry.effects), options]); },
    publishSimple: () => calls.push(["simple"]), emptyDocument: () => ({schema: 1, mode: "advanced", revision: "empty-revision", nodes: []}),
    acceptance: async entry => {
      const published = context.graphicsStatus.status(entry.gamePath).published;
      return published ? {revision: published.documentRevision, launchId: binding.launchId} : null;
    } };
  const context = { AbortController, EffectsRuntime, EffectsPlan: Plan, StoredPlan, ReShade,
    ReShadeFilters: require("../src/modules/shared/reshade/filter-library"),
    fs, userDataDir, app: {}, logger: {warn() {}}, downloadManager: {}, confirmRuntimeInstallation: () => assert.fail("No download in IPC fixture"),
    BrowserWindow: {getAllWindows: () => [{isDestroyed: () => false, webContents: {isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload])}}]},
    loadSettings: () => ({}), loadGamesHydrated: () => [entry], gameRecordsCache: [entry],
    findGameByPath: (games, gamePath) => games.find(game => game.gamePath === gamePath), resolveModuleId: game => game.moduleId,
    Modules: { getModuleInfo: () => ({ runtime: { entries: { player: { graphicsHost: "window" } } } }) },
    graphicsInputsResult: { runtimeId: "player", graphicsInputs: { depth: true } },
    launcherService: { runAction: async (_entry, action) => { assert.equal(action, "graphicsInputs");return context.graphicsInputsResult; } },
    runningGameSessions: new Map(live ? [[entry.gamePath, new Map([[session.id, session]])]] : []),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    saveGameRecord: entry => saved.push(structuredClone(entry)), cachedState: null,
    buildState: (_settings, games) => ({ games }), broadcastState: () => calls.push(["broadcast"]),
    getLauncherDialogOwner: () => owner, dialog: { showOpenDialog: async (...args) => { calls.push(["dialog", args]);return replies.shift() || { canceled: true }; } },
    settingsCoordinator: {}, listRuntimeManagers: () => [], runtimeInventoryRevision: 0,
    // Main's own timers run only when a test calls them.
    setTimeout: (callback, ms) => {const timer = {callback, ms, unref() {}};timers.push(timer);return timer;}, clearTimeout: timer => {if (timer) timer.cleared = true;},
    require: id => {
      if (["./graphics-update", "./graphics-status", "./graphics-runtime-use", "./graphics-catalog"].includes(id)) return require(path.join("../src/main", id));
      if (id === "../modules/shared/effects/edit-operations.mjs") return require("../src/modules/shared/effects/edit-operations.mjs");
      if (id === "node:timers/promises") return require(id);
      if (id === "../modules/shared/bounded-retry") return require("../src/modules/shared/bounded-retry");
      if (id === "../modules/shared/effects/execution-requirements") return require("../src/modules/shared/effects/execution-requirements");
      if (id === "../modules/shared/reshade/launch-binding") return {read: () => live ? binding : null, isCurrent: () => true, resolvePayload: async () => null};
      if (id === "../modules/shared/reshade/hardware-support") return {inspect: async () => undefined, snapshot: () => ({state: "unknown"})};
      assert.equal(id, "../modules/shared/reshade/live-controls");return { write: entry => calls.push(["controls", entry]) };
    },
    backendService: {invalidateGraphicsPreparation: async entry => {invalidated.push(entry.gameId);return false;}},
    refreshRuntimeSnapshots: async ids => calls.push(["refresh", ids])
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  vm.runInNewContext(source.slice(source.indexOf("const graphicsEdits = new Map();"), source.indexOf("function publishReShadeFilters(")) +
    "\nthis.graphicsStatus = graphicsStatus;this.flushGraphics = async () => { while (graphicsEdits.size) await Promise.allSettled([...graphicsEdits.values()]); };", context);
  t.after(() => context.graphicsStatus.dispose());
  const events = channel => sent.filter(row => row[0] === channel).map(row => row[1]);
  const settled = async phase => {
    await context.flushGraphics();
    for (let index = 0; index < 100 && context.graphicsStatus.status(entry.gamePath).phase !== phase; index++) await new Promise(resolve => setTimeout(resolve, 10));
    return context.graphicsStatus.status(entry.gamePath);
  };
  return { entry, EffectsRuntime, calls, saved, sent, events, invalidated, context, replies, userDataDir, session, binding, timers, settled,
    invoke: (name, ...args) => handlers.get("launcher:" + name)(null, ...args) };
}
test("plan IPC saves intent, reports a failed rendering publication and Clear effects keeps other settings", async t => {
  const f = fixture(t), before = structuredClone(f.entry), draft = shaderPlan();
  const info = await f.invoke("getGameEffects", f.entry.gamePath);
  assert.equal(info.mode, "advanced");assert.equal(info.graphicsStatus.phase, "saved");assert.equal(info.graphicsStatus.planSource, "effects");
  await f.invoke("getGameEffectParameters", f.entry.gamePath, draft.video[0].id, draft);
  assert.equal(f.saved.length, 0);assert.deepEqual(f.entry, before);
  assert.deepEqual(f.calls[0][1].graphicsInputs, { depth: true });assert.equal(f.calls[0][1].graphicsHost, "window");
  const accepted = await f.invoke("setGameEffects", f.entry.gamePath, draft);assert.deepEqual(accepted.plan, Plan.validate(draft));
  assert.equal(accepted.desiredRevision, StoredPlan.revision(accepted.plan));await f.settled("saved");
  assert.deepEqual(f.entry.effects, accepted.plan);assert.deepEqual(f.entry.runtimeSettings, before.runtimeSettings);assert.equal(f.entry.notes, "Keep");
  assert.equal(f.calls.find(row => row[0] === "prepare")[2].live, false, "a stopped game validates its plan without publishing");
  const saves = f.saved.length, render = path.join(f.userDataDir, "accepted-render"), original = Buffer.from("working shader bytes");
  fs.writeFileSync(render, original);
  f.EffectsRuntime.prepare = async (_entry, options) => {options.publication.write(render, "rejected shader", {root:f.userDataDir});throw Error("shader compile failed");};
  const desired = {schema: 1, mode: "advanced", video: []};
  const acknowledged = await f.invoke("setGameEffects", f.entry.gamePath, desired);assert.deepEqual(acknowledged.plan, Plan.validate(Plan.migrate(desired)));
  const status = await f.settled("rejected");
  assert.deepEqual(f.entry.effects, acknowledged.plan);assert.equal(f.saved.length, saves + 1);
  assert.deepEqual(fs.readFileSync(render), original);
  assert.match(status.reason, /compile failed/);
  assert.ok(f.events("launcher:graphicsStatus").some(event => event.status.phase === "rejected" && event.status.desiredRevision === acknowledged.desiredRevision));
  assert.equal(f.events("launcher:graphicsPlanUpdate").length, 0, "the earlier update channel is retired");
  await f.invoke("resetGameEffects", f.entry.gamePath);
  assert.equal(f.entry.effects, null);assert.equal(Object.hasOwn(f.entry, "reshade") || Object.hasOwn(f.entry, "graphics"), false);
  assert.equal(f.entry.notes, "Keep");assert.deepEqual(f.entry.runtimeSettings, before.runtimeSettings);
  assert.ok(f.calls.some(row => row[0] === "simple"));
  assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).desiredRevision, StoredPlan.read({effects: null}).revision);
});
test("a running game without a current launch binding saves edits for the next launch", async t => {
  const f = fixture(t), draft = shaderPlan();
  f.context.runningGameSessions.set(f.entry.gamePath, new Map([["session", {id: "session", pid: 4242}]]));
  const accepted = await f.invoke("setGameEffects", f.entry.gamePath, draft);
  assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).phase, "deferred");await f.settled("deferred");
  assert.deepEqual(f.entry.effects, accepted.plan);assert.deepEqual(f.invalidated, ["game-a"]);
  assert.ok(!f.calls.some(row => row[0] === "prepare"));
  const status = await f.invoke("getGraphicsStatus", f.entry.gamePath);
  assert.equal(status.phase, "deferred");assert.equal(status.desiredRevision, accepted.desiredRevision);
  assert.equal(status.reason, "This game was started without live graphics editing. Changes apply on the next launch.");
  const final = f.events("launcher:graphicsStatus").at(-1).status;
  assert.equal(final.phase, "deferred");assert.equal(final.desiredRevision, accepted.desiredRevision);assert.equal(final.reason, status.reason);
  assert.ok(!f.events("launcher:graphicsStatus").some(event => event.status.published));
});
test("effects metadata follows the effective runtime returned by the read-only graphics query", async t => {
  const f = fixture(t);
  f.entry.runtimeId = "retired";
  f.context.graphicsInputsResult = { runtimeId: "current", graphicsInputs: { depth: true } };
  f.context.Modules.getModuleInfo = () => ({ runtime: { entries: { current: { graphicsHost: "explicit", graphicsArchitecture: "x64" } } } });
  const before = structuredClone(f.entry);
  await f.invoke("getGameEffects", f.entry.gamePath);
  const options = f.calls.find(row => row[0] === "info")[1];
  assert.equal(options.graphicsHost, "explicit");assert.equal(options.graphicsArchitecture, "x64");
  assert.deepEqual(f.entry, before);assert.equal(f.saved.length, 0);
  f.context.graphicsInputsResult.graphicsInputs.architecture = "arm64";
  await f.invoke("getGameEffectParameters", f.entry.gamePath, "node", shaderPlan());
  assert.equal(f.calls.find(row => row[0] === "describe")[3].graphicsArchitecture, "arm64");
});
test("live publication reports the prepared document without rewriting the requested model choice", async t => {
  const f = fixture(t, {live: true});
  const draft = {schema: 2, mode: "advanced", enabled: true, video: [{id: "scale", kind: "spatial", enabled: true, method: "ls1", settings: {spatialMethod: "ls1"}}]};
  const canonical = Plan.validate(draft), model = "sha256-" + "a".repeat(64);
  canonical.video[0].settings.modelVersion = model;
  f.EffectsRuntime.prepare = async (_entry, options) => {f.calls.push(["prepare", null, options]);return { plan: canonical, document: {revision: "bound-model", nodes: []} };};
  const accepted = await f.invoke("setGameEffects", f.entry.gamePath, draft);assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).phase, "preparing");
  const status = await f.settled("applied");
  assert.equal(f.calls.find(row => row[0] === "prepare")[2].live, true);
  assert.deepEqual(f.entry.effects, accepted.plan);assert.deepEqual(f.saved[0].effects, accepted.plan);
  assert.equal(f.entry.effects.video[0].settings.modelVersion, null);
  assert.equal(status.published.documentRevision, "bound-model");assert.equal(status.acknowledged.documentRevision, "bound-model");
  assert.ok(f.events("launcher:graphicsStatus").some(event => event.status.published?.documentRevision === "bound-model" && event.status.acknowledged?.documentRevision === "bound-model"));
});
test("a live edit the running game has not confirmed yet is asked again within its publication before it is deferred", async t => {
  const f = fixture(t, {live: true}), reason = "The running game did not confirm its current graphics. Keep the game window drawing and try again, or relaunch.";
  const unconfirmed = {deferred: true, retryable: true, reason};let attempts = 0, confirmAt = 3;
  f.EffectsRuntime.prepare = async () => ++attempts < confirmAt ? {...unconfirmed} : {plan: Plan.validate(shaderPlan()), document: {revision: "confirmed", nodes: []}};
  // The publication keeps its queue slot while it waits; only its timers advance it.
  const until = async predicate => {for (let index = 0; index < 200 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5));assert.ok(predicate());};
  const waits = () => f.timers.filter(timer => [1000, 2000, 4000].includes(timer.ms));
  const retry = async (ms, attempt) => {const timer = waits().at(-1);assert.equal(timer.ms, ms);timer.callback();await until(() => attempts === attempt);};
  await f.invoke("setGameEffects", f.entry.gamePath, shaderPlan());await until(() => waits().length === 1);
  assert.equal(attempts, 1);assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).phase, "preparing");
  await retry(1000, 2);await until(() => waits().length === 2);assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).phase, "preparing");
  await retry(2000, 3);
  assert.equal((await f.settled("applied")).published.documentRevision, "confirmed");
  // A game that never confirms ends deferred with the reason once.
  attempts = 0;confirmAt = Infinity;f.timers.length = 0;
  await f.invoke("setGameEffects", f.entry.gamePath, shaderPlan("crt"));await until(() => waits().length === 1);
  for (const [index, ms] of [1000, 2000, 4000].entries()) {await retry(ms, index + 2);if (index < 2) await until(() => waits().length === index + 2);}
  let status = await f.settled("deferred");
  assert.equal(attempts, 4);assert.equal(waits().length, 3, "the schedule is bounded");assert.equal(status.reason, reason);
  // Another publication of the game, such as a model resume, ends the wait.
  attempts = 0;f.timers.length = 0;
  await f.invoke("setGameEffects", f.entry.gamePath, shaderPlan());await until(() => waits().length === 1);
  confirmAt = 1;f.context.resumeGraphics(f.entry.gamePath);
  status = await f.settled("applied");
  assert.equal(attempts, 2, "the waiting publication does not try again");assert.equal(waits()[0].cleared, true);
});
test("a launch binds its status once its process binding is readable and reports its bypassed rows and native acceptance", async t => {
  const f = fixture(t, {live: true}), reason = "The shader could not be loaded. Choose an included shader or an existing .fx file.";
  f.entry.effects = {schema: 2, mode: "advanced", enabled: true, video: [{id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}},
    {id: "broken", kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: "/missing.fx"}}]};
  const stored = StoredPlan.read(f.entry, {userDataDir: f.userDataDir}), document = path.join(f.userDataDir, "effect-plan.json");
  fs.writeFileSync(document, JSON.stringify({schema: 1, mode: "advanced", revision: "launched", nodes: []}));
  f.EffectsRuntime.file = () => document;
  // The process is registered before the launch records its PID.
  Object.assign(f.binding, {pid: undefined, phase: "prepared", effectPlanRevision: stored.revision, graphicsPreparation: {skipped: [{id: "broken", reason}]}});
  f.context.graphicsRunsChanged();
  let status = f.context.graphicsStatus.status(f.entry.gamePath);
  assert.equal(status.running, true);assert.equal(status.live, false);assert.equal(status.phase, "saved");
  assert.equal(f.timers.length, 1, "an unbound run is read again shortly");
  Object.assign(f.binding, {pid: f.session.pid, phase: "spawned"});
  f.timers[0].callback();
  status = f.context.graphicsStatus.status(f.entry.gamePath);
  assert.equal(status.live, true);assert.equal(status.launchId, "launch");assert.equal(status.published.documentRevision, "launched");
  status = await f.settled("partial");
  assert.equal(status.acknowledged.documentRevision, "launched");assert.equal(status.desiredRevision, stored.revision);
  assert.deepEqual(status.rows, {gray: {state: "active"}, broken: {state: "bypassed", reason}});
  assert.equal(f.timers.length, 1, "a bound launch is not read again");
  assert.equal((await f.invoke("getGraphicsStatus", f.entry.gamePath)).phase, "partial", "a status read keeps the bound launch");
  f.context.runningGameSessions.clear();f.context.graphicsRunsChanged();
  assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).phase, "saved");
  // A status read binds a launch whose binding appeared without a retry, and
  // a launch of an earlier saved plan is not reported as this plan.
  f.context.runningGameSessions.set(f.entry.gamePath, new Map([["next", {id: "next", pid: f.session.pid}]]));
  Object.assign(f.binding, {launchId: "next", effectPlanRevision: "earlier"});
  status = await f.invoke("getGraphicsStatus", f.entry.gamePath);
  assert.equal(status.live, true);assert.equal(status.launchId, "next");assert.equal(status.phase, "saved");assert.equal(status.published, undefined);
});
test("a launch whose plan has no active row is applied when it binds, with or without diagnostics, and stopping it claims no pending change (D11)", async t => {
  const Requirements = require("../src/modules/shared/effects/execution-requirements");
  const allOff = {...shaderPlan(), video: shaderPlan().video.map(row => ({...row, enabled: false}))};
  for (const [name, effects, diagnostics] of [["master Off", {...shaderPlan(), enabled: false}, false], ["master Off with diagnostics", {...shaderPlan(), enabled: false}, true],
    ["every row Off", allOff, false], ["every row Off with diagnostics", allOff, true]]) {
    await t.test(name, async t => {
      const f = fixture(t, {live: true});
      f.entry.effects = effects;
      const stored = StoredPlan.read(f.entry, {userDataDir: f.userDataDir}), document = path.join(f.userDataDir, "effect-plan.json");
      fs.writeFileSync(document, JSON.stringify({schema: 1, mode: "advanced", revision: "launched-off", nodes: []}));
      f.EffectsRuntime.file = () => document;
      f.EffectsRuntime.acceptance = async () => assert.fail("A launch without processing waits for no native acceptance");
      // Diagnostics load the processor for the launch; the plan still runs nothing.
      Object.assign(f.binding, {phase: "spawned", effectPlanRevision: stored.revision, executionRequirements: Requirements.analyze(f.entry, {diagnostics})});
      assert.equal(f.binding.executionRequirements.needed.processor, diagnostics);
      f.context.graphicsRunsChanged();
      const status = f.context.graphicsStatus.status(f.entry.gamePath);
      assert.equal(status.phase, "applied");assert.equal(status.acknowledged.documentRevision, "launched-off");
      assert.deepEqual(status.rows, {shader: {state: "off"}});
      assert.equal(f.timers.length, 0, "nothing is read again");
      f.context.runningGameSessions.clear();f.context.graphicsRunsChanged();
      const stopped = f.context.graphicsStatus.status(f.entry.gamePath);
      assert.equal(stopped.phase, "saved");assert.equal(stopped.reason, undefined);
    });
  }
});
test("a saved row that cannot be prepared for a stopped game leaves the plan saved and its launch reports the row bypassed", async t => {
  const f = fixture(t, {live: true}), reason = "The shader could not be loaded. Choose an included shader or an existing .fx file.";
  f.context.runningGameSessions.clear();
  f.EffectsRuntime.prepare = async (_entry, options) => {f.calls.push(["prepare", null, options]);if (!options.bypassRows) throw Error(reason);};
  const accepted = await f.invoke("setGameEffects", f.entry.gamePath, {schema: 2, mode: "advanced", enabled: true, video: [
    {id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}},
    {id: "broken", kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: "/missing.fx"}}]});
  assert.equal((await f.settled("saved")).phase, "saved", "one row that cannot be prepared does not reject the stopped game's plan");
  assert.equal(f.calls.find(row => row[0] === "prepare")[2].live, false);
  const document = path.join(f.userDataDir, "effect-plan.json");
  fs.writeFileSync(document, JSON.stringify({schema: 1, mode: "advanced", revision: "launched", nodes: []}));f.EffectsRuntime.file = () => document;
  Object.assign(f.binding, {effectPlanRevision: accepted.desiredRevision, graphicsPreparation: {skipped: [{id: "broken", reason}]}});
  f.context.runningGameSessions.set(f.entry.gamePath, new Map([[f.session.id, f.session]]));f.context.graphicsRunsChanged();
  const status = await f.settled("partial");
  assert.equal(status.phase, "partial");
  assert.deepEqual(status.rows, {gray: {state: "active"}, broken: {state: "bypassed", reason}});
});
test("an unreadable saved plan is reported, blocks edits and stays saved byte for byte (S5)", async t => {
  const f = fixture(t), damaged = {schema: 2, mode: "advanced", enabled: true, video: [{id: "a", kind: "shader", enabled: true, shader: {preset: "crt"}}], extra: true};
  f.entry.effects = structuredClone(damaged);
  const info = await f.invoke("getGameEffects", f.entry.gamePath);
  assert.equal(info.graphicsStatus.phase, "invalid");
  assert.equal(info.graphicsStatus.planSource, "invalid");assert.match(info.graphicsStatus.reason, /Clear effects/);
  await assert.rejects(async () => f.invoke("setGameEffects", f.entry.gamePath, shaderPlan()), {code: "GRAPHICS_STORED_PLAN_INVALID"});
  assert.deepEqual(f.entry.effects, damaged);assert.equal(f.saved.length, 0);
  assert.ok(f.events("launcher:graphicsStatus").some(event => event.status.phase === "invalid"));
  await f.invoke("resetGameEffects", f.entry.gamePath);
  assert.equal(f.entry.effects, null);assert.equal((await f.invoke("getGraphicsStatus", f.entry.gamePath)).phase, "saved");
});
test("advanced picker cancellation and selection never change the game or legacy settings", async t => {
  const f = fixture(t), before = structuredClone(f.entry), file = path.join(f.userDataDir, "Effect.hook");
  fs.writeFileSync(file, "//!HOOK MAIN\n//!BIND HOOKED\n");
  assert.equal(await f.invoke("pickGameEffectFile", f.entry.gamePath), null);
  f.replies.push({ canceled: false, filePaths: [file] });
  assert.equal(await f.invoke("pickGameEffectFile", f.entry.gamePath), file);
  assert.deepEqual(f.entry, before);assert.equal(f.saved.length, 0);
  const count = f.calls.length;
  await assert.rejects(f.invoke("pickGameEffectFile", "/missing"), /not found/);assert.equal(f.calls.length, count);
});
test('model picker operation forwarding preserves the game and does not publish an attachment',async t=>{
  const f=fixture(t),before=structuredClone(f.entry),calls=[];f.context.pickEffectFile=async(...args)=>{calls.push(args);return '/managed/model.depthmodel';};
  assert.equal(await f.invoke('pickGameEffectFile',f.entry.gamePath,'neural-model','depth-anything-v2-small'),'/managed/model.depthmodel');assert.deepEqual(calls,[['neural-model','depth-anything-v2-small']]);assert.deepEqual(f.entry,before);assert.deepEqual(f.saved,[]);
});
test("preload forwards draft metadata and plan edits only after explicit calls", async () => {
  let api;const calls = [], source = fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8");
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => api = value.launcher },
    ipcRenderer: { invoke: async (...args) => calls.push(args) }, webUtils: {} }) });
  assert.equal(calls.length, 0);const draft = { schema: 1, mode: "advanced", video: [] };
  await api.getGameEffects("/game");await api.getGameEffectParameters("/game", "node", draft);
  await api.setGameEffects("/game", draft);await api.resetGameEffects("/game");await api.pickGameEffectFile("/game");
  await api.pickGameEffectFile('/game','neural-model','depth-anything-v2-small');await api.pickEffectsPresetFile('neural-model','rife');
  assert.deepEqual(calls, [["launcher:getGameEffects", "/game"], ["launcher:getGameEffectParameters", "/game", "node", draft],
    ["launcher:setGameEffects", "/game", draft, undefined], ["launcher:resetGameEffects", "/game"], ["launcher:pickGameEffectFile", "/game"],
['launcher:pickGameEffectFile','/game','neural-model','depth-anything-v2-small'],['launcher:pickEffectsPresetFile','neural-model','rife']]);
});
test("preload exposes the graphics status channel and none of the retired graphics methods", () => {
  let api;const calls = [], listeners = new Map(), source = fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8");
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => api = value.launcher },
    ipcRenderer: { invoke: async (...args) => calls.push(args), on: (channel, handler) => listeners.set(channel, handler),
      removeListener: (channel, handler) => {if (listeners.get(channel) === handler) listeners.delete(channel);} }, webUtils: {} }) });
  api.getGraphicsStatus("/game");assert.deepEqual(calls, [["launcher:getGraphicsStatus", "/game"]]);
  const received = [], stop = api.onGraphicsStatus(event => received.push(event));
  listeners.get("launcher:graphicsStatus")({}, {gamePath: "/game", status: {phase: "applied"}});
  assert.deepEqual(received, [{gamePath: "/game", status: {phase: "applied"}}]);
  stop();assert.equal(listeners.has("launcher:graphicsStatus"), false);
  for (const retired of ["ensureGameGraphicsModel", "getGameShaderParameters", "onGameGraphicsUpdate", "setGameReShade", "setGameGraphics", "pickGameReShadeEffect"])
    assert.equal(api[retired], undefined, retired);
});
test("an edit with an unreadable row saves and publishes its other rows with a notice", async t => {
  const f = fixture(t), draft = shaderPlan();
  draft.video.push({id: "broken", kind: "shader", enabled: true, shader: {enabled: true, preset: "cas"}, future: true}, "row");
  const accepted = await f.invoke("setGameEffects", f.entry.gamePath, draft);
  assert.deepEqual(accepted.plan, Plan.validate(shaderPlan()));await f.settled("saved");
  assert.deepEqual(f.entry.effects, accepted.plan);
  assert.deepEqual(f.calls.find(row => row[0] === "prepare")[1], accepted.plan, "preparation receives only the readable rows");
  assert.deepEqual(Array.from(accepted.notices, notice => notice.dropped), [true, true]);
  assert.match(Array.from(accepted.notices, notice => notice.message).join("\n"), /effect “cas” is skipped/);
  const saves = f.saved.length;
  await assert.rejects(async () => f.invoke("setGameEffects", f.entry.gamePath, {...shaderPlan(), extra: true}), /valid ordered effects plan/);
  assert.equal(f.saved.length, saves, "a desired plan without a readable envelope is not saved");
});
