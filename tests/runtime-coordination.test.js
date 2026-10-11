const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { createRuntimeCoordinator, isRuntimeProcessAlive } = require("../src/core/runtime-coordinator");
const { createBackendService } = require("../src/core/backend-worker-client");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const workerPath = path.join(__dirname, "fixtures", "coordinated-backend-worker.cjs");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (!await fn()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for the worker."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function environment(t, callbacks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-coordination-"));
  const userDataDir = path.join(root, "data"), coordinator = createRuntimeCoordinator({ userDataDir, orphanPollMs: 20 });
  const events = [], children = [];
  const service = createBackendService({ userDataDir, workerPath, runtimeCoordinator: coordinator,
    callbacks: { "test.downloadGate": async () => true, "test.settingsGate": async () => true,
      confirmRuntimeInstall: async () => true, ...callbacks }, onEvent: (event, payload) => events.push({ event, payload }) });
  t.after(async () => {
    try {
      for (const child of children) {
        if (child.exitCode != null || child.signalCode != null) continue;
        child.kill(); await waitFor(async () => !await isRuntimeProcessAlive(child.pid));
      }
    } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  const game = name => {
    const gamePath = path.join(root, name); fs.mkdirSync(gamePath);
    return { gameId: name, moduleId: "fixture", gameType: "native", runtimeId: "runner", gamePath, contentRootDir: gamePath, moduleData: {} };
  };
  return { root, userDataDir, coordinator, service, events, children, game };
}

test("separate Play and runtime workers coalesce a shared installation after waiting", async t => {
  const gate = deferred();
  const env = environment(t, { "test.downloadGate": async () => gate.promise });
  const entry = env.game("one");
  const play = env.service.launchEntry(entry);
  await waitFor(() => env.events.some(event => event.event === "installStarted"));
  const install = env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "install", { version: "1" });
  await waitFor(() => env.coordinator.snapshot().pending === 1);
  gate.resolve(true);
  const [result, installed] = await Promise.all([play, install]); env.children.push(result.child);
  assert.equal(installed.version, "1");
  assert.equal(fs.readFileSync(path.join(env.userDataDir, "install-counts"), "utf8"), "fixture-a:1\n");
  assert.equal(env.events.filter(event => event.event === "installStarted").length, 1);
});

test("two games share one exact runtime while retaining independent process leases", async t => {
  const gate = deferred(), env = environment(t, { "test.downloadGate": async () => gate.promise });
  const firstEntry = env.game("concurrent-one"), secondEntry = env.game("concurrent-two");
  firstEntry.moduleData.requestedVersion = secondEntry.moduleData.requestedVersion = "3";
  const firstPlay = env.service.launchEntry(firstEntry);
  await waitFor(() => env.events.some(event => event.event === "installStarted"));
  const secondPlay = env.service.launchEntry(secondEntry);
  await waitFor(() => env.coordinator.snapshot().pending === 1);
  gate.resolve();
  const [first, second] = await Promise.all([firstPlay, secondPlay]); env.children.push(first.child, second.child);
  assert.notEqual(first.child.pid, second.child.pid);
  assert.equal(fs.readFileSync(path.join(env.userDataDir, "install-counts"), "utf8"), "fixture-a:3\n");
  const live = () => env.coordinator.snapshot().active.filter(lease => lease.kind === "use");
  assert.equal(live().length, 2); assert.deepEqual(live().map(lease => lease.identities[0].version), ["3", "3"]);
  const exited = once(first.child, "exit"); first.child.kill(); await exited;
  await waitFor(() => live().length === 1);
  assert.deepEqual(live()[0].pids, [second.child.pid]);
  await assert.rejects(env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "v3" }), { code: "RUNTIME_IN_USE" });
  const secondExited = once(second.child, "exit"); second.child.kill(); await secondExited;
  await waitFor(() => live().length === 0);
  assert.equal(await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "3" }), true);
});

