const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Update = require("../src/main/graphics-update");
const {createPublication} = require("../src/modules/shared/reshade/live-publication");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-update-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, "effect-plan.json");fs.writeFileSync(file, "accepted");
  let current = true;
  return {root, file, options: {running: true, isCurrent: () => current},
    replace() {current = false;fs.writeFileSync(file, "new session");},
    prepare: async ({publication}) => {publication.write(file, "candidate", {root, activation: true});return {plan: "candidate"};}};
}
function modelFixture(t) {
  const f = fixture(t), coordinator = require("../src/core/runtime-coordinator").createRuntimeCoordinator();
  const owner = coordinator.client(), writer = coordinator.client();
  const acquired = [], released = [], acquireUse = owner.acquireUse, release = owner.release;
  owner.acquireUse = async (...args) => {const token = await acquireUse(...args);acquired.push(token);return token;};
  owner.release = async token => {const result = await release(token);released.push(token);return result;};
  const use = require("../src/main/graphics-runtime-use").createGraphicsRuntimeUse({session: {pid: process.pid},
    isCurrent: f.options.isCurrent, coordinator: owner, managers: [{id: "graphics-models"}, {id: "graphics-neural-models"}]});
  t.after(() => use.release());
  return {...f, coordinator, writer, use, acquired, released, options: {...f.options, graphicsRuntimeUse: use,
    useRuntime: identity => use.useRuntime(identity), useModel: version => use.useRuntime({managerId: "graphics-models", version})}};
}

for (const boundary of ["shader failure", "cancel", "native validation", "defer"]) test(`unpublished model access is released after ${boundary}`, async t => {
  const f = modelFixture(t), controller = new AbortController(), identity = {managerId: "graphics-models", version: "unused-candidate"};
  const failure = new Error("Later shader could not be compiled");
  const options = {...f.options, signal: controller.signal,
    ...(boundary === "native validation" ? {withGraphicsUpdate: async () => {throw failure;}} : {})};
  const pending = Update.apply({}, options, async staged => {
    await staged.useModel(identity.version);
    assert.equal(f.coordinator.snapshot().active.length, 1);
    await f.prepare(staged);
    if (boundary === "shader failure") throw failure;
    if (boundary === "cancel") {controller.abort(failure);controller.signal.throwIfAborted();}
    if (boundary === "defer") return {deferred: true};
  }, createPublication);
  if (boundary === "defer") assert.equal((await pending).deferred, true);
  else await assert.rejects(pending, error => error === failure);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  assert.equal(f.coordinator.snapshot().active.length, 0, "the rejected graph never owned a live model");
  const token = await f.writer.acquireMutation(identity);await f.writer.release(token);
});

test("failed candidates release only new models, preserving existing accepted model ownership", async t => {
  const f = modelFixture(t), accepted = {managerId: "graphics-models", version: "accepted"},
    unused = {managerId: "graphics-neural-models", version: "rejected"};
  await Update.apply({}, f.options, async staged => {await staged.useRuntime(accepted);return f.prepare(staged);}, createPublication);
  const before = f.acquired[0];
  await assert.rejects(Update.apply({}, f.options, async staged => {
    await staged.useRuntime(accepted);await staged.useRuntime(unused);
    assert.equal(f.coordinator.snapshot().active.length, 2, "accepted access is reused without another lease");
    throw Error("Invalid later shader");
  }, createPublication), /Invalid later shader/);
  const active = f.coordinator.snapshot().active;
  assert.equal(active.length, 1);assert.equal(f.released.includes(before), false);
  await assert.rejects(f.writer.acquireMutation(accepted), {code: "RUNTIME_IN_USE"});
  const token = await f.writer.acquireMutation(unused);await f.writer.release(token);
});

test("a candidate that reached publication retains its model even after byte rollback", async t => {
  const f = modelFixture(t), identity = {managerId: "graphics-models", version: "possibly-observed"};
  await assert.rejects(Update.apply({}, {...f.options, withGraphicsUpdate: async (_entry, _staged, publish) => {
    await publish();assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");throw Error("Native completion rejected");
  }}, async staged => {await staged.useRuntime(identity);return f.prepare(staged);}, createPublication), /Native completion rejected/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  assert.equal(f.coordinator.snapshot().active.length, 1);
  await assert.rejects(f.writer.acquireMutation(identity), {code: "RUNTIME_IN_USE"});
  await f.use.release();const token = await f.writer.acquireMutation(identity);await f.writer.release(token);
});

test("stale publication preflight releases a never-exposed model", async t => {
  const f = modelFixture(t);
  await assert.rejects(Update.apply({}, {...f.options, withGraphicsUpdate: async (_entry, _staged, publish) => {
    fs.writeFileSync(f.file, "independent accepted graph");await publish();
  }}, async staged => {await staged.useModel("not-published");return f.prepare(staged);}, createPublication),
  error => error.code === "GRAPHICS_LIVE_STALE");
  assert.equal(f.coordinator.snapshot().active.length, 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), "independent accepted graph");
});

