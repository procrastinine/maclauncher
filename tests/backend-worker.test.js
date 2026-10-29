const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { once, EventEmitter } = require("node:events");
const { BackendWorkerClient, createBackendService } = require("../src/core/backend-worker-client");
const { createBackendOperations } = require("../src/core/backend-operations");
const workerPath = path.join(__dirname, "fixtures", "backend-worker.cjs");

test("actual backend tool roles cross worker IPC into the ordinary main log without adding stop ownership", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-tool-role-relay-")), gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath);
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const logStart = source.indexOf("function logRuntimeToolSpawn("), logEnd = source.indexOf("\nconst launcherService = createLauncher({", logStart);
  const logs = [], logger = { info: (...args) => logs.push(args) }, Modules = require("../src/modules/registry");
  const logRuntimeToolSpawn = new Function("logger", "Modules", "return (" + source.slice(logStart, logEnd) + ");")(logger, Modules);
  const eventStart = source.indexOf("  onEvent: (event, payload, lane) => {");
  const eventEnd = source.indexOf("\n});\nasync function confirmRuntimeInstallation", eventStart);
  const onEvent = new Function("logRuntimeToolSpawn", "return (" + source.slice(eventStart + "  onEvent: ".length, eventEnd).trim() + ");")(logRuntimeToolSpawn);
  const events = [], temporaryAtSpawn = [], service = createBackendService({ userDataDir: path.join(root, "data"), workerPath,
    onEvent: (event, payload, lane) => { if (event === "toolProcess") { events.push(payload); temporaryAtSpawn.push(service.hasTemporaryProcesses()); onEvent(event, payload, lane); } } });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await service.request("game:tool-role", "runtimeToolRoles", gamePath, [
    { ownerName: "presenter", stopOnLauncherExit: true, shutdownGraceMs: 15000 },
    { ownerName: "window-root", stopOnLauncherExit: false },
    { ownerName: "system-profile-owner" },
    { ownerName: "invalid\nrole", stopOnLauncherExit: false }
  ]);
  assert.equal(events.length, 4); assert.equal(logs.length, 3);
  assert.deepEqual(events.map(row => row.process.pid), result.pids);
  assert.deepEqual(events.map(row => row.stopOnLauncherExit), [true, false, false, false]);
  assert.deepEqual(temporaryAtSpawn, [true, false, false, false]);
  assert.equal(events[0].shutdownGraceMs, 15000);
  for (const row of events.slice(1)) assert.equal(Object.hasOwn(row, "shutdownGraceMs"), false);
  for (const [index, call] of logs.entries()) {
    assert.equal(call[0], "[runtime-tool] %s");
    assert.deepEqual(JSON.parse(call[1]), { event: "spawn", pid: result.pids[index], owner: ["presenter", "window-root", "system-profile-owner"][index],
      gameId: result.gameId, moduleId: "web", runtimeId: "runner" });
  }
  assert.doesNotMatch(JSON.stringify(events) + JSON.stringify(logs), /private|TOKEN|command|environment|gamePath|spawnargs|invalid/);
  assert.equal(service.hasTemporaryProcesses(), false);
  for (const pid of result.pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("account settings share managed downloads and native installation consent", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-account-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], plan = { managerId: 'android', label: 'Android account service' };
  const module = { settingsActions: { async signIn(_payload, context) {
    assert.equal(typeof context.downloads.cancel, 'function');
    return context.confirmRuntimeInstall(plan);
  } } };
  const registry = { listModuleIds: () => ['fixture'], listModules: () => [{ id: 'fixture' }],
    getModule: () => module, getModuleDir: () => root, getModuleInfo: () => ({ id: 'fixture' }), listSharedRuntimeManagers: () => [] };
  const operations = createBackendOperations({ userDataDir: root, registry,
    callHost: async (...args) => { calls.push(args); return false; } });
  assert.equal(await operations.moduleSettingsAction('fixture', 'signIn'), false);
  assert.deepEqual(calls, [['confirmRuntimeInstall', plan]]);
});

