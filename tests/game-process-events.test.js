const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { observeGameProcess } = require("../src/core/game-process-events");

test("a real post-spawn nonzero exit is reported after running state clears", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  const events = [];
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    observeGameProcess(child, {
      onExit: result => events.push(["exit", result.code]),
      onFailure: result => { events.push(["failure", result.code]); resolve(); }
    });
  });
  assert.deepEqual(events, [["exit", 7], ["failure", 7]]);
});

test("normal game quit and explicit Stop clear the run without a failure banner", () => {
  for (const [code, signal, stopped] of [[0, null, false], [null, "SIGTERM", true], [1, null, true]]) {
    const child = new EventEmitter();
    let completions = 0;
    observeGameProcess(child, { isStopping: () => stopped,
      onExit: () => completions++, onFailure: () => assert.fail("normal Stop is not a crash") });
    child.emit("exit", code, signal);
    assert.equal(completions, 1);
  }
});

test("already exited worker descriptors retain failures and do not complete twice", async () => {
  const child = new EventEmitter();
  child.exitCode = 3;
  const exits = [], failures = [];
  observeGameProcess(child, { onExit: result => exits.push(result), onFailure: result => failures.push(result) });
  await Promise.resolve();
  child.emit("exit", 3, null);
  assert.equal(exits.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 3);
});

test("native crashes and post-spawn errors are reported once with their real reason", () => {
  for (const event of ["exit", "error"]) {
    const child = new EventEmitter();
    child.on("error", () => {});
    const failures = [];
    observeGameProcess(child, { onFailure: result => failures.push(result) });
    if (event === "exit") child.emit("exit", null, "SIGSEGV");
    else child.emit("error", new Error("native pipe failed"));
    child.emit("exit", 1, null);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].signal || failures[0].error.message, event === "exit" ? "SIGSEGV" : "native pipe failed");
  }
});

test("runtime completion details arrive after exit without delaying running-state cleanup", () => {
  for (const code of [0, 1]) {
    const child = new EventEmitter(), events = [];
    child.completionDiagnostics = { pending: true };
    observeGameProcess(child, { onExit: () => events.push("exit"),
      onFailure: result => events.push(result.diagnostics.message) });
    child.emit("exit", code, null);
    assert.deepEqual(events, ["exit"]);
    child.completionDiagnostics = { pending: false, message: "IllegalStateException: actual runtime failure" };
    child.emit("diagnostics");
    child.emit("diagnostics");
    assert.deepEqual(events, ["exit", "IllegalStateException: actual runtime failure"]);
    assert.equal(child.listenerCount("diagnostics"), 0);
  }
});

test("completed diagnostics survive early delivery and intentional Stop stays quiet", async () => {
  for (const stopped of [true, false]) {
    const child = new EventEmitter(), failures = [];
    child.exitCode = 1;
    child.completionDiagnostics = { pending: false, message: "Runtime failure" };
    observeGameProcess(child, { isStopping: () => stopped, onFailure: result => failures.push(result) });
    await Promise.resolve();
    assert.equal(failures.length, stopped ? 0 : 1);
    assert.equal(child.listenerCount("diagnostics"), 0);
  }
});

test("native close intent draining after exit is retained without suppressing an unrequested crash", () => {
  for (const requested of [false, true]) {
    const child = new EventEmitter(), failures = [], completions = [];
    child.completionDiagnostics = { pending: true };
    observeGameProcess(child, { isStopping: () => child.stopRequested === true,
      onFailure: result => failures.push(result), onComplete: result => completions.push(result) });
    child.emit("exit", null, "SIGKILL");
    if (requested) child.stopRequested = true;
    child.completionDiagnostics = { pending: false, message: "Optional SDK warning" };
    child.emit("diagnostics");
    assert.equal(failures.length, requested ? 0 : 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].stopped, requested);
  }
});