test("source rejection releases its unpublished model scope while a processing retry retains its own access", async t => {
  const f = modelFixture(t), Source = require("../src/modules/shared/reshade/source-controls");
  const {binding} = Source.prepare({gameId: "retry"}, {userDataDir: f.root, launchId: "retry-launch",
    support: {control: "virtual", live: true, heights: true, multipliers: [1, 2, 3]}, source: {multiplier: 2}});
  const command = fs.readFileSync(binding.file), identity = {managerId: "graphics-models", version: "retry-model"};
  let attempts = 0;const tokens = [];
  await Update.apply({}, {...f.options, launchBinding: {sourceControl: binding}}, async staged => {
    attempts++;await staged.useRuntime(identity);
    tokens.push(f.acquired.at(-1));
    await f.prepare(staged);
    staged.publication.metadata.sourceResolutionCandidate = {multiplier: 3};
    if (attempts === 2) assert.match(staged.sourceResolutionFailures.virtual, /completed|source|frame/i);
  }, createPublication);
  assert.equal(attempts, 2, "missing actual virtual receipt triggers one processing-only retry");
  const active = f.coordinator.snapshot().active;
  assert.equal(active.length, 1);
  assert.notEqual(tokens[0], tokens[1], "the retry owns a different preparation scope");
  assert.ok(f.released.includes(tokens[0]));assert.equal(f.released.includes(tokens[1]), false);
  assert.deepEqual(fs.readFileSync(binding.file), command, "an unavailable source cannot publish or restore a fabricated allocation");
  await assert.rejects(f.writer.acquireMutation(identity), {code: "RUNTIME_IN_USE"});
  await f.use.release();const token = await f.writer.acquireMutation(identity);await f.writer.release(token);
});