test("Cancel interrupts cold launch metadata before runtime preparation", { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-cold-launch-cancel-")), gamePath = path.join(root, "game");
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(gamePath);
  const info = { id: "fixture", label: "Fixture", runtime: { default: "runner", supported: ["runner"] } };
  let entered, release, suppliedSignal, launches = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const module = { id: info.id, manifest: info, async resolveGameMetadata(_entry, { signal }) {
    suppliedSignal = signal;
    await new Promise(resolve => { release = resolve; signal?.addEventListener("abort", resolve, { once: true }); entered(); });
    signal?.throwIfAborted(); return { name: "Resolved fixture" };
  }, launchRuntime() { launches++; assert.fail("Cancelled metadata cannot reach runtime launch"); } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModule: () => module,
    getModuleDir: () => root, getModuleInfo: () => info, listSharedRuntimeManagers: () => [],
    detectGameAsync: async () => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }) };
  const userDataDir = path.join(root, "data"), operations = createBackendOperations({ userDataDir, registry });
  const entry = { gameId: "fixture", moduleId: info.id, runtimeId: "runner", gamePath, importPath: gamePath };
  const pending = operations.launchEntry(entry, {}); await started;
  try {
    assert.equal(operations.cancelLaunch(entry), true);
    assert.ok(suppliedSignal instanceof AbortSignal); assert.equal(suppliedSignal.aborted, true);
    assert.deepEqual(await pending, { kind: "cancelled", runtimeId: "runner" });
    assert.equal(launches, 0);
    assert.equal(fs.existsSync(path.join(userDataDir, "games", "fixture", "metadata.json")), false);
    assert.equal(operations.cancelLaunch(entry), false, "the cancelled launch releases its pending reservation");
  } finally { release(); await pending; }
});

