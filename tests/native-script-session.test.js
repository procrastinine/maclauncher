const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { trackScriptProcess, hasLiveGroupProcesses } = require("../src/modules/generic-app/process-session");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const missing = () => { throw Object.assign(new Error("No such process group"), { code: "ESRCH" }); };

test("script sessions preserve pipes, exit status, and exit-before-close ordering", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: {}, stderr: {}, stdin: {}, stdio: [] });
  const session = trackScriptProcess(child, { kill: missing });
  const events = [];
  session.on("exit", (...args) => events.push(["exit", ...args]));
  session.on("close", (...args) => events.push(["close", ...args]));
  assert.equal(session.pid, child.pid);
  assert.equal(session.stdout, child.stdout);
  assert.equal(session.stderr, child.stderr);
  assert.equal(session.stdin, child.stdin);
  child.emit("exit", 7, null);
  assert.equal(session.exitCode, 7);
  assert.deepEqual(events, [["exit", 7, null]]);
  child.emit("close", 7, null);
  assert.deepEqual(events, [["exit", 7, null], ["close", 7, null]]);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
});

test("only an exited launcher's owned group is polled, and completion retires polling", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 234 });
  let alive = true, probes = 0;
  const session = trackScriptProcess(child, { pollIntervalMs: 5, kill: (pid, signal) => {
    assert.equal(pid, -234); assert.equal(signal, 0); probes++;
    if (!alive) missing();
  } });
  await delay(10);
  assert.equal(probes, 0);
  const exited = once(session, "exit");
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  assert.equal(session.signalCode, null);
  await delay(10);
  assert.ok(probes > 1);
  alive = false;
  assert.deepEqual(await exited, [null, "SIGTERM"]);
  assert.equal(session.signalCode, "SIGTERM");
  const completedProbes = probes;
  await delay(15);
  assert.equal(probes, completedProbes);
  assert.equal(session.kill(), false);
  assert.equal(child.listenerCount("close"), 0);
});

test("spawn errors retain ChildProcess error and close behavior without group polling", () => {
  const child = new EventEmitter(), session = trackScriptProcess(child, { kill: () => assert.fail("No owned group") });
  const error = Object.assign(new Error("Not found"), { code: "ENOENT" });
  const events = [];
  session.on("error", value => events.push(value));
  session.on("exit", () => assert.fail("Spawn failure has no exit event"));
  session.on("close", (...value) => events.push(value));
  child.emit("error", error);
  child.emit("close", -2, null);
  assert.deepEqual(events, [error, [-2, null]]);
  assert.equal(session.kill(), false);
});

test("process-state checks select only the owned group and distinguish zombies from unavailable queries", async () => {
  for (const [error, stdout, stderr, expected] of [
    [null, "Z\nZ+\n", "", false], [null, "Z\nS+\n", "", true], [null, "", "", false],
    [{ code: 1 }, "", "", false], [{ code: 1 }, "", "permission denied", null], [{ code: "EPERM" }, "", "", null]
  ]) {
    assert.equal(await hasLiveGroupProcesses(234, (command, args, options, callback) => {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-o", "stat=", "-g", "234"]);
      assert.equal(options.timeout, 1500);
      callback(error, stdout, stderr);
    }), expected);
  }
});

test("zombie-only groups finish even while signal 0 succeeds, and retire all polling", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 345 });
  let probes = 0, inspections = 0;
  const session = trackScriptProcess(child, { pollIntervalMs: 2, zombieCheckIntervalMs: 5,
    kill: () => { probes++; }, inspectProcesses: async pid => { assert.equal(pid, 345); inspections++; return false; } });
  const closed = once(session, "close");
  child.emit("exit", 9, null);
  child.emit("close", 9, null);
  assert.deepEqual(await closed, [9, null]);
  assert.equal(inspections, 1);
  const completedProbes = probes;
  await delay(10);
  assert.equal(probes, completedProbes);
  assert.equal(child.listenerCount("close"), 0);
});

test("an unavailable process-state query does not end a group with a live child", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 456 });
  let alive = true, inspections = 0;
  const session = trackScriptProcess(child, { pollIntervalMs: 2, zombieCheckIntervalMs: 5,
    kill: () => { if (!alive) missing(); }, inspectProcesses: async () => { inspections++; return null; } });
  const exited = once(session, "exit");
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await delay(15);
  assert.ok(inspections >= 1);
  assert.equal(session.exitCode, null);
  alive = false;
  assert.deepEqual(await exited, [0, null]);
});

test("wrapping a real child after exit and pipe close still emits exit then close", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  for (const stdio of ["ignore", ["ignore", "pipe", "pipe"]]) {
    const child = spawn("/bin/sh", ["-c", "exit 13"], { detached: true, stdio });
    await once(child, "close");
    const session = trackScriptProcess(child), events = [];
    session.on("exit", (...args) => events.push(["exit", ...args]));
    const closed = once(session, "close");
    assert.deepEqual(await closed, [13, null]);
    assert.deepEqual(events, [["exit", 13, null]]);
    assert.equal(session.exitCode, 13);
    assert.equal(child.listenerCount("close"), 0);
  }
});

test("a real script remains active until its background game exits", { skip: process.platform === "win32", timeout: 5000 }, async t => {
  const child = spawn("/bin/sh", ["-c", "sleep 0.2 & exit 7"], { detached: true, stdio: "ignore" });
  const session = trackScriptProcess(child, { pollIntervalMs: 10 });
  t.after(() => session.kill("SIGKILL"));
  const exited = once(session, "exit");
  await once(child, "exit");
  assert.equal(child.exitCode, 7);
  assert.equal(session.exitCode, null);
  assert.doesNotThrow(() => process.kill(-session.pid, 0));
  assert.deepEqual(await exited, [7, null]);
  assert.equal(session.exitCode, 7);
});

test("Stop reaches a background child after the script exits and leaves another group alone", { skip: process.platform === "win32", timeout: 5000 }, async t => {
  const unrelated = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const child = spawn("/bin/sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" });
  const session = trackScriptProcess(child, { pollIntervalMs: 10 });
  t.after(() => { session.kill("SIGKILL"); unrelated.kill("SIGKILL"); });
  const exited = once(session, "exit");
  await once(child, "exit");
  assert.equal(session.exitCode, null);
  assert.equal(session.kill("SIGTERM"), true);
  assert.equal(session.killed, true);
  assert.deepEqual(await exited, [0, null]);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});