test("a slow install leaves other managers, versions and host timers responsive", async t => {
  const gate = deferred();
  const env = environment(t, { "test.downloadGate": async (id, version) => id === "fixture-a" && version === "1" ? gate.promise : true });
  const blocked = env.service.request("runtime:slow", "runtimeAction", "fixture-a", "install", { version: "1" });
  await waitFor(() => env.events.some(event => event.event === "installStarted"));
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  const start = performance.now();
  const results = await Promise.all([
    env.service.request("runtime:other", "runtimeAction", "fixture-b", "install", { version: "1" }),
    env.service.request("runtime:version", "runtimeAction", "fixture-a", "install", { version: "2" })
  ]);
  assert.deepEqual(results.map(result => result.version), ["1", "2"]);
  assert.ok(performance.now() - start < 1500); assert.ok(ticks > 0);
  assert.equal(env.coordinator.snapshot().active.some(lease => lease.kind === "mutation" && lease.identities[0].version === "1"), true);
  gate.resolve(); await blocked;
});

test("active leases use the actual selected version and refuse removing only that artifact", async t => {
  const env = environment(t), entry = env.game("actual-version"); entry.moduleData.requestedVersion = "3";
  await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "install", { version: "1" });
  const result = await env.service.launchEntry(entry); env.children.push(result.child);
  const leases = env.coordinator.snapshot().active.filter(lease => lease.kind === "use");
  assert.equal(leases.length, 1); assert.equal(leases[0].identities[0].version, "3");
  assert.deepEqual(leases[0].pids, [result.child.pid]);
  await assert.rejects(env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "3" }), { code: "RUNTIME_IN_USE" });
  assert.equal(await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "1" }), true);
  const exited = once(result.child, "exit"); result.child.kill(); await exited;
  await waitFor(() => !env.coordinator.snapshot().active.some(lease => lease.kind === "use"));
  assert.equal(await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "3" }), true);
});

test("private runtime contexts retain the shared source lease", async t => {
  const env = environment(t), entry = env.game("private-context"); entry.moduleData.privateContext = true;
  const result = await env.service.launchEntry(entry); env.children.push(result.child);
  const identity = env.coordinator.snapshot().active.find(lease => lease.kind === "use").identities[0];
  assert.equal(identity.sourcePath, fs.realpathSync(path.join(env.userDataDir, "runtimes", "fixture-a", "1")));
  assert.equal(fs.existsSync(path.join(env.userDataDir, "games", entry.gameId, "runner.cjs")), true);
  await assert.rejects(env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "1" }), { code: "RUNTIME_IN_USE" });
});

test("a module's final actual selection protects copied runtime sources before launch", async t => {
  const env = environment(t), entry = env.game("module-selection");
  await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "install", { version: "1" });
  await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "install", { version: "3" });
  entry.moduleData = { requestedVersion: "3", candidateVersion: "1", privateContext: true, automaticSource: true };
  const result = await env.service.launchEntry(entry); env.children.push(result.child);
  const identities = env.coordinator.snapshot().active.filter(lease => lease.kind === "use").flatMap(lease => lease.identities);
  assert.deepEqual(identities.map(identity => identity.version), ["3"]);
  await assert.rejects(env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "3" }), { code: "RUNTIME_IN_USE" });
  assert.equal(await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "1" }), true);
});

test("a failed launch releases all claims without leaving an active runtime", async t => {
  const env = environment(t), entry = env.game("failed");
  entry.moduleData = { privateContext: true, failLaunch: true };
  await assert.rejects(env.service.launchEntry(entry), /Fixture launch failure/);
  assert.equal(env.coordinator.snapshot().active.length, 0);
  assert.equal(await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "1" }), true);
});

test("preparation can update its own unstarted runtime while a running game remains protected", async t => {
  const env = environment(t), entry = env.game("library"); entry.moduleData = { automaticSource: true, libraryMutation: true };
  const result = await env.service.launchEntry(entry); env.children.push(result.child);
  assert.equal(fs.readFileSync(path.join(env.userDataDir, "runtimes", "fixture-a", "1", "library.dat"), "utf8"), "prepared");
  const other = env.game("other-library"); other.moduleData = { automaticSource: true, libraryMutation: true };
  await assert.rejects(env.service.launchEntry(other), { code: "RUNTIME_IN_USE" });
  await assert.rejects(env.service.request("game:assets", "moduleAction", other, "removeSharedAssets", {}), { code: "RUNTIME_IN_USE" });
});