test("pending native launch consent cancels across worker IPC and ignores late replies", { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-consent-cancel-")), gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath);
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const forward = mainSource.split("\n").find(line => line.trimStart().startsWith("confirmRuntimeInstall:"));
  const mainConfirmation = callback => new Function("confirmRuntimeInstallation", "return (" + forward.slice(forward.indexOf(":") + 1).trim().replace(/,$/, "") + ");")(callback);
  const wrapper = path.join(root, "worker.cjs"), registryPath = require.resolve("../src/modules/registry");
  fs.writeFileSync(wrapper, `const registry = require(${JSON.stringify(registryPath)});
    const info = {id: "fixture", label: "Fixture", gameType: "native", runtime: {default: "runner", supported: ["runner"], entries: {runner: {}}}};
    const mod = {id: info.id, manifest: info, async launchRuntime(_id, _entry, context) {
      await context.confirmRuntimeInstall({managerId: "fixture-host", label: "Fixture host", version: "1"});
      context.signal.throwIfAborted();throw new Error("Cancelled consent reached game launch");
    }};
    Object.assign(registry, {listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod,
      getModuleInfo: () => info, getModuleDir: () => ${JSON.stringify(root)}, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
      detectGameAsync: async () => ({moduleId: info.id, gamePath: ${JSON.stringify(gamePath)}, contentRootDir: ${JSON.stringify(gamePath)}, name: "Fixture"})});
    require(${JSON.stringify(require.resolve("../src/core/backend-worker"))});
  `);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const cancellation of ["stop", "shutdown"]) await t.test(cancellation, async () => {
    const coordination = require("../src/core/runtime-coordinator").createRuntimeCoordinator().client();
    const callbacks = Object.fromEntries(["acquireMutation", "extendMutation", "acquireUse", "acquireGameUse", "acquireGameRemoval", "completeGameRemoval", "release", "bindUse", "applySettings"]
      .map(method => [`runtimeCoordinator.${method}`, (...args) => coordination[method](...args)]));
    let entered, release, signal, callbackId, confirmations = 0;
    const started = new Promise(resolve => {entered = resolve;}), events = [], sent = [];
    const client = new BackendWorkerClient({workerPath: wrapper, workerData: {userDataDir: path.join(root, cancellation)}, callbacks: {
      ...callbacks, confirmRuntimeInstall: mainConfirmation((...args) => {
        confirmations++;
        assert.equal(args.length, 3);assert.equal(args[0].managerId, "fixture-host");assert.equal(args[1].moduleId, "fixture");
        signal = args[2].signal;assert.ok(signal instanceof AbortSignal);
        return new Promise(resolve => {release = resolve;entered();});
      })
    }});
    client.on("event", (event, payload) => events.push({event, payload}));
    client.worker.on("message", message => {if (message.type === "callback" && message.method === "confirmRuntimeInstall") callbackId = message.id;});
    const post = client.worker.postMessage.bind(client.worker);
    t.mock.method(client.worker, "postMessage", message => {sent.push(message);return post(message);});
    try {
      const settings = {launcher: {networkAccess: true}}, entry = await client.request("importEntry", gamePath, settings);
      entry.runtimeId = "runner";
      const pending = client.request("launchEntry", entry, {settings});await started;
      assert.equal(signal.aborted, false);assert.equal(client.callbackRequests.size, 1);
      if (cancellation === "stop") assert.equal(await client.request("cancelLaunch", entry), true);
      else await client.shutdownTemporaryProcesses();
      assert.equal((await pending).kind, "cancelled");
      // The host intentionally stays unresolved: cancellation must not await it.
      assert.equal(signal.aborted, true);assert.equal(client.callbackRequests.size, 0);assert.equal(client.pending.size, 0);
      assert.equal(events.some(row => row.event === "gameProcess"), false);
      assert.equal(events.filter(row => row.event === "preparation").at(-1).payload.phase, "done");
      release(true);await new Promise(resolve => setImmediate(resolve));
      assert.equal(sent.some(message => message.type === "callbackResult" && message.id === callbackId), false, "a late approval cannot resume the cancelled launch");
      assert.equal(client.callbackRequests.size, 0);
      if (cancellation === "stop") assert.equal(await client.request("cancelLaunch", entry), false);
      else {
        await client.handleMessage({type: "callback", id: 999999, method: "confirmRuntimeInstall", args: [{}, entry], cancellable: true});
        assert.equal(confirmations, 1, "shutdown rejects a late consent request before opening a native dialog");
        assert.equal(client.callbackRequests.size, 0);
        assert.equal(sent.find(message => message.type === "callbackResult" && message.id === 999999).error.name, "AbortError");
      }
    } finally {release?.(false);await client.close();coordination.close();}
  });
});

test("production module discovery preserves the backend worker across imports", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-module-worker-"));
  const service = createBackendService({ userDataDir: path.join(root, "data"), appInfo: {} });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const game = path.join(root, "web-game"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "index.html"), "<!doctype html><title>Game</title><canvas></canvas>");
  const first = await service.request("library", "importEntry", game, {});
  assert.equal(first.gamePath, game);
  assert.equal(first.moduleId, "web");
  const second = await service.request("library", "importEntry", game, {});
  assert.equal(second.gamePath, first.gamePath);
  assert.equal(second.moduleId, first.moduleId);
  assert.equal(service.hasPendingOperations(), false);
});

test("synchronous runtime work cannot block the host event loop or another game lane", async t => {
  const service = createBackendService({ workerPath }); t.after(() => service.close());
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10); t.after(() => clearInterval(timer));
  // Warm both isolated workers before measuring the independent operation.
  await Promise.all([service.request("game:slow", "echo"), service.request("game:other", "echo")]);
  const slow = service.request("game:slow", "busy", 350);
  await new Promise(resolve => setTimeout(resolve, 40));
  const start = performance.now();
  assert.deepEqual(await service.request("game:other", "echo", "responsive"), ["responsive"]);
  assert.ok(performance.now() - start < 250, "another game's job waited for the slow runtime");
  await slow;
  assert.ok(ticks >= 15, "host timers stopped during synchronous backend work");
});