test("ordinary Off publication never acquires optional resource access", async t => {
  const f = modelFixture(t);
  await Update.apply({}, f.options, () => {}, createPublication);
  assert.equal(f.coordinator.snapshot().active.length, 0);
  assert.equal(f.coordinator.snapshot().pending, 0);
});
test("module changes begin after shared preparation; accepted plan stays active until commit", async t => {
  const f = fixture(t);let release, began = false;
  const gate = new Promise(resolve => {release = resolve;});
  const options = {...f.options, withGraphicsUpdate: async (_entry, staged, publish) => {
    began = true;assert.equal(staged.prepared.plan, "candidate");
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
    await publish();assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
  }};
  const pending = Update.apply({}, options, async staged => {await gate;return f.prepare(staged);}, createPublication);
  assert.equal(began, false);assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  release();assert.deepEqual(await pending, {plan: "candidate"});assert.equal(began, true);
});
test("failed native validation keeps the accepted shared plan", async t => {
  const f = fixture(t), options = {...f.options, withGraphicsUpdate: async () => {throw Error("native shader rejected");}};
  await assert.rejects(Update.apply({}, options, f.prepare, createPublication), /native shader rejected/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("a native failure after commit restores the accepted shared plan", async t => {
  const f = fixture(t), options = {...f.options, withGraphicsUpdate: async (_entry, _staged, publish) => {
    await publish();throw Error("native completion rejected");
  }};
  await assert.rejects(Update.apply({}, options, f.prepare, createPublication), /native completion rejected/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("renderer compensation restores shared files before releasing its held image and is idempotent", async t => {
  const f = fixture(t);let rollbackCalls = 0;
  const options = {...f.options, withGraphicsUpdate: async (_entry, staged, publish) => {
    await publish();
    assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
    const first = staged.rollbackShared(), second = staged.rollbackShared();
    assert.equal(first, second);
    await first;
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
    throw Error("new frame rejected");
  }};
  const factory = value => {
    const publication = createPublication(value), original = publication.rollback;
    publication.rollback = () => {rollbackCalls++;return original();};return publication;
  };
  await assert.rejects(Update.apply({}, options, f.prepare, factory), /new frame rejected/);
  assert.equal(rollbackCalls, 1);
});
test("renderer compensation preserves independent newer bytes and reports restoration failure", async t => {
  const f = fixture(t), options = {...f.options, withGraphicsUpdate: async (_entry, staged, publish) => {
    await publish();fs.writeFileSync(f.file, "independent settings");
    await staged.rollbackShared();
  }};
  await assert.rejects(Update.apply({}, options, f.prepare, createPublication), /accepted graphics settings changed/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "independent settings");
});
test("renderer compensation reports a superseded source restore without overwriting it", async t => {
  const f = fixture(t), Source = require("../src/modules/shared/reshade/source-controls");
  const {binding} = Source.prepare({gameId: "source"}, {userDataDir: f.root, launchId: "source-launch",
    support: {control: "engine", live: true, multipliers: [1, 2, 3]}});
  const options = {...f.options, launchBinding: {sourceControl: binding},
    withGraphicsUpdate: async (_entry, staged, publish) => {
      const pending = publish(), command = JSON.parse(fs.readFileSync(binding.file, "utf8"));
      fs.writeFileSync(binding.statusFile, JSON.stringify({...command, requested: command.source,
        applied: {scale: .5, viewportWidth: 1280, viewportHeight: 720}, reason: ""}));
      await pending;
      await staged.rollbackShared();
    }};
  const factory = value => {
    const publication = createPublication(value), original = publication.rollback;
    publication.rollback = () => {
      const result = original();
      // An independent renderer command arrives after shared byte restoration.
      Source.stage({multiplier: 3}, {binding});
      return result;
    };
    return publication;
  };
  await assert.rejects(Update.apply({}, options, async staged => {
    await f.prepare(staged);staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};
  }, factory), /render source changed before it could be restored/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  assert.equal(JSON.parse(fs.readFileSync(binding.file, "utf8")).source.multiplier, 3);
});
test("stop and relaunch during preparation never edits the replacement session", async t => {
  const f = fixture(t), options = {...f.options, withGraphicsUpdate: () => assert.fail("stale native update")};
  await Update.apply({}, options, async staged => {await f.prepare(staged);f.replace();}, createPublication);
  assert.equal(fs.readFileSync(f.file, "utf8"), "new session");
});
test("an already cancelled update does not begin preparation", async t => {
  const f = fixture(t), controller = new AbortController();controller.abort();
  await assert.rejects(Update.apply({}, {...f.options, signal: controller.signal},
    () => assert.fail("cancelled preparation started"), createPublication), error => error.name === "AbortError");
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("cancellation during preparation discards the candidate before renderer changes", async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(Update.apply({}, {...f.options, signal: controller.signal,
    withGraphicsUpdate: () => assert.fail("cancelled renderer change started")}, async staged => {
    const prepared = await f.prepare(staged);controller.abort();return prepared;
  }, createPublication), error => error.name === "AbortError");
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("cancellation during renderer validation prevents shared activation", async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(Update.apply({}, {...f.options, signal: controller.signal,
    withGraphicsUpdate: async (_entry, _staged, publish) => {controller.abort();return publish();}},
  f.prepare, createPublication), error => error.name === "AbortError");
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("full Reset supersession is deferred only after successful restoration", async t => {
  const f = fixture(t), controller = new AbortController();
  const reason = Object.assign(new Error("The graphics update was replaced by a reset."),
    {name: "AbortError", code: "GRAPHICS_RESET_SUPERSEDED"});
  const result = await Update.apply({}, {...f.options, signal: controller.signal}, async staged => {
    await f.prepare(staged);controller.abort(reason);controller.signal.throwIfAborted();
  }, createPublication);
  assert.equal(result.deferred, true);assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("Reset cancellation never hides failed restoration or an unrelated preparation error", async t => {
  for (const failedRestore of [false, true]) {
    const f = fixture(t), controller = new AbortController();
    const reason = Object.assign(new Error("The graphics update was replaced by a reset."),
      {name: "AbortError", code: "GRAPHICS_RESET_SUPERSEDED"});
    const factory = options => {
      const publication = createPublication(options);
      if (failedRestore) publication.rollback = () => {throw Error("restore refused");};
      return publication;
    };
    await assert.rejects(Update.apply({}, {...f.options, signal: controller.signal}, async staged => {
      await f.prepare(staged);controller.abort(reason);
      if (failedRestore) controller.signal.throwIfAborted();
      throw Error("compiler rejected shader");
    }, factory), error => failedRestore
      ? error instanceof AggregateError && error.errors[1].message === "restore refused"
      : error.message === "compiler rejected shader");
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  }
  const f = fixture(t), controller = new AbortController(), reason = Object.assign(new Error("Reset"),
    {name: "AbortError", code: "GRAPHICS_RESET_SUPERSEDED"});
  const nativeError = new AggregateError([reason, Error("native restoration refused")], "Native compensation failed");
  await assert.rejects(Update.apply({}, {...f.options, signal: controller.signal,
    withGraphicsUpdate: async (_entry, _staged, publish) => {await publish();controller.abort(reason);throw nativeError;}},
  f.prepare, createPublication), error => error === nativeError);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("native deferral retains the accepted chain and desired preparation result", async t => {
  const f = fixture(t), options = {...f.options, withGraphicsUpdate: async () => ({deferred: true})};
  assert.deepEqual(await Update.apply({}, options, f.prepare, createPublication), {plan: "candidate"});
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("a deferred shared stage never reaches native renderer controls", async t => {
  const f = fixture(t), options = {...f.options, withGraphicsUpdate: () => assert.fail("deferred native update")};
  await Update.apply({}, options, async staged => {await f.prepare(staged);staged.publication.defer();}, createPublication);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("the actual shader setter routes native hooks once while saving the original selection", async t => {
  const f = fixture(t), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf("async function saveGameReShade("), end = source.indexOf('ipcMain.handle("launcher:setGameReShade"', begin);
  const entry = {gameId: "video", gamePath: "/clip.mp4", reshade: {enabled: false, preset: "custom", effectPath: "/hook.glsl"}};let native = 0, shared = 0, saved = 0;
  const context = {
    AbortController,
    loadSettings: () => ({}), loadGamesHydrated: () => [entry], findGameByPath: () => entry,
    EffectsPlan: {normalize: () => null}, cachedState: null,
    buildState: () => ({}), broadcastState() {},
    saveGameRecord(value) {saved++;assert.equal(value.reshade.enabled, true);},
    ReShade: {createPublication, normalizeSettings: require("../src/modules/shared/reshade").normalizeSettings, updateSettings: (_previous, patch) => patch,
      async updateLive(value, options) {
        shared++;assert.equal(value.reshade.enabled, false, "native hook excluded from shared RGB processing");
        options.publication.write(f.file, "prepared shared chain", {root: f.root, activation: true});
      }},
    async gameEffectsOptions() {return {...f.options,
      prepareEffectsEntry: async value => ({...value, reshade: {...value.reshade, enabled: false}}),
      withGraphicsUpdate: async (value, _options, publish) => {
        native++;assert.equal(value.reshade.enabled, true, "native renderer receives the actual selection");await publish();
      }};},
    require: id => require(path.resolve(__dirname, "../src/main", id))
  };
  vm.runInNewContext(source.slice(begin, end), context);
  await context.saveGameReShade(entry.gamePath, {enabled: true, preset: "custom", effectPath: "/hook.glsl"}, {preset: "custom", effectPath: "/hook.glsl"});
  assert.deepEqual({native, shared, saved}, {native: 1, shared: 1, saved: 1});
  assert.equal(fs.readFileSync(f.file, "utf8"), "prepared shared chain");
});
test("queued shader parameter edits cannot cross a newer shader selection", async () => {
  const vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf("async function saveGameReShade("),
    end = source.indexOf('ipcMain.handle("launcher:getGameShaderParameters"', begin);
  const queueBegin = source.indexOf("const graphicsEdits = new Map();"), queueEnd = source.indexOf("function gameGraphicsLive(", queueBegin);
  const entry = {gamePath: "/Game", reshade: {enabled: true, preset: "crt", parameters: {Old: [1]}}};
  const ReShade = require("../src/modules/shared/reshade"), handlers = {};let saves = 0, preparations = 0;
  const context = {
    AbortController,
    loadSettings: () => ({}), loadGamesHydrated: () => [entry], findGameByPath: () => entry,
    EffectsPlan: {normalize: () => null}, cachedState: null, buildState: () => ({}), broadcastState() {},
    saveGameRecord() {saves++;}, async gameEffectsOptions() {preparations++;throw Error("Stale edit reached preparation");},
    ReShade, ipcMain: {handle(name, fn) {handlers[name] = fn;}},
    require: id => require(path.resolve(__dirname, "../src/main", id))
  };
  vm.runInNewContext(source.slice(queueBegin, queueEnd) + source.slice(begin, end), context);
  let release;
  const earlier = context.editGraphics(entry.gamePath, async () => {
    await new Promise(resolve => {release = resolve;});
    entry.reshade = {enabled: true, preset: "grayscale", parameters: {New: [2]}};
  });
  await new Promise(resolve => setImmediate(resolve));
  const pending = handlers["launcher:setGameReShade"]({}, entry.gamePath, {parameters: {Old: [4]}}, {preset: "crt"});
  release();await earlier;
  await assert.rejects(pending, error => error.code === "GRAPHICS_SHADER_STALE");
  assert.deepEqual(entry.reshade, {enabled: true, preset: "grayscale", parameters: {New: [2]}});
  assert.equal(saves, 0);assert.equal(preparations, 0);
});
test("shader parameter identity includes custom source and chain order", async () => {
  const vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const begin = source.indexOf("async function saveGameReShade("), end = source.indexOf('ipcMain.handle("launcher:setGameReShade"', begin);
  for (const [current, expected] of [
    [{preset: "custom", effectPath: "/new.fx"}, {preset: "custom", effectPath: "/old.fx"}],
    [{preset: "chain", effects: ["crt", "cas"]}, {preset: "chain", effects: ["cas", "crt"]}]
  ]) {
    const entry = {gamePath: "/Game", reshade: current};
    const context = {loadSettings: () => ({}), loadGamesHydrated: () => [entry], findGameByPath: () => entry,
      EffectsPlan: {normalize: () => null}, ReShade: require("../src/modules/shared/reshade"),
      async gameEffectsOptions() {assert.fail("Stale parameters reached graphics preparation");},
      require: id => require(path.resolve(__dirname, "../src/main", id))};
    vm.runInNewContext(source.slice(begin, end), context);
    await assert.rejects(context.saveGameReShade(entry.gamePath, {parameters: {Old: [4]}}, expected),
      error => error.code === "GRAPHICS_SHADER_STALE");
    assert.equal(entry.reshade, current);
  }
});

function mainGraphicsFixture(t, hooks = {}) {
  const f = fixture(t), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const entry = {gameId: "main-graphics", gamePath: "/Game", reshade: {enabled: false, preset: "crt"}, graphics: {}};
  const session = {id: 1, pid: 12345}, runningGameSessions = new Map([[entry.gamePath, new Map([[session.id, session]])]]);
  const handlers = {}, events = [], saves = [], realReShade = require("../src/modules/shared/reshade");
  const write = (options, value) => options.publication.write(f.file, value, {root: f.root, activation: true});
  const context = {
    AbortController, runningGameSessions, gameRecordsCache: [entry],
    loadSettings: () => ({}), loadGamesHydrated: () => [entry], findGameByPath: () => entry,
    EffectsPlan: {normalize: value => value || null, validate: value => value},
    GraphicsSettings: require("../src/modules/shared/reshade/graphics-settings"),
    userDataDir: f.root, cachedState: null, buildState: () => ({}), broadcastState() {},
    saveGameRecord(value) {saves.push(JSON.parse(JSON.stringify(value)));},
    ipcMain: {handle(name, fn) {handlers[name] = fn;}},
    backendService: {cancelLaunch: async () => false},
    stopProcessTree: async () => true,
    async refreshRuntimeSnapshots() {},
    async gameEffectsOptions() {return {running: true, isCurrent: () => session.stopRequested !== true};},
    gameGraphicsLive: () => true,
    ReShade: {
      normalizeSettings: realReShade.normalizeSettings, updateSettings: realReShade.updateSettings,
      createPublication(options) {
        const publication = createPublication(options), rollback = publication.rollback;
        publication.rollback = () => {events.push("rollback");return rollback();};return publication;
      },
      updateLive: hooks.shader || (async (value, options) => write(options, JSON.stringify(value.reshade))),
      validateLiveGraphics: async () => true,
      updateAutomaticEffects: hooks.graphics || (async (value, options) => write(options, JSON.stringify(value.graphics)))
    },
    EffectsRuntime: {
      prepare: hooks.effects || (async (value, options) => {write(options, "advanced");return {plan: value.effects};}),
      publishSimple(_value, _directory, options) {events.push("reset");write(options, "simple/off");}
    },
    require(id) {
      if (id === "../modules/shared/reshade/live-controls") return {write() {}};
      if (id === "../modules/shared/reshade/launch-binding") return {isCurrent: () => session.stopRequested !== true};
      if (id === "../modules/shared/reshade/simple-setup" && hooks.setup) return {ensureGraphicsModel: hooks.setup};
      return require(path.resolve(__dirname, "../src/main", id));
    }
  };
  const queueBegin = source.indexOf("const graphicsEdits = new Map();"), queueEnd = source.indexOf("function gameGraphicsLive(", queueBegin);
  const settersBegin = source.indexOf('ipcMain.handle("launcher:setGameEffects"'), settersEnd = source.indexOf("function publishReShadeFilters(", settersBegin);
  const stopBegin = source.indexOf("async function stopRunSession("), stopEnd = source.indexOf("function buildRuntimeManagerState(", stopBegin);
  vm.runInNewContext(source.slice(queueBegin, queueEnd) + source.slice(settersBegin, settersEnd) + source.slice(stopBegin, stopEnd), context);
  return {...f, context, entry, session, handlers, events, saves};
}
test("the main full Reset aborts shader preparation and waits for retirement before all-Off publication", async t => {
  let options, finish;
  const retired = new Promise(resolve => {finish = resolve;});
  const f = mainGraphicsFixture(t, {shader: async (_entry, staged) => {
    options = staged;
    staged.publication.write(f.file, "unaccepted shader", {root: f.root, activation: true});
    await new Promise(resolve => staged.signal?.addEventListener("abort", resolve, {once: true}));
    f.events.push("aborted");await retired;staged.signal.throwIfAborted();
  }});
  const shader = f.handlers["launcher:setGameReShade"]({}, f.entry.gamePath, {enabled: true});
  await new Promise(resolve => setImmediate(resolve));
  const reset = f.handlers["launcher:resetGameEffects"]({}, f.entry.gamePath);
  assert.equal(options.signal?.aborted, true, "Reset interrupts the actual setter preparation");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.includes("reset"), false);assert.equal(f.saves.length, 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  finish();await Promise.all([shader, reset]);
  assert.ok(f.events.indexOf("rollback") < f.events.indexOf("reset"));
  assert.equal(f.entry.reshade.enabled, false);assert.equal(f.entry.graphics.neuralMethod, "off");
  assert.equal(f.entry.effects, null);assert.equal(fs.readFileSync(f.file, "utf8"), "simple/off");
});
test("the actual Stop path aborts preparation after stop intent without publishing to the old session", async t => {
  let options;
  const f = mainGraphicsFixture(t, {effects: async (_entry, staged) => {
    options = staged;
    staged.publication.write(f.file, "unaccepted chain", {root: f.root, activation: true});
    await new Promise(resolve => staged.signal?.addEventListener("abort", resolve, {once: true}));
    assert.equal(f.session.stopRequested, true);staged.signal.throwIfAborted();
  }});
  const plan = {schema: 1, mode: "advanced", video: []};
  const pending = f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, plan);
  await new Promise(resolve => setImmediate(resolve));
  f.session.stopProcess = async () => {assert.equal(options.signal?.aborted, true);return true;};
  assert.equal(await f.context.stopGameRuns(f.entry.gamePath), true);await pending;
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");assert.equal(f.saves.length, 1);
  assert.equal(f.entry.effects, plan, "requested settings remain saved without old-session activation");
});
test("the main graphics queue preserves independent partial patches in FIFO order", async t => {
  let finish;const gate = new Promise(resolve => {finish = resolve;}), signals = [];
  const f = mainGraphicsFixture(t, {graphics: async (value, options) => {
    signals.push(options.signal);
    if (signals.length === 1) await gate;
    options.publication.write(f.file, JSON.stringify(value.graphics), {root: f.root, activation: true});
  }});
  const first = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "mlx-dlss"});
  await new Promise(resolve => setImmediate(resolve));
  const second = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {frameGeneration: "lsfg"});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 1);assert.equal(signals[0]?.aborted, false);finish();
  await Promise.all([first, second]);
  assert.equal(signals.length, 2);assert.ok(signals.every(signal => signal?.aborted === false));
  assert.equal(f.entry.graphics.neuralMethod, "mlx-dlss");assert.equal(f.entry.graphics.frameGeneration, "lsfg");
  assert.equal(f.saves.length, 2);
});
test("the main model setup receives the queue signal and a superseding Reset does not enable its model", async t => {
  let signal;
  const f = mainGraphicsFixture(t, {setup: async options => {
    signal = options.signal;
    await new Promise(resolve => signal?.addEventListener("abort", resolve, {once: true}));return null;
  }});
  const setup = f.handlers["launcher:ensureGameGraphicsModel"]({}, f.entry.gamePath, "neural", {});
  await new Promise(resolve => setImmediate(resolve));
  const reset = f.handlers["launcher:resetGameEffects"]({}, f.entry.gamePath);
  assert.equal(signal?.aborted, true);assert.equal(await setup, null);await reset;
  assert.equal(f.entry.graphics.neuralMethod, "off");assert.equal(f.entry.reshade.enabled, false);
});

function sourceFixture(t, f, control = "engine", source = null) {
  const Source = require("../src/modules/shared/reshade/source-controls");
  const prepared = Source.prepare({gameId: "recovery-source"}, {userDataDir: f.root, launchId: "recovery-launch", source,
    support: {control, live: true, heights: true, multipliers: [1, 2, 3]}});
  const read = () => JSON.parse(fs.readFileSync(prepared.binding.file, "utf8"));
  const acknowledge = (command, reason = "") => fs.writeFileSync(prepared.binding.statusFile, JSON.stringify({...command,
    requested: command.source, applied: command.source === null ? null : {scale: 1 / command.source.multiplier, viewportWidth: 1920, viewportHeight: 1080}, reason}));
  return {Source, ...prepared, read, acknowledge};
}
test("virtual neural source changes get the initialization budget without slowing ordinary engine acknowledgements", async t => {
  const Source = require("../src/modules/shared/reshade/source-controls"), originalStage = Source.stage;
  let stagedOptions;
  t.mock.method(Source, "stage", (candidate, options) => {
    stagedOptions = options;const transaction = originalStage(candidate, options);
    return {...transaction, async wait() {
      const command = JSON.parse(fs.readFileSync(options.binding.file, "utf8"));
      fs.writeFileSync(options.binding.statusFile, JSON.stringify({...command, requested: command.source, reason: "",
        ...(options.binding.control === "virtual" ? {sessionReady: true, observed: {width: 640, height: 360},
          applied: {width: 640, height: 360, outputWidth: 1280, outputHeight: 720, virtual: true}}
          : {applied: {scale: .5, viewportWidth: 1280, viewportHeight: 720}})}));
      return transaction.wait();
    }};
  });
  const neural = enabled => ({document: {nodes: [{kind: "neural", enabled}]}});
  for (const value of [
    {control: "virtual", entry: {}, prepared: neural(true), timeout: 30000},
    {control: "virtual", entry: {graphics: {neuralMethod: "mlx-dlss"}}, prepared: {}, timeout: 30000},
    {control: "virtual", entry: {graphics: {neuralMethod: "mlx-dlss"}}, prepared: neural(false)},
    {control: "virtual", entry: {}, prepared: {document: {nodes: [{kind: "spatial", enabled: true}]}}},
    {control: "engine", entry: {graphics: {neuralMethod: "mlx-dlss"}}, prepared: neural(true)}
  ]) {
    const f = fixture(t), {binding} = Source.prepare({gameId: "budget"}, {userDataDir: f.root, launchId: "budget",
      support: {control: value.control, live: true, heights: true, multipliers: [1, 2],
        ...(value.control === "virtual" ? {activationAPI: 1} : {})}});
    await Update.apply(value.entry, {...f.options, launchBinding: {sourceControl: binding}}, async options => {
      await f.prepare(options);options.publication.metadata.sourceResolutionCandidate = {multiplier: 2};return value.prepared;
    }, createPublication);
    assert.equal(stagedOptions.timeoutMs, value.timeout, JSON.stringify(value));
    assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
  }
});
test("a real source-admission failure rolls back before one processing-only preparation", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "virtual", {multiplier: 2});
  const original = fs.readFileSync(source.binding.file);let preparations = 0;
  const prepared = await Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
    preparations++;
    if (preparations === 1) {
      assert.equal(staged.sourceResolutionFailures, undefined);
      staged.publication.metadata.sourceResolutionCandidate = {multiplier: 3};
      await f.prepare(staged);return {plan: "candidate"};
    }
    assert.equal(preparations, 2);assert.match(staged.sourceResolutionFailures.virtual, /virtual render source has not completed/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted", "accepted publication restored before retry preparation");
    assert.deepEqual(fs.readFileSync(source.binding.file), original, "failed admission never touched native controls");
    staged.publication.metadata.sourceResolutionCandidate = null; // Must not restore/change native source on retry.
    staged.publication.write(f.file, "processing fallback", {root: f.root, activation: true});
    return {plan: "processing fallback"};
  }, createPublication);
  assert.deepEqual(prepared, {plan: "processing fallback"});assert.equal(preparations, 2);
  assert.equal(fs.readFileSync(f.file, "utf8"), "processing fallback");assert.deepEqual(fs.readFileSync(source.binding.file), original);
});
test("actual rejected ACK restores before processing retry even when logging throws, without a source-null command", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "engine", {multiplier: 3});let preparations = 0, seen = 0;
  const commands = [], reason = "No active 3D camera.\n" + "x".repeat(1024);
  source.acknowledge(source.read());
  const timer = setInterval(() => {
    const command = source.read();if (command.epoch === seen) return;seen = command.epoch;commands.push(command);
    source.acknowledge(command, command.source?.multiplier === 2 ? reason : "");
  }, 2);t.after(() => clearInterval(timer));
  let warnings = 0, warningMessage;
  const options = {...f.options, launchBinding: {sourceControl: source.binding},
    logger: {warn(message) {warnings++;warningMessage=message;throw Error("warning sink unavailable");}},
    withGraphicsUpdate: async (_entry, _staged, publish) => publish()};
  const result = await Update.apply({}, options, async staged => {
    preparations++;
    if (preparations === 1) {
      staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};await f.prepare(staged);return {plan: "candidate"};
    }
    assert.equal(preparations, 2);assert.equal(staged.sourceResolutionFailures.engine.length, 512);
    assert.doesNotMatch(staged.sourceResolutionFailures.engine, /[\x00-\x1f\x7f]/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
    assert.equal(source.read().source.multiplier, 3);assert.equal(source.read().epoch, 3);
    assert.equal(source.Source.completed(source.binding).command.epoch, 3, "native restoration is acknowledged before retry");
    staged.publication.metadata.sourceResolutionCandidate = null;
    staged.publication.write(f.file, "processing fallback", {root: f.root, activation: true});return {plan: "fallback"};
  }, createPublication);
  assert.deepEqual(result, {plan: "fallback"});assert.equal(preparations, 2);
  assert.equal(warnings, 1);
  assert.match(warningMessage, /Source allocation failed/);
  assert.equal(source.read().source.multiplier, 3);assert.equal(source.read().epoch, 3);
  assert.equal(commands.some(command => command.source === null), false);
});
test("a rejected adaptive source rolls back before one adaptive processing fallback", async t => {
  const f = fixture(t), Source = require("../src/modules/shared/reshade/source-controls");
  const {binding} = Source.prepare({gameId: "adaptive-recovery"}, {userDataDir: f.root, launchId: "adaptive-recovery",
    support: {control: "virtual", live: true, activationAPI: 1, automatic: true, heights: true, multipliers: [1, 2, 3]}});
  const read = () => JSON.parse(fs.readFileSync(binding.file, "utf8")), commands = [];
  let preparations = 0, seen = 1;
  const timer = setInterval(() => {
    const command = read();if (command.epoch === seen) return;seen = command.epoch;commands.push(command);
    fs.writeFileSync(binding.statusFile, JSON.stringify({...command, requested: command.source, applied: null,
      reason: command.source?.automatic ? "Source allocation is unavailable in the current window state." : ""}));
  }, 2);t.after(() => clearInterval(timer));
  const result = await Update.apply({}, {...f.options, launchBinding: {sourceControl: binding}}, async staged => {
    preparations++;
    if (preparations === 1) {
      staged.publication.metadata.sourceResolutionCandidate = {automatic: true};
      await f.prepare(staged);return {preparationStatus: {sourceResolution: {requested: {automatic: true}}}};
    }
    assert.equal(preparations, 2);assert.match(staged.sourceResolutionFailures.virtual, /current window state/);
    assert.equal(read().source, null);assert.equal(read().epoch, 3);
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
    staged.publication.metadata.sourceResolutionCandidate = null;
    staged.publication.write(f.file, "adaptive processing", {root: f.root, activation: true});return {plan: "adaptive processing"};
  }, createPublication);
  assert.deepEqual(result, {plan: "adaptive processing"});assert.equal(preparations, 2);
  assert.deepEqual(commands.map(command => command.source), [{automatic: true}, null]);
  assert.equal(read().epoch, 3, "processing retry does not send another native source command");
});
test("successful actual source acknowledgement keeps a single preparation", async t => {
  const f = fixture(t), source = sourceFixture(t, f);let preparations = 0;
  await Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding},
    withGraphicsUpdate: async (_entry, _staged, publish) => {const pending = publish();source.acknowledge(source.read());return pending;}}, async staged => {
    preparations++;staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};return f.prepare(staged);
  }, createPublication);
  assert.equal(preparations, 1);assert.equal(source.read().source.multiplier, 2);assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
});
test("a rejected unchanged native source rolls back the graph before one processing retry", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "engine", {multiplier: 2});
  const original = fs.readFileSync(source.binding.file);let preparations = 0;
  source.acknowledge(source.read(), "The publisher retained a different extent.");
  const result = await Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
    preparations++;
    if (preparations === 1) {
      staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};await f.prepare(staged);return {plan: "candidate"};
    }
    assert.equal(preparations, 2);assert.match(staged.sourceResolutionFailures.engine, /different extent/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted", "failed candidate was restored before retry");
    assert.deepEqual(fs.readFileSync(source.binding.file), original, "the existing native command is retained");
    staged.publication.metadata.sourceResolutionCandidate = null;
    staged.publication.write(f.file, "processing fallback", {root: f.root, activation: true});return {plan: "fallback"};
  }, createPublication);
  assert.deepEqual(result, {plan: "fallback"});assert.equal(preparations, 2);
  assert.equal(fs.readFileSync(f.file, "utf8"), "processing fallback");assert.deepEqual(fs.readFileSync(source.binding.file), original);
});
test("an accepted unchanged source permits an independent edit with one preparation and no new epoch", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "engine", {multiplier: 2});let preparations = 0;
  source.acknowledge(source.read());const original = fs.readFileSync(source.binding.file);
  await Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
    preparations++;staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};return f.prepare(staged);
  }, createPublication);
  assert.equal(preparations, 1);assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
  assert.deepEqual(fs.readFileSync(source.binding.file), original);
});
test("source cancellation restores state without preparing a fallback", async t => {
  const f = fixture(t), source = sourceFixture(t, f), controller = new AbortController();let preparations = 0;
  const timer = setInterval(() => {const command = source.read();if (command.epoch > 2) source.acknowledge(command);}, 2);
  t.after(() => clearInterval(timer));
  await assert.rejects(Update.apply({}, {...f.options, signal: controller.signal, launchBinding: {sourceControl: source.binding},
    withGraphicsUpdate: async (_entry, _staged, publish) => {const pending = publish();controller.abort();return pending;}}, async staged => {
    preparations++;staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};return f.prepare(staged);
  }, createPublication), error => error.name === "AbortError");
  assert.equal(preparations, 1);assert.equal(source.read().source, null);assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("source error codes from compilation or native renderer validation never trigger recovery", async t => {
  for (const phase of ["prepare", "renderer"]) {
    const f = fixture(t);let preparations = 0;
    const error = Object.assign(new Error("Shader compilation rejected"), {code: "GRAPHICS_SOURCE_REJECTED"});
    await assert.rejects(Update.apply({}, {...f.options, withGraphicsUpdate: async () => {throw error;}}, async staged => {
      preparations++;if (phase === "prepare") throw error;return f.prepare(staged);
    }, createPublication), value => value === error);
    assert.equal(preparations, 1);assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  }
});
test("failed restoration prevents source fallback and preserves both errors", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "virtual", {multiplier: 2});let preparations = 0;
  const factory = options => {const publication = createPublication(options);publication.rollback = () => {throw Error("restore refused");};return publication;};
  await assert.rejects(Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
    preparations++;staged.publication.metadata.sourceResolutionCandidate = {multiplier: 3};return f.prepare(staged);
  }, factory), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[1].message === "restore refused");
  assert.equal(preparations, 1);
});
test("a fallback compilation failure is reported after one retry", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "virtual", {multiplier: 2});let preparations = 0;
  await assert.rejects(Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
    preparations++;if (preparations === 2) throw Error("fallback compilation rejected");
    staged.publication.metadata.sourceResolutionCandidate = {multiplier: 3};return f.prepare(staged);
  }, createPublication), /fallback compilation rejected/);
  assert.equal(preparations, 2);assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
});
test("Original or all-off restoration failure is reported instead of saving a processing fallback", async t => {
  for (const requested of [null, {multiplier: 1}]) {
    const f = fixture(t), source = sourceFixture(t, f, "engine", {multiplier: 3});let preparations = 0, seen = 0;
    source.acknowledge(source.read());
    const timer = setInterval(() => {
      const command = source.read();if (command.epoch === seen) return;seen = command.epoch;
      source.acknowledge(command, command.source === null ? "Exit fullscreen before restoring the original game window." : "");
    }, 2);t.after(() => clearInterval(timer));
    await assert.rejects(Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
      preparations++;staged.publication.metadata.sourceResolutionCandidate = null;await f.prepare(staged);
      return {preparationStatus: {sourceResolution: {requested}}};
    }, createPublication), error => error.code === "GRAPHICS_SOURCE_REJECTED" && /Exit fullscreen/.test(error.message));
    assert.equal(preparations, 1);assert.equal(source.read().source.multiplier, 3);
    assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  }
});
test("a retired launch during the source wait never retries or restores replacement files", async t => {
  const f = fixture(t), source = sourceFixture(t, f);let preparations = 0;
  await Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding},
    withGraphicsUpdate: async (_entry, _staged, publish) => {
      const pending = publish();f.replace();fs.writeFileSync(source.binding.file, "replacement source");return pending;
    }}, async staged => {
    preparations++;staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};return f.prepare(staged);
  }, createPublication);
  assert.equal(preparations, 1);assert.equal(fs.readFileSync(f.file, "utf8"), "new session");
  assert.equal(fs.readFileSync(source.binding.file, "utf8"), "replacement source");
});