test("nested mutations broaden their scope without waiting on themselves", async () => {
  const { withRuntimeCoordinator, withRuntimeMutation } = require("../src/core/coordinated-runtime-managers");
  const coordinator = createRuntimeCoordinator(), client = coordinator.client();
  await withRuntimeCoordinator(client, "/unused", () => withRuntimeMutation({ managerId: "runtime", version: "1" }, () =>
    withRuntimeMutation({ managerId: "runtime" }, async () => {
      assert.deepEqual(coordinator.snapshot().active[0].identities, [{ managerId: "runtime" }]);
    })));
  assert.equal(coordinator.snapshot().active.length, 0);
  const other = coordinator.client(), blocker = await other.acquireMutation({ managerId: "runtime", version: "2" });
  await assert.rejects(withRuntimeCoordinator(client, "/unused", () => withRuntimeMutation({ managerId: "runtime", version: "1" }, () =>
    withRuntimeMutation({ managerId: "runtime" }, async () => true))), { code: "RUNTIME_MUTATION_BUSY" });
  await other.release(blocker); assert.equal(coordinator.snapshot().active.length, 0);
});

test("two preparing readers can hand off one shared library publication without deadlocking", async t => {
  const { createRuntimeUseScope, withRuntimeCoordinator, withRuntimeUseScope, withRuntimeMutation } = require("../src/core/coordinated-runtime-managers");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-preparing-write-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coordinator = createRuntimeCoordinator({ userDataDir: root }), first = coordinator.client(), second = coordinator.client();
  const manager = { id: "sdk" }, identity = { managerId: "sdk", version: "8.5.3", sectionId: "v8", sourcePath: root };
  const firstScope = createRuntimeUseScope({ coordinator: first, managers: [manager], userDataDir: root });
  const secondScope = createRuntimeUseScope({ coordinator: second, managers: [manager], userDataDir: root });
  await Promise.all([firstScope.useRuntime(identity), secondScope.useRuntime(identity)]);
  const gate = deferred(); let publications = 0;
  const prepare = (client, scope) => scope.withMutablePreparation(identity, () => withRuntimeCoordinator(client, root, () =>
    withRuntimeUseScope(scope, () => withRuntimeMutation(identity, async () => {
      if (fs.existsSync(path.join(root, "library.dat"))) return;
      await gate.promise; fs.writeFileSync(path.join(root, "library.dat"), "ready"); publications++;
    }))));
  const jobs = [prepare(first, firstScope), prepare(second, secondScope)];
  await waitFor(() => coordinator.snapshot().active.some(lease => lease.kind === "mutation"));
  gate.resolve(); await Promise.all(jobs);
  assert.equal(publications, 1); assert.equal(coordinator.snapshot().pending, 0);
  assert.equal(coordinator.snapshot().active.filter(lease => lease.kind === "use").length, 2);
  await Promise.all([firstScope.release(), secondScope.release()]); assert.equal(coordinator.snapshot().active.length, 0);
});

test("a preparing read becoming a running process refuses its queued writer", async () => {
  const coordinator = createRuntimeCoordinator(), reader = coordinator.client(), writer = coordinator.client();
  const token = await reader.acquireUse({ managerId: "sdk", version: "8.5.3" });
  const pending = writer.acquireMutation({ managerId: "sdk", version: "8.5.3" });
  const refused = assert.rejects(pending, { code: "RUNTIME_IN_USE" });
  assert.equal(coordinator.snapshot().pending, 1);
  await reader.bindUse(token, 42); await refused;
  await reader.release(token); assert.equal(coordinator.snapshot().active.length, 0);
});

test("uninstall never trusts a caller directory from another manager", async t => {
  const env = environment(t);
  await env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "install", { version: "1" });
  await env.service.request("runtime:fixture-b", "runtimeAction", "fixture-b", "install", { version: "1" });
  const other = path.join(env.userDataDir, "runtimes", "fixture-b", "1");
  await assert.rejects(env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { version: "1", installDir: other }), /does not belong/);
  assert.equal(fs.existsSync(path.join(other, "runner.cjs")), true);
  await assert.rejects(env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "uninstall", { installDir: other }), /Select an installed/);
});

