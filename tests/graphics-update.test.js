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
// An Off graph is acknowledged as pass-through only while the lease is held.
for (const enabled of [true, false]) test(`a live ${enabled ? 'processed' : 'Off'} publication primes status before exposing it`, async t => {
  const f = fixture(t), Status = require('../src/modules/shared/reshade/runtime-status'), order = [], binding = {launchId: 'bound'};
  t.mock.method(Status, 'prime', (value, options) => {assert.equal(value, binding);assert.equal(options.userDataDir, f.root);order.push('prime');return true;});
  const entry = {effects: {schema: 2, mode: 'advanced', enabled, video: [
    {id: 'gray', kind: 'shader', enabled: true, shader: {enabled: true, preset: 'grayscale'}}
  ]}};
  await Update.apply(entry, {...f.options, userDataDir: f.root, launchBinding: {runtimeStatus: binding}}, f.prepare,
    options => {const publication = createPublication(options), commit = publication.commit;publication.commit = () => {order.push('commit');return commit.call(publication);};return publication;});
  assert.deepEqual(order, ['prime', 'commit']);
});
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
// The main effects section with the real status owner and queue. Plan
// preparation is a hook; acceptance reports the published revision.
function mainGraphicsFixture(t, hooks = {}) {
  const f = fixture(t), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8");
  const entry = {gameId: "main-graphics", gamePath: "/Game", effects: null};
  const session = {id: 1, pid: 12345}, runningGameSessions = new Map([[entry.gamePath, new Map([[session.id, session]])]]);
  const handlers = {}, events = [], saves = [], StoredPlan = require("../src/modules/shared/effects/stored-plan");
  const context = {
    AbortController, runningGameSessions, gameRecordsCache: [entry], logger: {warn() {}},
    BrowserWindow: {getAllWindows: () => []},
    loadSettings: () => ({}), loadGamesHydrated: () => [entry], findGameByPath: () => entry,
    StoredPlan, EffectsPlan: require("../src/modules/shared/effects/plan"),
    userDataDir: f.root, cachedState: null, buildState: () => ({}), broadcastState() {},
    saveGameRecord(value) {saves.push(JSON.parse(JSON.stringify(value)));},
    ipcMain: {handle(name, fn) {handlers[name] = fn;}},
    backendService: {cancelLaunch: async () => false,invalidateGraphicsPreparation:async()=>false},
    stopProcessTree: async () => true,
    async gameEffectsOptions() {return {running: true, isCurrent: () => session.stopRequested !== true, ...hooks.options};},
    gameGraphicsLive: () => true,
    ReShade: {
      createPublication(options) {
        const publication = createPublication(options), rollback = publication.rollback;
        publication.rollback = () => {events.push("rollback");return rollback();};return publication;
      }
    },
    EffectsRuntime: {
      prepare: hooks.effects || (async (value, options) => {options.publication.write(f.file, JSON.stringify(value.effects), {root: f.root, activation: true});return {plan: value.effects};}),
      publishSimple(_value, _directory, options) {events.push("reset");options.publication.write(f.file, "empty", {root: f.root, activation: true});},
      emptyDocument: () => ({schema: 1, mode: "advanced", revision: "empty-revision", nodes: []}),
      acceptance: async value => {
        const published = context.graphicsStatus.status(value.gamePath).published;
        return published ? {revision: published.documentRevision, launchId: "launch"} : null;
      }
    },
    require(id) {
      if (id === "../modules/shared/reshade/live-controls") return {write() {}};
      if (id === "../modules/shared/reshade/launch-binding") return {isCurrent: () => session.stopRequested !== true,
        read: () => session.stopRequested ? null : {effectPlanAPI: 1, pid: session.pid, launchId: "launch"}};
      return require(path.resolve(__dirname, "../src/main", id));
    }
  };
  const queueBegin = source.indexOf("const graphicsEdits = new Map();"), queueEnd = source.indexOf("function gameGraphicsLive(", queueBegin);
  const ownerBegin = source.indexOf('const GraphicsStatus = require("./graphics-status");'), ownerEnd = source.indexOf("function publishReShadeFilters(", ownerBegin);
  const stopBegin = source.indexOf("async function stopRunSession("), stopEnd = source.indexOf("function buildRuntimeManagerState(", stopBegin);
  vm.runInNewContext(source.slice(queueBegin, queueEnd) + source.slice(ownerBegin, ownerEnd) + source.slice(stopBegin, stopEnd) +
    "\nthis.graphicsStatus = graphicsStatus;this.settle = async () => { while (graphicsEdits.size) await Promise.allSettled([...graphicsEdits.values()]); };", context);
  // Acceptance is observed after the queued publication returns.
  const settled = async phase => {
    await context.settle();
    for (let index = 0; index < 100 && context.graphicsStatus.status(entry.gamePath).phase !== phase; index++) await new Promise(resolve => setTimeout(resolve, 10));
    return context.graphicsStatus.status(entry.gamePath);
  };
  t.after(() => context.graphicsStatus.dispose());
  return {...f, context, entry, session, handlers, events, saves, settled, StoredPlan};
}
const shaderPlan = preset => ({schema: 2, mode: "advanced", enabled: true, video: [{id: "shader", kind: "shader", enabled: true, shader: {enabled: true, preset}}]});
test("a live plan publication routes the module renderer transaction once, saves the plan and reports acceptance", async t => {
  let native = 0;
  const f = mainGraphicsFixture(t, {options: {withGraphicsUpdate: async (value, _options, publish) => {
    native++;assert.equal(value.effects.video[0].shader.preset, "grayscale", "the renderer receives the desired plan");await publish();
  }}});
  const result = await f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, shaderPlan("grayscale"));
  assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).phase, "preparing");assert.equal(result.desiredRevision, f.StoredPlan.revision(result.plan));
  const status = await f.settled("applied");
  assert.equal(native, 1);assert.equal(f.saves.length, 1);assert.deepEqual(f.saves[0].effects, JSON.parse(JSON.stringify(result.plan)));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), JSON.parse(JSON.stringify(result.plan)));
  assert.equal(status.phase, "applied");assert.equal(status.desiredRevision, result.desiredRevision);
  assert.equal(status.acknowledged.documentRevision, result.desiredRevision);assert.deepEqual(status.rows, {shader: {state: "active"}});
});
test("the main full Reset aborts plan preparation and waits for retirement before all-Off publication", async t => {
  let options, finish;
  const retired = new Promise(resolve => {finish = resolve;});
  const f = mainGraphicsFixture(t, {effects: async (_entry, staged) => {
    options = staged;
    staged.publication.write(f.file, "unaccepted shader", {root: f.root, activation: true});
    await new Promise(resolve => staged.signal?.addEventListener("abort", resolve, {once: true}));
    f.events.push("aborted");await retired;staged.signal.throwIfAborted();
  }});
  f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, shaderPlan("crt"));
  for (let index = 0; index < 20 && !options; index++) await new Promise(resolve => setImmediate(resolve));
  const reset = f.handlers["launcher:resetGameEffects"]({}, f.entry.gamePath);
  assert.equal(options.signal?.aborted, true, "Reset interrupts the plan preparation");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.includes("reset"), false);assert.equal(f.saves.length, 1, "only the desired plan was saved");
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  finish();await reset;
  assert.ok(f.events.indexOf("rollback") < f.events.indexOf("reset"));
  assert.equal(f.entry.effects, null);assert.equal(fs.readFileSync(f.file, "utf8"), "empty");
  // The empty document is applied once native code acknowledges its revision.
  const status = await f.settled("applied");
  assert.equal(status.published.documentRevision, "empty-revision");assert.equal(status.acknowledged.documentRevision, "empty-revision");
  assert.equal(status.desiredRevision, f.StoredPlan.read({effects: null}).revision);
});
test("the actual Stop path aborts preparation after stop intent without publishing to the old session", async t => {
  let options;
  const f = mainGraphicsFixture(t, {effects: async (_entry, staged) => {
    options = staged;
    staged.publication.write(f.file, "unaccepted chain", {root: f.root, activation: true});
    await new Promise(resolve => staged.signal?.addEventListener("abort", resolve, {once: true}));
    assert.equal(f.session.stopRequested, true);staged.signal.throwIfAborted();
  }});
  const plan = {schema: 2, mode: "advanced", enabled: true, video: []};
  f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, plan);
  for (let index = 0; index < 20 && !options; index++) await new Promise(resolve => setImmediate(resolve));
  f.session.stopProcess = async () => {assert.equal(options.signal?.aborted, true);return true;};
  assert.equal(await f.context.stopGameRuns(f.entry.gamePath), true);await f.context.settle();
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");assert.equal(f.saves.length, 1);
  assert.deepEqual(f.entry.effects, plan, "requested settings remain saved without old-session activation");
  assert.equal(f.context.graphicsStatus.status(f.entry.gamePath).published, undefined);
});
test("a newer desired plan rolls back the exposed candidate and only the newest plan is published", async t => {
  let entered;const started = new Promise(resolve => {entered = resolve;}), calls = [];
  const f = mainGraphicsFixture(t, {effects: async (value, options) => {
    calls.push(value.effects.video[0].shader.preset);
    options.publication.write(f.file, value.effects.video[0].shader.preset, {root: f.root, activation: true});
    if (calls.length === 1) {entered();await new Promise(resolve => options.signal.addEventListener("abort", resolve, {once: true}));options.signal.throwIfAborted();}
    return {plan: value.effects};
  }});
  f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, shaderPlan("crt"));
  await started;assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  const newer = await f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, shaderPlan("grayscale"));
  const status = await f.settled("applied");
  assert.deepEqual(calls, ["crt", "grayscale"]);assert.ok(f.events.includes("rollback"));
  assert.equal(fs.readFileSync(f.file, "utf8"), "grayscale");assert.equal(f.saves.length, 2);
  assert.equal(status.desiredRevision, newer.desiredRevision);assert.equal(status.published.documentRevision, newer.desiredRevision);
});
test("an unreadable saved plan rejects edits and keeps its bytes", async t => {
  const f = mainGraphicsFixture(t), damaged = {schema: 2, mode: "advanced", enabled: true, video: [{id: "a", kind: "shader", enabled: true, shader: {preset: "crt"}}], extra: true};
  f.entry.effects = structuredClone(damaged);
  await assert.rejects(async () => f.handlers["launcher:setGameEffects"]({}, f.entry.gamePath, shaderPlan("grayscale")), {code: "GRAPHICS_STORED_PLAN_INVALID"});
  assert.deepEqual(f.entry.effects, damaged);assert.equal(f.saves.length, 0);
  await f.handlers["launcher:resetGameEffects"]({}, f.entry.gamePath);
  assert.equal(f.entry.effects, null, "Clear effects is the accepted change");
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
function multipleSources(t, f, {initial = null, rejected = []} = {}) {
  const Source = require("../src/modules/shared/reshade/source-controls"), events = [], seen = new Map();
  const primary = Source.prepare({gameId: "shared-source"}, {userDataDir: f.root, launchId: "shared-source", source: initial,
    support: {control: "engine", live: true, heights: true, multipliers: [1, 2, 3]}}).binding;
  const virtual = Source.prepare({gameId: "shared-source"}, {userDataDir: f.root, launchId: "shared-source", channel: "virtual",
    support: {control: "virtual", live: true, activationAPI: 1, heights: true, multipliers: [1, 2, 3]}}).binding;
  const launch = {sourceControl: primary, sourceControls: {engine: primary, virtual}};
  const read = binding => JSON.parse(fs.readFileSync(binding.file, "utf8"));
  const acknowledge = binding => {
    const command = read(binding);if (seen.get(binding.control) === command.epoch) return;
    seen.set(binding.control, command.epoch);events.push({control: binding.control, source: command.source, graph: fs.readFileSync(f.file, "utf8"), engine: read(primary).source});
    const divisor = command.source?.multiplier || 1;
    fs.writeFileSync(binding.statusFile, JSON.stringify({...command, requested: command.source,
      applied: command.source === null ? null : binding.control === "virtual"
        ? {width: 1920 / divisor, height: 1080 / divisor, outputWidth: 1920, outputHeight: 1080, virtual: true}
        : {scale: 1 / divisor, viewportWidth: 1920, viewportHeight: 1080},
      ...(binding.control === "virtual" ? {observed: {width: 1920 / divisor, height: 1080 / divisor}, sessionReady: true} : {}),
      reason: command.source && rejected.includes(binding.control) ? "The source allocation is unavailable." : ""}));
  };
  acknowledge(primary);acknowledge(virtual);
  const timer = setInterval(() => {acknowledge(primary);acknowledge(virtual);}, 2);t.after(() => clearInterval(timer));
  return {Source, launch, events, read};
}
for (const rejected of [["engine"], ["engine", "virtual"]]) test(`live source recovery tries each owned channel once before processing (${rejected.join(", ")})`, async t => {
  const f = fixture(t), sources = multipleSources(t, f, {rejected}), strategies = [], Resolution = require("../src/modules/shared/reshade/source-resolution");
  const result = await Update.apply({}, {...f.options, launchBinding: sources.launch}, async staged => {
    const decision = Resolution.resolve({multiplier: 2}, {host: "window", inputs: {sourceResolution: sources.launch.sourceControl.support},
      virtualWindow: {activationAPI: 1}, processing: true, excludedControls: staged.sourceResolutionFailures});
    strategies.push(decision.strategy);await f.prepare(staged);
    staged.publication.metadata.sourceResolutionControl = decision.control;
    staged.publication.metadata.sourceResolutionCandidate = decision.source;
    return {strategy: decision.strategy, preparationStatus: {sourceResolution: {requested: {multiplier: 2}}}};
  }, createPublication);
  const expected = rejected.length === 1 ? ["engine", "virtual"] : ["engine", "virtual", "processing"];
  assert.deepEqual(strategies, expected);assert.equal(result.strategy, expected.at(-1));
  assert.deepEqual(sources.Source.active(sources.launch).map(binding => binding.control), rejected.length === 1 ? ["virtual"] : []);
  assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
  for (const control of rejected) assert.equal(sources.events.filter(event => event.control === control && event.source).length, 1);
});
test("switching source owners retires the old allocation before publication, and Off restores the new owner", async t => {
  const f = fixture(t), sources = multipleSources(t, f, {initial: {multiplier: 2}});
  await Update.apply({}, {...f.options, launchBinding: sources.launch}, async staged => {
    await f.prepare(staged);staged.publication.metadata.sourceResolutionControl = "virtual";
    staged.publication.metadata.sourceResolutionCandidate = {multiplier: 3};return {};
  }, createPublication);
  const retirement = sources.events.find(event => event.control === "engine" && event.source === null);
  assert.equal(retirement.graph, "accepted", "the old source is restored before the new graph is exposed");
  assert.equal(sources.events.find(event => event.control === "virtual" && event.source)?.engine, null, "two source owners never reduce together");
  assert.deepEqual(sources.Source.active(sources.launch).map(binding => binding.control), ["virtual"]);
  await Update.apply({}, {...f.options, launchBinding: sources.launch}, async staged => {
    staged.publication.write(f.file, "off", {root: f.root, activation: true});
    staged.publication.metadata.sourceResolutionControl = null;staged.publication.metadata.sourceResolutionCandidate = null;
  }, createPublication);
  assert.deepEqual(sources.Source.active(sources.launch), []);assert.equal(fs.readFileSync(f.file, "utf8"), "off");
});
test("a failed cross-channel publication restores the accepted graph and previous allocation", async t => {
  const f = fixture(t), sources = multipleSources(t, f, {initial: {multiplier: 2}}), failure = new Error("Renderer transaction failed");
  await assert.rejects(Update.apply({}, {...f.options, launchBinding: sources.launch,
    withGraphicsUpdate: async (_entry, _options, publish) => {await publish();throw failure;}}, async staged => {
    await f.prepare(staged);staged.publication.metadata.sourceResolutionControl = "virtual";
    staged.publication.metadata.sourceResolutionCandidate = {multiplier: 3};return {};
  }, createPublication), error => error === failure);
  assert.equal(fs.readFileSync(f.file, "utf8"), "accepted");
  assert.deepEqual(sources.read(sources.launch.sourceControl).source, {multiplier: 2});
  assert.equal(sources.read(sources.launch.sourceControls.virtual).source, null);
});
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
    {control: "virtual", entry: {}, prepared: {}},
    {control: "virtual", entry: {}, prepared: neural(false)},
    {control: "virtual", entry: {}, prepared: {document: {nodes: [{kind: "spatial", enabled: true}]}}},
    {control: "engine", entry: {}, prepared: neural(true)}
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
    assert.equal(fs.readFileSync(f.file, "utf8"), "candidate", "the exposed graph stays visible while the next path is prepared");
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
test("a rejected adaptive source restores its allocation before one adaptive processing fallback", async t => {
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
    assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");
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
test("a rejected unchanged native source keeps the exposed graph through one processing retry", async t => {
  const f = fixture(t), source = sourceFixture(t, f, "engine", {multiplier: 2});
  const original = fs.readFileSync(source.binding.file);let preparations = 0;
  source.acknowledge(source.read(), "The publisher retained a different extent.");
  const result = await Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
    preparations++;
    if (preparations === 1) {
      staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};await f.prepare(staged);return {plan: "candidate"};
    }
    assert.equal(preparations, 2);assert.match(staged.sourceResolutionFailures.engine, /different extent/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "candidate", "the exposed graph is not withdrawn before the retry");
    assert.deepEqual(fs.readFileSync(source.binding.file), original, "the existing native command is retained");
    staged.publication.metadata.sourceResolutionCandidate = null;
    staged.publication.write(f.file, "processing fallback", {root: f.root, activation: true});return {plan: "fallback"};
  }, createPublication);
  assert.deepEqual(result, {plan: "fallback"});assert.equal(preparations, 2);
  assert.equal(fs.readFileSync(f.file, "utf8"), "processing fallback");assert.deepEqual(fs.readFileSync(source.binding.file), original);
});
test("a failed or deferred next source path restores the graph its candidate kept visible", async t => {
  for (const outcome of ["failure", "deferral"]) {
    const f = fixture(t), source = sourceFixture(t, f, "engine", {multiplier: 3});let preparations = 0, seen = 0;
    source.acknowledge(source.read());
    const timer = setInterval(() => {
      const command = source.read();if (command.epoch === seen) return;seen = command.epoch;
      source.acknowledge(command, command.source?.multiplier === 2 ? "No active 3D camera." : "");
    }, 2);t.after(() => clearInterval(timer));
    const pending = Update.apply({}, {...f.options, launchBinding: {sourceControl: source.binding}}, async staged => {
      if (++preparations === 1) {staged.publication.metadata.sourceResolutionCandidate = {multiplier: 2};return f.prepare(staged);}
      assert.equal(fs.readFileSync(f.file, "utf8"), "candidate");assert.equal(source.read().source.multiplier, 3, "only the failed allocation is restored");
      if (outcome === "failure") throw Error("fallback compilation rejected");
      return {deferred: true};
    }, createPublication);
    if (outcome === "failure") await assert.rejects(pending, /fallback compilation rejected/);else assert.deepEqual(await pending, {deferred: true});
    clearInterval(timer);
    assert.equal(preparations, 2);assert.equal(fs.readFileSync(f.file, "utf8"), "accepted", outcome);assert.equal(source.read().source.multiplier, 3);
  }
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

