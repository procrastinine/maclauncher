const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { stopProcessTree, normalizeShutdownGraceMs, TEMPORARY_PROCESS_MAX_GRACE_MS } = require("../src/core/process-stop");
test("temporary cleanup budgets are bounded and ordinary stop keeps its two-second default", () => {
  assert.equal(TEMPORARY_PROCESS_MAX_GRACE_MS, 15000);
  assert.equal(normalizeShutdownGraceMs(15000), 15000);
  for (const value of [undefined, null, 0, 1999, 15001, Infinity, NaN, "15000"])
    assert.equal(normalizeShutdownGraceMs(value), 2000);
  let delay;
  stopProcessTree(1234, {kill() {}, schedule(_callback, ms) {delay = ms;return {unref() {}};}});
  assert.equal(delay, 2000);
});

test("a child without its own process group falls back to its owned PID, including forced exit", () => {
  const calls = []; let force;
  const kill = (target, signal) => {
    calls.push([target, signal]);
    if (target < 0) throw Object.assign(new Error("No such group"), { code: "ESRCH" });
  };
  assert.equal(stopProcessTree(1234, { kill, schedule: callback => { force = callback; } }), true);
  force();
  assert.deepEqual(calls, [[-1234, "SIGTERM"], [1234, "SIGTERM"], [1234, 0], [1234, "SIGKILL"]]);
});

test("a detached game retains group termination when its parent exits before descendants", () => {
  const calls = []; let force;
  assert.equal(stopProcessTree(2345, { kill: (...args) => calls.push(args), schedule: callback => { force = callback; } }), true);
  force();
  assert.deepEqual(calls, [[-2345, "SIGTERM"], [-2345, 0], [-2345, "SIGKILL"]]);
});

test("an exited child and invalid process identities never schedule or force another target", () => {
  let schedules = 0; const calls = [];
  const options = { kill: (...args) => { calls.push(args); throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, schedule: () => schedules++ };
  for (const pid of [0, -1, null, NaN, 1.1]) assert.equal(stopProcessTree(pid, options), false);
  assert.equal(stopProcessTree(3456, options), false);
  assert.deepEqual(calls, [[-3456, "SIGTERM"], [3456, "SIGTERM"]]);
  assert.equal(schedules, 0);
});

test("a real piped child sharing the test host group is stopped without signaling its host", async t => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],
    { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  assert.equal(stopProcessTree(child.pid, { graceMs: 30 }), true);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
});