test("direct module installs and setup's nested installs use the same coordinator", async t => {
  const gate = deferred(), env = environment(t, { "test.downloadGate": async () => gate.promise }), entry = env.game("direct");
  const direct = env.service.request("game:direct", "moduleAction", entry, "installDirect", { version: "2" });
  await waitFor(() => env.events.some(event => event.event === "installStarted"));
  const second = env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "setup", { version: "2" });
  await waitFor(() => env.coordinator.snapshot().pending === 1);
  gate.resolve(); await Promise.all([direct, second]);
  assert.equal(fs.readFileSync(path.join(env.userDataDir, "install-counts"), "utf8"), "fixture-a:2\n");
});

test("settings commits preserve independent runtime defaults and delayed module edits", async t => {
  const gate = deferred(), env = environment(t, { "test.settingsGate": async () => gate.promise }), entry = env.game("settings");
  const setting = env.service.request("game:settings", "moduleAction", entry, "delayedSetting", { key: "compact", value: true });
  await waitFor(() => env.events.some(event => event.event === "settingsEntered"));
  await Promise.all([
    env.service.request("runtime:fixture-a", "runtimeAction", "fixture-a", "setDefault", { version: "2" }),
    env.service.request("runtime:fixture-b", "runtimeAction", "fixture-b", "setDefault", { version: "3" })
  ]);
  gate.resolve(); await setting;
  const saved = JSON.parse(fs.readFileSync(path.join(env.userDataDir, "settings.json")));
  assert.equal(saved.runtimes["fixture-a"].defaultVersion, "2");
  assert.equal(saved.runtimes["fixture-b"].defaultVersion, "3"); assert.equal(saved.launcher.compact, true);
});

test("a failed installer releases its mutation so another worker can retry", async t => {
  const gate = deferred(); let attempts = 0;
  const env = environment(t, { "test.downloadGate": async () => {
    if (++attempts === 1) { await gate.promise; throw new Error("Download failed"); }
    return true;
  } });
  const first = env.service.request("runtime:first", "runtimeAction", "fixture-a", "install", { version: "1" });
  const failed = assert.rejects(first, /Download failed/);
  await waitFor(() => env.events.some(event => event.event === "installStarted"));
  const retry = env.service.request("runtime:retry", "runtimeAction", "fixture-a", "install", { version: "1" });
  await waitFor(() => env.coordinator.snapshot().pending === 1);
  gate.resolve(); await failed;
  assert.equal((await retry).version, "1"); assert.equal(attempts, 2);
  assert.equal(env.coordinator.snapshot().active.length, 0);
});

test("two cold settings writers preserve different sections of the same manager", async t => {
  const env = environment(t), gate = deferred(), originalClient = env.coordinator.client;
  let ready = 0;
  env.coordinator.client = (...args) => {
    const client = originalClient(...args);
    return { ...client, async applySettings(...settings) {
      if (++ready === 2) gate.resolve();
      await gate.promise; return client.applySettings(...settings);
    } };
  };
  await Promise.all([
    env.service.request("runtime:section-one", "runtimeAction", "fixture-a", "setDefault", { key: "first", version: "2" }),
    env.service.request("runtime:section-two", "runtimeAction", "fixture-a", "setDefault", { key: "second", version: "3" })
  ]);
  const cfg = JSON.parse(fs.readFileSync(path.join(env.userDataDir, "settings.json"))).runtimes["fixture-a"];
  assert.equal(cfg.first, "2"); assert.equal(cfg.second, "3");
});

