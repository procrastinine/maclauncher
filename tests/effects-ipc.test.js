const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const Plan = require("../src/modules/shared/effects/plan"), ReShade = require("../src/modules/shared/reshade");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
function fixture(t) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "effects-ipc-")));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = { gameId: "game-a", gamePath: "/Games/A", runtimeId: "player", moduleId: "example", notes: "Keep", runtimeSettings: { networkIsolation: true },
    reshade: { enabled: true, preset: "grayscale" }, graphics: { spatialMethod: "bilinear" } };
  const calls = [], handlers = new Map(), replies = [], saved = [], owner = {};
  const EffectsRuntime = { info: (entry, options) => { calls.push(["info", options]);return { mode: entry.effects ? "advanced" : "simple", plan: Plan.fromLegacy(entry), catalog: [] }; },
    describe: async (entry, id, draft, options) => { calls.push(["describe", id, draft, options]);return { key: "key", parameters: [] }; },
    prepare: async (entry, options) => { calls.push(["prepare", structuredClone(entry.effects), options]); },
    publishSimple: () => calls.push(["simple"]) };
  const context = { AbortController, EffectsRuntime, EffectsPlan: Plan, ReShade, GraphicsSettings: Graphics,
    ReShadeFilters: require("../src/modules/shared/reshade/filter-library"),
    fs, userDataDir, app: {}, logger: {warn() {}}, loadSettings: () => ({}), loadGamesHydrated: () => [entry],
    findGameByPath: (games, gamePath) => games.find(game => game.gamePath === gamePath), resolveModuleId: game => game.moduleId,
    Modules: { getModuleInfo: () => ({ runtime: { entries: { player: { graphicsHost: "window" } } } }) },
    graphicsInputsResult: { runtimeId: "player", graphicsInputs: { depth: true } },
    launcherService: { runAction: async (_entry, action) => { assert.equal(action, "graphicsInputs");return context.graphicsInputsResult; } },
    runningGameSessions: new Map(), ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    saveGameRecord: entry => saved.push(structuredClone(entry)), cachedState: null,
    buildState: (_settings, games) => ({ games }), broadcastState: () => calls.push(["broadcast"]),
    getLauncherDialogOwner: () => owner, dialog: { showOpenDialog: async (...args) => { calls.push(["dialog", args]);return replies.shift() || { canceled: true }; } },
    require: id => {
      if (id === "../modules/shared/reshade/simple-setup") return {ensureGraphicsModel: options => context.ensureGraphicsModel(options)};
      if (id === "../modules/shared/graphics-warning") return require("../src/modules/shared/graphics-warning");
      if (id === "./graphics-update") return require("../src/main/graphics-update");
      if (id === "../modules/shared/reshade/launch-binding") return {read: () => null, isCurrent: () => true};
      assert.equal(id, "../modules/shared/reshade/live-controls");return { write: entry => calls.push(["controls", entry]) };
    },
    ensureGraphicsModel: async () => null,
    backendService: {request: async (...args) => {calls.push(["runtime-action", ...args]);return {modelPath: "/Models/Ready.dlssmodel"};}},
    refreshRuntimeSnapshots: async ids => calls.push(["refresh", ids])
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  vm.runInNewContext(source.slice(source.indexOf("const graphicsEdits = new Map();"), source.indexOf("async function saveGameReShade(")), context);
  return { entry, EffectsRuntime, calls, saved, context, replies, userDataDir,
    invoke: (name, ...args) => handlers.get("launcher:" + name)(null, ...args) };
}
test("advanced IPC reads drafts without mutation, preserves preferences and rolls back failed saves", async t => {
  const f = fixture(t), before = structuredClone(f.entry), draft = Plan.fromLegacy(f.entry);
  assert.equal((await f.invoke("getGameEffects", f.entry.gamePath)).mode, "simple");
  await f.invoke("getGameEffectParameters", f.entry.gamePath, draft.video[0].id, draft);
  assert.equal(f.saved.length, 0);assert.deepEqual(f.entry, before);
  assert.deepEqual(f.calls[0][1].graphicsInputs, { depth: true });assert.equal(f.calls[0][1].graphicsHost, "window");
  await f.invoke("setGameEffects", f.entry.gamePath, draft);
  assert.deepEqual(f.entry.effects, draft);assert.deepEqual(f.entry.runtimeSettings, before.runtimeSettings);assert.equal(f.entry.notes, "Keep");
  assert.deepEqual(f.entry.reshade, before.reshade);assert.deepEqual(f.entry.graphics, before.graphics);
  const working = structuredClone(f.entry), saves = f.saved.length;
  f.EffectsRuntime.prepare = async () => { throw Error("shader compile failed"); };
  await assert.rejects(f.invoke("setGameEffects", f.entry.gamePath, { schema: 1, mode: "advanced", video: [] }), /compile failed/);
  assert.deepEqual(f.entry, working);assert.equal(f.saved.length, saves);
  await f.invoke("resetGameEffects", f.entry.gamePath);
  assert.equal(f.entry.effects, null);assert.equal(f.entry.reshade.enabled, false);assert.equal(f.entry.graphics.spatialMethod, "off");
  assert.equal(f.entry.notes, "Keep");assert.deepEqual(f.entry.runtimeSettings, before.runtimeSettings);
  assert.ok(f.calls.some(row => row[0] === "simple"));
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
  await f.invoke("getGameEffectParameters", f.entry.gamePath, "node", Plan.fromLegacy(f.entry));
  assert.equal(f.calls.find(row => row[0] === "describe")[3].graphicsArchitecture, "arm64");
});
test("the first advanced edit persists the canonical plan returned by preparation", async t => {
  const f = fixture(t), draft = Plan.fromLegacy(f.entry);
  const node = draft.video.find(row => row.kind === "spatial");node.method = "ls1";node.settings.spatialMethod = "ls1";
  const canonical = Plan.validate(draft), model = "sha256-" + "a".repeat(64);
  canonical.video.find(row => row.kind === "spatial").settings.modelVersion = model;
  f.EffectsRuntime.prepare = async () => ({ plan: canonical });
  await f.invoke("setGameEffects", f.entry.gamePath, draft);
  assert.deepEqual(f.entry.effects, canonical);assert.deepEqual(f.saved[0].effects, canonical);
  assert.equal(draft.video.find(row => row.kind === "spatial").settings.modelVersion, null);
  assert.equal(f.entry.graphics.spatialMethod, "bilinear");
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
test("preload forwards draft metadata and plan edits only after explicit calls", async () => {
  let api;const calls = [], source = fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8");
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => api = value.launcher },
    ipcRenderer: { invoke: async (...args) => calls.push(args) }, webUtils: {} }) });
  assert.equal(calls.length, 0);const draft = { schema: 1, mode: "advanced", video: [] };
  await api.getGameEffects("/game");await api.getGameEffectParameters("/game", "node", draft);
  await api.setGameEffects("/game", draft);await api.resetGameEffects("/game");await api.pickGameEffectFile("/game");
  const patch = {frameGeneration: "lsfg", frameMultiplier: 4};
  await api.ensureGameGraphicsModel("/game", "lossless", patch);
  assert.deepEqual(calls, [["launcher:getGameEffects", "/game"], ["launcher:getGameEffectParameters", "/game", "node", draft],
    ["launcher:setGameEffects", "/game", draft], ["launcher:resetGameEffects", "/game"], ["launcher:pickGameEffectFile", "/game"],
    ["launcher:ensureGameGraphicsModel", "/game", "lossless", patch]]);
});
test("Simple model setup forwards the prospective settings through managed actions without enabling effects", async t => {
  const f = fixture(t), before = structuredClone(f.entry), patch = {neuralMethod: "mlx-dlss"};
  assert.equal(await f.invoke("ensureGameGraphicsModel", f.entry.gamePath, "neural", patch), null);
  assert.equal(f.calls.length, 0);
  f.context.ensureGraphicsModel = async options => {
    assert.equal(options.entry, f.entry);assert.equal(options.kind, "neural");assert.equal(options.patch, patch);
    return options.runRuntimeAction("graphics-neural-models", "setup", {setupActionId: "downloadDlssMac"});
  };
  assert.deepEqual(await f.invoke("ensureGameGraphicsModel", f.entry.gamePath, "neural", patch), {modelPath: "/Models/Ready.dlssmodel"});
  assert.deepEqual(f.calls[0], ["runtime-action", "runtime:graphics-neural-models", "runtimeAction", "graphics-neural-models", "setup", {setupActionId: "downloadDlssMac"}]);
  assert.deepEqual([...f.calls.find(row => row[0] === "refresh")[1]], ["graphics-neural-models"]);
  assert.deepEqual(f.entry, before);assert.equal(f.saved.length, 0);
  f.entry.effects = Plan.fromLegacy(f.entry);
  await assert.rejects(f.invoke("ensureGameGraphicsModel", f.entry.gamePath, "neural", patch), /Advanced/);
  await assert.rejects(f.invoke("ensureGameGraphicsModel", "/missing", "neural", patch), /not found/);
});

test("optional model inventory refresh cannot delay setup or reject through a failing warning sink", async t => {
  const f = fixture(t);let reject;
  f.context.ensureGraphicsModel = async () => ({modelPath: "/Models/Ready.dlssmodel"});
  f.context.refreshRuntimeSnapshots = () => new Promise((_resolve, fail) => {reject = fail;});
  f.context.logger.warn = () => Promise.reject(new Error("Notification sink unavailable"));
  assert.deepEqual(await f.invoke("ensureGameGraphicsModel", f.entry.gamePath, "neural", {}), {modelPath: "/Models/Ready.dlssmodel"});
  reject(new Error("Inventory worker unavailable"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.entry.graphics.spatialMethod, "bilinear");assert.equal(f.saved.length, 0);
});
