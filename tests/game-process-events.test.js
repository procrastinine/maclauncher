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