test("a delayed module default change preserves another runtime section's fresh preference", async t => {
  const gate = deferred(), env = environment(t, { "test.settingsGate": async () => gate.promise }), entry = env.game("module-default");
  const edit = env.service.request("game:module-default", "moduleAction", entry, "delayedRuntimeSetting", { key: "first", value: "2" });
  await waitFor(() => env.events.some(event => event.event === "settingsEntered"));
  await env.service.request("runtime:other-section", "runtimeAction", "fixture-a", "setDefault", { key: "second", version: "3" });
  gate.resolve(); await edit;
  const cfg = JSON.parse(fs.readFileSync(path.join(env.userDataDir, "settings.json"))).runtimes["fixture-a"];
  assert.equal(cfg.first, "2"); assert.equal(cfg.second, "3");
});

test("terminating a game worker retains its real native child's runtime until exit", async t => {
  const env = environment(t), entry = env.game("orphan");
  const result = await env.service.launchEntry(entry); env.children.push(result.child);
  await env.service.close();
  const survivor = createBackendService({ userDataDir: env.userDataDir, workerPath, runtimeCoordinator: env.coordinator });
  t.after(() => survivor.close());
  await assert.rejects(survivor.request("runtime:guard", "runtimeAction", "fixture-a", "uninstall", { version: "1" }), { code: "RUNTIME_IN_USE" });
  assert.equal(env.coordinator.snapshot().active[0].orphan, true);
  assert.equal(env.coordinator.snapshot().games[0].orphan, true);
  await assert.rejects(survivor.request("game:guard", "removeGameData", entry), { code: "GAME_IN_USE" });
  result.child.kill();
  await waitFor(() => env.coordinator.snapshot().active.length === 0);
  await waitFor(() => env.coordinator.snapshot().games.length === 0);
  assert.equal(await survivor.request("runtime:guard", "runtimeAction", "fixture-a", "uninstall", { version: "1" }), true);
});

test("closing a worker owner cancels queued jobs but retains an alive child lease", async () => {
  let alive = true;
  const coordinator = createRuntimeCoordinator({ isProcessAlive: () => alive, orphanPollMs: 10 });
  const first = coordinator.client("one"), second = coordinator.client("two");
  const use = await first.acquireUse({ managerId: "runtime", version: "3", sectionId: "v8" });
  await first.bindUse(use, 42); first.close();
  await assert.rejects(second.acquireMutation({ managerId: "runtime", version: "3" }), { code: "RUNTIME_IN_USE" });
  assert.equal(coordinator.snapshot().active[0].orphan, true);
  alive = false; await waitFor(() => coordinator.snapshot().active.length === 0);
  const lock = await second.acquireMutation({ managerId: "runtime", version: "3" });
  const closing = coordinator.client("closing"), queued = closing.acquireUse({ managerId: "runtime", version: "3" });
  closing.close(); await assert.rejects(queued, { code: "RUNTIME_OWNER_CLOSED" });
  await second.release(lock); assert.equal(coordinator.snapshot().pending, 0);
});