test("neural Off interrupts setup without dropping independent queued frame generation or shader choices", async t => {
  let setupSignal, finished;
  const started = new Promise(resolve => {finished = resolve;});
  const f = mainGraphicsFixture(t, {setup: async options => {
    setupSignal = options.signal;finished();
    await new Promise(resolve => setupSignal.addEventListener("abort", resolve, {once: true}));return null;
  }});
  const setup = f.handlers["launcher:ensureGameGraphicsModel"]({}, f.entry.gamePath, "neural", {});
  await started;
  const frames = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {frameGeneration: "lsfg"});
  const shader = f.handlers["launcher:setGameReShade"]({}, f.entry.gamePath, {enabled: true, preset: "grayscale"});
  const off = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "off"});
  assert.equal(setupSignal.aborted, true);
  assert.equal(await setup, null);await Promise.all([frames, shader, off]);
  assert.equal(f.entry.graphics.neuralMethod, "off");assert.equal(f.entry.graphics.frameGeneration, "lsfg");
  assert.equal(f.entry.reshade.enabled, true);assert.equal(f.entry.reshade.preset, "grayscale");
  assert.ok(f.saves.every(row => row.graphics.neuralMethod === "off"), "no superseded On setting is persisted");
});
test("Off rolls back an active mixed neural candidate then applies its independent patch without neural", async t => {
  let entered;const started = new Promise(resolve => {entered = resolve;}), calls = [];
  const f = mainGraphicsFixture(t, {graphics: async (entry, options) => {
    calls.push(entry.graphics);
    options.publication.write(f.file, JSON.stringify(entry.graphics), {root: f.root, activation: true});
    if (entry.graphics.neuralMethod === "mlx-dlss") {
      entered();await new Promise(resolve => options.signal.addEventListener("abort", resolve, {once: true}));
      options.signal.throwIfAborted();
    }
  }});
  const on = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "mlx-dlss", frameGeneration: "lsfg", frameMultiplier: 4});
  await started;assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  const off = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "off"});
  await Promise.all([on, off]);
  assert.equal(calls.length, 3);assert.equal(calls[0].neuralMethod, "mlx-dlss");
  assert.ok(calls.slice(1).every(row => row.neuralMethod === "off"));
  assert.equal(f.entry.graphics.frameGeneration, "lsfg");assert.equal(f.entry.graphics.frameMultiplier, 4);
  assert.equal(f.entry.graphics.neuralMethod, "off");
  assert.ok(f.events.includes("rollback"));
  assert.ok(f.saves.every(row => row.graphics.neuralMethod === "off"));
});
test("Off supersession never hides a real candidate failure or retries it as cancellation", async t => {
  let entered;const started = new Promise(resolve => {entered = resolve;});let calls = 0;
  const f = mainGraphicsFixture(t, {graphics: async (entry, options) => {
    calls++;
    if (entry.graphics.neuralMethod === "mlx-dlss") {
      entered();await new Promise(resolve => options.signal.addEventListener("abort", resolve, {once: true}));
      throw new Error("Candidate resource restoration failed");
    }
  }});
  const on = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "mlx-dlss", frameGeneration: "lsfg"});
  const failed = assert.rejects(on, /resource restoration failed/);await started;
  const off = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "off"});
  await failed;await off;
  assert.equal(calls, 2);assert.equal(f.entry.graphics.neuralMethod, "off");
});

test("Off can interrupt a shader candidate using the active neural model while preserving its exact shader choice", async t => {
  let entered;const started = new Promise(resolve => {entered = resolve;}), calls = [];
  const f = mainGraphicsFixture(t, {shader: async (entry, options) => {
    calls.push(entry);
    if (entry.graphics.neuralMethod === "mlx-dlss") {
      entered();await new Promise(resolve => options.signal.addEventListener("abort", resolve, {once: true}));
      options.signal.throwIfAborted();
    }
    options.publication.write(f.file, JSON.stringify(entry.reshade), {root: f.root, activation: true});
  }});
  f.entry.graphics = {neuralMethod: "mlx-dlss"};
  const shader = f.handlers["launcher:setGameReShade"]({}, f.entry.gamePath, {enabled: true, preset: "grayscale"});
  await started;const off = f.handlers["launcher:setGameGraphics"]({}, f.entry.gamePath, {neuralMethod: "off"});
  await Promise.all([shader, off]);
  assert.equal(calls.length, 2);assert.equal(calls[1].graphics.neuralMethod, "off");
  assert.equal(f.entry.graphics.neuralMethod, "off");assert.equal(f.entry.reshade.preset, "grayscale");
  assert.equal(f.entry.reshade.enabled, true);
});