test("native host callbacks roundtrip asynchronously and preserve structured errors", async t => {
  const client = new BackendWorkerClient({ workerPath, callbacks: { choose: async descriptor => ({ path: descriptor.path }) } });
  t.after(() => client.close());
  assert.deepEqual(await client.request("callback", { path: "/owned/runtime.pkg" }), { path: "/owned/runtime.pkg" });
  client.callbacks.choose = async () => { const error = new Error("Cancelled"); error.code = "ABORT_ERR"; throw error; };
  await assert.rejects(client.request("callback", {}), { message: "Cancelled", code: "ABORT_ERR" });
});

test("processes that exit before IPC delivery retain their terminal state", async t => {
  const client = new BackendWorkerClient({ workerPath }); t.after(() => client.close());
  const record = await client.request("finishedProcess"), child = client.process(record);
  assert.equal(child.pid, 12345); assert.equal(child.exitCode, 0);
  assert.equal(client.process(record), child);
});

test("runtime completion diagnostics cross worker descriptors without stale launch-reply replacement", async t => {
  const client = new BackendWorkerClient({ workerPath }); t.after(() => client.close());
  const record = { id: "diagnostic-test", pid: 12345, exitCode: null, signalCode: null,
    completionDiagnostics: { pending: true } };
  const child = client.process(record);
  let received = 0;
  child.on("diagnostics", () => received++);
  client.handleProcessEvent({ process: { ...record, exitCode: 1 }, event: "exit", code: 1 });
  const final = { pending: false, message: "IllegalStateException: unavailable callback", logFile: "/owned/runtime.log" };
  client.handleProcessEvent({ process: { ...record, exitCode: 1, completionDiagnostics: final }, event: "diagnostics" });
  assert.equal(client.process(record), child);
  assert.deepEqual(child.completionDiagnostics, final);
  assert.equal(received, 1);
});

test("repeated completed tool processes do not accumulate strong process records", async t => {
  const client = new BackendWorkerClient({ workerPath }); t.after(() => client.close());
  const live = client.process({ id: "live", pid: 12344, exitCode: null, signalCode: null });
  for (let i = 0; i < 1000; i++) {
    const record = { id: "finished-" + i, pid: 12345, exitCode: null, signalCode: null };
    const child = client.process(record);
    let closed = false;
    child.once("close", () => { closed = true; });
    client.handleProcessEvent({ process: { ...record, exitCode: 0 }, event: "exit", code: 0 });
    client.handleProcessEvent({ process: { ...record, exitCode: 0 }, event: "close", code: 0 });
    assert.equal(closed, true);
    assert.equal(client.children.size, 1);
    assert.ok(client.finishedChildren.size <= 64);
  }
  assert.equal(client.process({ id: "live", pid: 12344 }), live);
  await client.close();
  assert.equal(client.children.size, 0); assert.equal(client.finishedChildren.size, 0);
});

