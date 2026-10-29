const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createProcessLauncher, spawnDetachedChecked } = require("../src/core/processes");

function fakeLauncher(onUnref = child => child.emit("spawn")) {
  const calls = [];
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => {
    unrefCount += 1;
    assert.ok(child.listenerCount("error") > 0, "error listener must precede unref");
    onUnref(child);
  };
  const launcher = createProcessLauncher({ spawn: (...args) => {
    calls.push(args);
    return child;
  } });
  return { launcher, child, calls, get unrefCount() { return unrefCount; } };
}

test("detached launch defaults to ignored stdio and unref after attaching an error listener", () => {
  const fake = fakeLauncher();
  assert.equal(fake.launcher.spawnDetachedProcess("native-game", ["arg"]), fake.child);
  assert.deepEqual(fake.calls, [["native-game", ["arg"], { stdio: "ignore", detached: true }]]);
  assert.equal(fake.unrefCount, 1);
  assert.doesNotThrow(() => fake.child.emit("error", new Error("late failure")));
});

test("null options and null stdio retain the detached defaults", () => {
  for (const options of [null, { stdio: null, detached: null }]) {
    const fake = fakeLauncher();
    fake.launcher.spawnDetachedProcess("native-game", [], options);
    assert.deepEqual(fake.calls[0][2], { stdio: "ignore", detached: true });
    assert.equal(fake.unrefCount, 1);
  }
});

test("checked launch attaches spawn and rejection listeners before unref and cleans them on success", async () => {
  const fake = fakeLauncher(child => {
    assert.equal(child.listenerCount("spawn"), 1);
    assert.equal(child.listenerCount("error"), 2);
    child.emit("spawn");
  });
  assert.equal(await fake.launcher.spawnDetachedChecked("native-game", []), fake.child);
  assert.equal(fake.unrefCount, 1);
  assert.equal(fake.child.listenerCount("spawn"), 0);
  assert.equal(fake.child.listenerCount("error"), 1);
  assert.doesNotThrow(() => fake.child.emit("error", new Error("post-spawn failure")));
});

test("checked launch rejects a failed spawn emitted during unref without an uncaught error", async () => {
  const failure = Object.assign(new Error("not found"), { code: "ENOENT" });
  const fake = fakeLauncher(child => child.emit("error", failure));
  await assert.rejects(fake.launcher.spawnDetachedChecked("missing-game", []), error => error === failure);
  assert.equal(fake.child.listenerCount("spawn"), 0);
  assert.equal(fake.child.listenerCount("error"), 1);
  assert.doesNotThrow(() => fake.child.emit("error", failure));
});

test("checked launch rejects synchronous spawn validation errors", async () => {
  const failure = new TypeError("invalid executable");
  const launcher = createProcessLauncher({ spawn: () => { throw failure; } });
  await assert.rejects(launcher.spawnDetachedChecked("", []), error => error === failure);
});

test("startup publication failure retires a bound child through its owned Stop callback", async () => {
  const {bindProcessStop} = require("../src/core/process-lifecycle");
  const failure = new Error("publication cancelled"), fake = fakeLauncher();
  fake.child.pid = 1234;fake.child.exitCode = null;fake.child.signalCode = null;
  fake.child.kill = () => assert.fail("bound shutdown must not send the default SIGTERM");
  let stopped = 0;
  const context = {onProcessSpawn(child) {
    bindProcessStop(child, async ({isCurrent}) => {
      assert.equal(isCurrent(), true);stopped += 1;child.exitCode = 0;child.emit("exit", 0, null);
    });
    throw failure;
  }};
  await assert.rejects(fake.launcher.spawnDetachedChecked("native-game", [], {}, false, context), error => error === failure);
  assert.equal(stopped, 1);
});

test("startup cleanup preserves an owned Stop failure without falling back to SIGTERM", async () => {
  const {bindProcessStop} = require("../src/core/process-lifecycle");
  const failure = new Error("publication cancelled"), stopFailure = new Error("quit rejected"), fake = fakeLauncher();
  fake.child.pid = 1234;fake.child.exitCode = null;fake.child.signalCode = null;
  fake.child.kill = () => assert.fail("a bound Stop failure must retain its original ownership");
  await assert.rejects(fake.launcher.spawnDetachedChecked("native-game", [], {}, false, {onProcessSpawn(child) {
    bindProcessStop(child, () => {throw stopFailure;});throw failure;
  }}), error => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === stopFailure);
});

