const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { once, EventEmitter } = require("node:events");
const { BackendWorkerClient, createBackendService } = require("../src/core/backend-worker-client");
const { createBackendOperations } = require("../src/core/backend-operations");
const workerPath = path.join(__dirname, "fixtures", "backend-worker.cjs");

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
    { id: "working", getState() { return { installed: [{ version: "1.2.3" }], catalog: { versions: ["1.2.3", "1.1.0"] } }; } }
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
  assert.deepEqual(events.filter(item => item.event === "activity").map(item => item.payload.processes), [1, 0]);
  await new Promise(resolve => setImmediate(resolve));
});