test("closing a worker stops temporary inspector servers and preserves independent editors", async t => {
  const client = new BackendWorkerClient({ workerPath });
  t.after(() => client.close());
  const temporary = client.process(await client.request("inspectorProcess", true));
  const editor = client.process(await client.request("inspectorProcess", false));
  t.after(() => { try { process.kill(-editor.pid, "SIGKILL"); } catch {} });
  assert.equal(client.temporaryProcesses.size, 1);
  await client.close();
  assert.equal(temporary.signalCode, "SIGTERM");
  assert.throws(() => process.kill(temporary.pid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(editor.pid, 0));
});
test("temporary ownership forwards a bounded cleanup budget to stop and waits for child close", async t => {
  const client = new BackendWorkerClient({workerPath});t.after(() => client.close());
  await client.request("echo");
  const calls = [], timers = [];
  t.mock.method(process, "kill", (...args) => calls.push(args));
  t.mock.method(global, "setTimeout", (callback, delay) => {timers.push({callback, delay});return {unref() {}};});
  for (const [index, budget] of [undefined, 15000, 15001].entries()) {
    const record = {id: `budget-${index}`, pid: 987000 + index}, grace = budget === 15000 ? 15000 : 2000;
    await client.handleMessage({type: "event", event: "toolProcess", payload: {process: record, stopOnLauncherExit: true, shutdownGraceMs: budget}});
    assert.equal(client.temporaryProcesses.get(record.id).shutdownGraceMs, grace);
    const before = timers.length;let finished = false;
    const stopping = client.stopTemporaryProcesses().then(() => {finished = true;});
    assert.deepEqual(timers.slice(before).map(row => row.delay), [grace + 1000, grace]);
    await Promise.resolve();assert.equal(finished, false);
    client.handleProcessEvent({process: record, event: "close", code: 0, signal: null});await stopping;
    assert.equal(finished, true);
  }
  assert.deepEqual(calls, [[-987000, "SIGTERM"], [-987001, "SIGTERM"], [-987002, "SIGTERM"]]);
  // Mocked termination only: the current PID supplies an actually-live ps
  // observation while the proxy close races that asynchronous inspection.
  const record = {id: "retirement-race", pid: process.pid};
  await client.handleMessage({type: "event", event: "toolProcess", payload: {process: record, stopOnLauncherExit: true}});
  const before = timers.length, stopping = client.stopTemporaryProcesses();
  const inspecting = timers[before].callback(), afterInspectionStarted = timers.length;
  client.handleProcessEvent({process: record, event: "close", code: 0, signal: null});await stopping;await inspecting;
  assert.equal(timers.length, afterInspectionStarted, "close must prevent an in-flight retirement check from scheduling another poll");
});
test("both backend ownership callbacks retain cleanup budgets for late temporary helpers", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-late-cleanup-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const gamePath = path.join(root, "game");fs.mkdirSync(gamePath);
  const info = {id: "fixture", label: "Fixture", gameType: "native", runtime: {default: "runner", supported: ["runner"], entries: {runner: {}}}};
  let launchOwnership, settingsOwnership;
  const mod = {id: info.id, manifest: info, actions: {inspect: async (_entry, _payload, context) => {launchOwnership = context.onToolProcessSpawn;}},
    settingsActions: {inspect: async (_payload, context) => {settingsOwnership = context.onToolProcessSpawn;}}};
  const registry = {listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod, getModuleInfo: () => info,
    getModuleDir: () => root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async () => ({moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture"})};
  const events = [], operations = createBackendOperations({userDataDir: path.join(root, "data"), registry, emit: (event, payload) => events.push({event, payload})});
  const entry = await operations.importEntry(gamePath, {});
  await operations.moduleAction(entry, "inspect", {}, {});await operations.moduleSettingsAction(info.id, "inspect", {});operations.beginShutdown();
  const timers = [], signals = [];
  t.mock.method(process, "kill", (...args) => signals.push(args));
  t.mock.method(global, "setTimeout", (_callback, delay) => {timers.push(delay);return {unref() {}};});
  for (const [index, callback] of [launchOwnership, settingsOwnership].entries()) {
    const child = Object.assign(new EventEmitter(), {pid: 987010 + index, exitCode: null, signalCode: null});
    await assert.rejects(Promise.resolve().then(() => callback(child, {stopOnLauncherExit: true, shutdownGraceMs: 15000})), {name: "AbortError"});
    const owned = events.filter(row => row.event === "toolProcess").at(-1);
    assert.equal(owned.payload.shutdownGraceMs, 15000);assert.equal(owned.payload.process.pid, child.pid);
    child.exitCode = 0;child.emit("exit", 0);child.emit("close", 0);
  }
  assert.deepEqual(timers, [15000, 15000]);assert.deepEqual(signals, [[-987010, "SIGTERM"], [-987011, "SIGTERM"]]);
});

test("shutdown drains late temporary servers while preserving independent editors", async t => {
  const client = new BackendWorkerClient({ workerPath }); t.after(() => client.close());
  const temporary = client.process(await client.request("inspectorProcess", true));
  const editor = client.process(await client.request("inspectorProcess", false));
  t.after(() => { try { process.kill(-editor.pid, "SIGKILL"); } catch {} });
  const pending = client.request("delayedInspectorProcess", true, 100);
  const shuttingDown = client.shutdownTemporaryProcesses();
  await assert.rejects(client.request("echo", "new action"), { name: "AbortError" });
  const late = client.process(await pending);
  await shuttingDown;
  for (const child of [temporary, late]) {
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    assert.equal(child.signalCode, "SIGTERM");
  }
  assert.equal(client.pending.size, 0); assert.equal(client.temporaryProcesses.size, 0);
  assert.doesNotThrow(() => process.kill(editor.pid, 0));
});

test("service shutdown blocks new lanes and waits for a pending first inspector to stop", async t => {
  const service = createBackendService({ workerPath }); t.after(() => service.close());
  const editor = await service.request("editor", "inspectorProcess", false);
  t.after(() => { try { process.kill(-editor.pid, "SIGKILL"); } catch {} });
  const pending = service.request("tools", "delayedInspectorProcess", true, 75);
  assert.equal(service.hasTemporaryProcesses(), false); assert.equal(service.hasPendingOperations(), true);
  const shuttingDown = service.shutdownTemporaryProcesses();
  await assert.rejects(service.request("new", "echo"), { name: "AbortError" });
  const late = await pending;
  await shuttingDown;
  assert.throws(() => process.kill(late.pid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(editor.pid, 0));
  assert.equal(service.hasTemporaryProcesses(), false); assert.equal(service.hasPendingOperations(), false);
});

test("a failed runtime inventory is isolated and never hides other managers", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managers = [
    { id: "broken", getState() { throw new TypeError("path must be a string"); } },
    { id: "working", getState() { return { id: "default", installed: [{ version: "1.2.3" }], catalog: { versions: ["1.2.3", "1.1.0"] } }; } }
  ];
  const info = { id: "fixture" }, events = [];
  const registry = { listModuleIds: () => [info.id], listModules: () => [info],
    getModule: () => ({ runtimeManagers: managers }), getModuleInfo: () => info,
    getModuleDir: () => root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  const operations = createBackendOperations({ userDataDir: root, registry, emit: (event, payload) => events.push({ event, payload }) });
  await operations.runtimeStates({ runtimes: {} });
  const states = events.filter(event => event.event === "runtimeState").map(event => event.payload);
  assert.equal(states.length, 2); assert.match(states[0].state.catalog.error, /path must be a string/);
  assert.deepEqual(states[1].state.catalog.versions, ["1.2.3", "1.1.0"]);
  assert.equal(states[1].state.id, "working", "Section IDs must not replace the manager used for UI actions");
});

test("children already exited or signalled do not retain their backend worker", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-finished-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game"); fs.mkdirSync(gamePath);
  const info = { id: "fixture", label: "Fixture", gameType: "native",
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } } };
  let child;
  const mod = { id: info.id, manifest: info, launchRuntime: async () => child };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info],
    getModule: () => mod, getModuleInfo: () => info, getModuleDir: () => root,
    listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async () => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }) };
  const events = [], operations = createBackendOperations({ userDataDir: path.join(root, "data"), registry,
    emit: (event, payload) => events.push({ event, payload }) });
  const entry = await operations.importEntry(gamePath, {});
  for (const terminal of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }]) {
    child = Object.assign(new EventEmitter(), { pid: 12345, ...terminal }); events.length = 0;
    const result = await operations.launchEntry(entry, { settings: {} });
    assert.equal(result.process.exitCode, terminal.exitCode);
    assert.equal(result.process.signalCode, terminal.signalCode);
    assert.deepEqual(events.filter(item => item.event === "activity").map(item => item.payload.processes), [1, 0]);
    child.emit("close", terminal.exitCode, terminal.signalCode);
    assert.deepEqual(events.filter(item => item.event === "activity").map(item => item.payload.processes), [1, 0], "late close must not release another process");
  }
});