test("wait options preserve stdio, cwd, env, and detached false without unref", async () => {
  const fake = fakeLauncher(() => assert.fail("wait launch must remain referenced"));
  const options = { detached: false, stdio: "inherit", cwd: "/Games/Test", env: { EXAMPLE: "yes" } };
  const pending = fake.launcher.spawnDetachedChecked("native-game", ["arg"], options);
  fake.child.emit("spawn");
  assert.equal(await pending, fake.child);
  assert.deepEqual(fake.calls, [["native-game", ["arg"], options]]);
  assert.equal(fake.unrefCount, 0);
  assert.deepEqual(options, { detached: false, stdio: "inherit", cwd: "/Games/Test", env: { EXAMPLE: "yes" } });
});

test("unchecked launches also honor detached false and explicit stdio arrays", () => {
  const fake = fakeLauncher(() => assert.fail("wait launch must remain referenced"));
  const stdio = ["ignore", "pipe", "pipe"];
  assert.equal(fake.launcher.spawnDetachedProcess("native-game", [], { detached: false, stdio }), fake.child);
  assert.deepEqual(fake.calls[0][2], { detached: false, stdio });
  assert.equal(fake.unrefCount, 0);
});

test("Rosetta wraps the native executable with arch and preserves caller wait options", async () => {
  const fake = fakeLauncher();
  const options = { detached: false, stdio: "inherit", cwd: "/Games/Test", env: {} };
  const pending = fake.launcher.spawnDetachedChecked("/Game/bin/native", ["one", "two"], options, true);
  fake.child.emit("spawn");
  assert.equal(await pending, fake.child);
  assert.deepEqual(fake.calls, [["arch", ["-x86_64", "/Game/bin/native", "one", "two"], options]]);
  assert.equal(fake.unrefCount, 0);
  const detached = fakeLauncher();
  detached.launcher.spawnDetachedProcess("/Game/bin/native", [], { env: {} }, true);
  assert.deepEqual(detached.calls[0], ["arch", ["-x86_64", "/Game/bin/native"], {
    stdio: "ignore", detached: true, env: {}
  }]);
  assert.equal(detached.unrefCount, 1);
});

test("Rosetta starts thin Intel binaries directly to preserve dynamic-library environment", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rosetta-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "runtime"), header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x01000007, 4);
  header.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, header);
  const options = { env: { DYLD_LIBRARY_PATH: "/owned/runtime libraries" } };
  const fake = fakeLauncher();
  fake.launcher.spawnDetachedProcess(executable, ["game.hl"], options, true);
  assert.deepEqual(fake.calls[0], [executable, ["game.hl"], { ...options, detached: true, stdio: "ignore" }]);
});

test("Rosetta architecture selection restores explicit DYLD paths after SIP strips them", () => {
  const fake = fakeLauncher();
  const env = { DYLD_LIBRARY_PATH: "/owned/path with spaces", DYLD_FRAMEWORK_PATH: "/owned/frameworks", OTHER: "ordinary" };
  fake.launcher.spawnDetachedProcess("/not-a-thin-runtime", ["--game"], { env }, true);
  assert.deepEqual(fake.calls[0][1], ["-x86_64", "-e", "DYLD_LIBRARY_PATH=/owned/path with spaces", "-e", "DYLD_FRAMEWORK_PATH=/owned/frameworks", "/not-a-thin-runtime", "--game"]);
  assert.deepEqual(env, { DYLD_LIBRARY_PATH: "/owned/path with spaces", DYLD_FRAMEWORK_PATH: "/owned/frameworks", OTHER: "ordinary" });
});

test("real wait launch resolves on spawn and keeps stdout and exit status available", { timeout: 5000 }, async () => {
  const child = await spawnDetachedChecked(process.execPath, [
    "-e", "setTimeout(() => { process.stdout.write('child output'); process.exit(7); }, 20)"
  ], { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(child.exitCode, null);
  const output = [];
  child.stdout.on("data", data => output.push(data));
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 7, signal: null });
  assert.equal(Buffer.concat(output).toString(), "child output");
});

test("real checked launch rejects a missing executable with ENOENT", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-core-processes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(spawnDetachedChecked(path.join(root, "missing"), []), { code: "ENOENT" });
});

test("real unchecked failed spawn does not crash its Node caller", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-core-unchecked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `
    const { spawnDetachedProcess } = require(${JSON.stringify(require.resolve("../src/core/processes"))});
    spawnDetachedProcess(${JSON.stringify(path.join(root, "missing"))}, []);
    setTimeout(() => process.stdout.write("survived"), 20);
  `;
  const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "survived");
});