test("included sources cannot be uninstalled even through a matching caller path", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-included-use-")); t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let removed = false;
  const manager = { id: "included", getState: () => ({ installed: [{ version: "1", installDir: userDataDir, readOnly: true, removable: false }] }),
    uninstallRuntime: () => { removed = true; } };
  await assert.rejects(runRuntimeManagerAction({ manager, action: "uninstall", userDataDir, payload: { version: "1", installDir: userDataDir } }), /Included runtime/);
  assert.equal(removed, false);
});
test("tool readers can run concurrently and removal waits for their exact version", async () => {
  const { withRuntimeCoordinator, withRuntimeMutation, withRuntimeUse } = require("../src/core/coordinated-runtime-managers");
  const coordinator = createRuntimeCoordinator(), first = coordinator.client(), second = coordinator.client(), writer = coordinator.client();
  const identity = { managerId: "ilspy", sectionId: "decompiler", version: "9.1.0.7988" };
  const firstGate = deferred(), secondGate = deferred(); let readers = 0, removed = false;
  const read = (client, gate) => withRuntimeCoordinator(client, "/unused", () => withRuntimeUse(identity, async () => {
    readers++; await gate.promise;
  }));
  const firstUse = read(first, firstGate), secondUse = read(second, secondGate);
  await waitFor(() => readers === 2);
  assert.equal(coordinator.snapshot().active.filter(lease => lease.kind === "use").length, 2);
  const removal = withRuntimeCoordinator(writer, "/unused", () => withRuntimeMutation(identity, () => { removed = true; }));
  await waitFor(() => coordinator.snapshot().pending === 1);
  firstGate.resolve(); await firstUse; assert.equal(removed, false);
  secondGate.resolve(); await secondUse; await removal;
  assert.equal(removed, true); assert.equal(coordinator.snapshot().active.length, 0);
});
test("a cancelled tool export releases reader leases without blocking another version", async () => {
  const { withRuntimeCoordinator, withRuntimeMutation, withRuntimeUse } = require("../src/core/coordinated-runtime-managers");
  const coordinator = createRuntimeCoordinator(), reader = coordinator.client(), writer = coordinator.client();
  const identity = { managerId: "ilspy", sectionId: "decompiler", version: "9.1.0.7988" };
  const ready = deferred(), cancelled = deferred(); let removed = false;
  const operation = withRuntimeCoordinator(reader, "/unused", () => withRuntimeUse(identity, async () => {
    ready.resolve(); await cancelled.promise; throw Object.assign(new Error("Canceled"), { code: "ABORT_ERR" });
  }));
  await ready.promise;
  await withRuntimeCoordinator(writer, "/unused", () => withRuntimeMutation({ ...identity, version: "11.1.0.9782" }, () => {}));
  const removal = withRuntimeCoordinator(writer, "/unused", () => withRuntimeMutation(identity, () => { removed = true; }));
  await waitFor(() => coordinator.snapshot().pending === 1);
  const rejection = assert.rejects(operation, { code: "ABORT_ERR" });
  cancelled.resolve(); await rejection; await removal;
  assert.equal(removed, true); assert.equal(coordinator.snapshot().active.length, 0);
});
test("forced tool-worker exit preserves both source leases and game data until the child exits", async t => {
  const env = environment(t), entry = env.game("tool-orphan");
  require("../src/core/game-store").writeGameRecord(env.userDataDir, entry);
  await env.service.request("runtime:tool", "runtimeAction", "fixture-a", "install", { version: "1" });
  await env.service.request("runtime:host", "runtimeAction", "fixture-b", "install", { version: "1" });
  const work = env.service.request("game:tool", "moduleAction", entry, "managedExport", {});
  const rejected = assert.rejects(work, /worker|closed|stopped/i);
  await waitFor(() => env.events.some(event => event.event === "toolStarted"));
  const pid = env.events.find(event => event.event === "toolStarted").payload.pid;
  t.after(async () => {
    if (await isRuntimeProcessAlive(pid)) { process.kill(pid, "SIGKILL"); await waitFor(async () => !await isRuntimeProcessAlive(pid)); }
  });
  const lease = env.coordinator.snapshot().active.find(lease => lease.kind === "use");
  assert.deepEqual(lease.identities.map(identity => identity.managerId), ["fixture-a", "fixture-b"]);
  assert.deepEqual(lease.pids, [pid]);
  assert.deepEqual(env.coordinator.snapshot().games[0].pids, [pid]);
  await env.service.close(); await rejected;
  const survivor = createBackendService({ userDataDir: env.userDataDir, workerPath, runtimeCoordinator: env.coordinator });
  t.after(() => survivor.close());
  for (const managerId of ["fixture-a", "fixture-b"])
    await assert.rejects(survivor.request("runtime:guard-" + managerId, "runtimeAction", managerId, "uninstall", { version: "1" }), { code: "RUNTIME_IN_USE" });
  await assert.rejects(survivor.request("game:guard", "removeGameData", entry), { code: "GAME_IN_USE" });
  process.kill(pid, "SIGTERM");
  await waitFor(() => env.coordinator.snapshot().active.length === 0 && env.coordinator.snapshot().games.length === 0);
  for (const managerId of ["fixture-a", "fixture-b"])
    assert.equal(await survivor.request("runtime:guard-" + managerId, "runtimeAction", managerId, "uninstall", { version: "1" }), true);
  assert.equal((await survivor.request("game:guard", "removeGameData", entry)).gameId, entry.gameId);
});