test("persistent inspector processes retain their worker without marking the game as running", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-inspector-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game"); fs.mkdirSync(gamePath);
  const info = { id: "fixture", label: "Fixture", gameType: "native",
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } } };
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  const mod = { id: info.id, manifest: info, actions: {
    inspect: async (_entry, _payload, context) => {
      await context.onToolProcessSpawn(child);
      await context.onToolProcessSpawn(child);
      return { running: context.isGameRunning() };
    }
  } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info],
    getModule: () => mod, getModuleInfo: () => info, getModuleDir: () => root,
    listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async () => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }) };
  const events = [], operations = createBackendOperations({ userDataDir: path.join(root, "data"), registry,
    emit: (event, payload) => events.push({ event, payload }) });
  const entry = await operations.importEntry(gamePath, {});
  assert.deepEqual(await operations.moduleAction(entry, "inspect", {}, {}), { running: false });
  assert.deepEqual(events.filter(item => item.event === "activity").map(item => item.payload.processes), [1]);
  assert.equal(events.some(item => item.event === "toolLaunch"), false);
  child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0);
  assert.deepEqual(events.filter(item => item.event === "activity").map(item => item.payload.processes), [1]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(item => item.event === "activity").map(item => item.payload.processes), [1, 0]);
});

test("launch preparation cancels and a spawned process is published before module readiness", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-launch-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game"); fs.mkdirSync(gamePath);
  const info = { id: "fixture", label: "Fixture", gameType: "native",
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } } };
  const settings = { launcher: { networkAccess: true } };
  let phase = "prepare", child, entered;
  const began = () => new Promise(resolve => { entered = resolve; });
  const mod = { id: info.id, manifest: info, launchRuntime: async (_id, _entry, context) => {
    assert.equal(context.networkAllowed, true, "ENOENT belongs to the direct spawn boundary");
    if (phase === "missing") return context.spawnDetachedChecked(path.join(root, "missing-executable"), []);
    if (phase === "prepare") {
      entered();
      await new Promise((resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      assert.fail("cancelled preparation continued");
    }
    child = await context.spawnDetachedChecked(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    entered();
    if (child.exitCode == null && child.signalCode == null) await once(child, "close");
    return child;
  } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info],
    getModule: () => mod, getModuleInfo: () => info, getModuleDir: () => root,
    listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async () => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }) };
  const events = [], operations = createBackendOperations({ userDataDir: path.join(root, "data"), registry,
    emit: (event, payload) => events.push({ event, payload }) });
  t.after(() => { if (child?.exitCode == null && child?.signalCode == null) child?.kill(); });
  const entry = await operations.importEntry(gamePath, settings);
  let started = began(), pending = operations.launchEntry(entry, { settings });
  await started;
  assert.equal(operations.cancelLaunch(entry), true);
  assert.equal((await pending).kind, "cancelled");
  assert.equal(operations.cancelLaunch(entry), false, "completed controllers are removed");
  assert.equal(events.some(e => e.event === "gameProcess"), false);
  phase = "process"; events.length = 0; started = began();
  let returned = false;
  pending = operations.launchEntry(entry, { settings }).then(value => { returned = true; return value; });
  await started;
  const owned = events.filter(e => e.event === "gameProcess");
  assert.equal(owned.length, 1); assert.equal(owned[0].payload.process.pid, child.pid);
  assert.equal(returned, false, "Stop can be offered while module readiness is pending");
  assert.equal(operations.cancelLaunch(entry), true);
  assert.equal((await pending).kind, "cancelled");
  assert.equal(operations.cancelLaunch(entry), false);
  assert.equal(child.signalCode, "SIGTERM");
  assert.ok(events.some(e => e.event === "process" && e.payload.event === "exit" && e.payload.process.stopRequested));
  assert.equal(events.filter(e => e.event === "activity").at(-1).payload.processes, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  phase = "missing"; events.length = 0;
  await assert.rejects(operations.launchEntry(entry, { settings }), { code: "ENOENT" });
  assert.equal(events.some(e => e.event === "gameProcess"), false, "failed spawn does not publish an invalid PID");
  assert.equal(operations.cancelLaunch(entry), false);
});
