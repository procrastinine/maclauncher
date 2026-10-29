const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {EventEmitter, once} = require("node:events"), {PassThrough} = require("node:stream");
const {spawn} = require("node:child_process");
const {captureRuntimeOutput} = require("../src/modules/android/provider-output");
const {observeGameProcess} = require("../src/core/game-process-events");

function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-provider-output-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));return root;
}
function processFixture() {
  const child = new EventEmitter();child.pid = 12345;
  child.stdout = new PassThrough();child.stderr = new PassThrough();return child;
}

test("external Android providers attach output before backend ownership and retain late failure details", async t => {
  const Provider = require("../src/modules/android/provider-main"), Storage = require("../src/modules/android/provider-storage"),
    Policy = require("../src/modules/android/policy"), Packages = require("./helpers/android-packages");
  const root = directory(t), apk = path.join(root, "game.apk"), entry = {gameId: "output-game", gamePath: apk};
  fs.writeFileSync(apk, Packages.zip([["AndroidManifest.xml", Packages.binaryXml(Packages.manifest())]]));
  const cleaned = [], enrolled = [], children = [], previous = async child => {
    assert.equal(child.completionDiagnostics.pending, true, "ownership must not race a missing diagnostic descriptor");
    assert.match(child.completionDiagnostics.logFile, /providers\/(?:aim|macapk)\/runtime\.log$/);
  };
  t.mock.method(require("../src/modules/android/provider-clipboard"), "create", async () => ({socket: "/owned/clipboard",
    enroll: pid => enrolled.push(pid), close: async () => cleaned.push("clipboard")}));
  t.mock.method(require("../src/modules/android/providers/macapk/google-accounts"), "prepareLaunch", async () => null);
  let application;
  for (const id of ["aim", "macapk"]) t.mock.method(require("../src/modules/android/providers/" + id), "prepareLaunch", async () =>
    ({command: "/owned/controller", args: [], application, cleanup: async () => cleaned.push(id)}));
  t.mock.method(Policy, "prepareIsolation", async () => ({command: "/usr/bin/sandbox-exec", args: ["-f", "/owned/sandbox"],
    environment: {HOME: "/owned/home"}, graphics: {RESHADE_EFFECT_PLAN: "/owned/effect-plan"}}));
  for (const scenario of [{id:"aim",application:{executablePath:"/owned/Display.app/Contents/MacOS/Display"},expected:"/owned/Display.app/Contents/MacOS/Display"},
    {id:"macapk",application:{command:"/owned/Game.app/Contents/MacOS/Game"},expected:"/owned/Game.app/Contents/MacOS/Game"},{id:"aim",application:null,expected:null}]) {
    const id=scenario.id;application=scenario.application;
    const original = async () => ({RESHADE_EFFECT_PLAN: "/selected/effect-plan"});
    const context = {userDataDir: root, runtimeId: id, onProcessSpawn: previous, getGameEffectsEnvironment: original,
      spawnDetachedChecked: async (command, args, options, rosetta) => {
        assert.equal(command, "/usr/bin/sandbox-exec");assert.equal(rosetta, false);
        assert.equal(options.graphicsExecutable, scenario.expected);
        assert.equal(options.networkIsolationApplied, true);assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        const child = processFixture();children.push(child);await context.onProcessSpawn(child);
        child.stdout.write("Provider startup output\n");child.stderr.write("Cannot initialize required Android service\n");return child;
      }};
    const child = await Provider.launchRuntime(id, entry, context);
    assert.equal(context.onProcessSpawn, previous);assert.equal(context.getGameEffectsEnvironment, original);
    const failures = [];observeGameProcess(child, {onFailure: result => failures.push(result)});
    child.exitCode = 1;child.emit("exit", 1, null);assert.equal(failures.length, 0);
    child.stderr.end("Final native failure after exit\n");child.stdout.end();child.emit("close", 1, null);
    assert.equal(failures.length, 1);assert.equal(child.completionDiagnostics.pending, false);
    assert.match(failures[0].diagnostics.message, /required Android service/);
    assert.match(failures[0].diagnostics.message, /Final native failure after exit/);
    const storage = Storage.storagePaths(root, entry.gameId, id);
    assert.equal(child.completionDiagnostics.logFile, storage.logFile);
    assert.match(fs.readFileSync(storage.logFile, "utf8"), /Provider startup output/);
    assert.equal(fs.statSync(storage.logFile).mode & 0o777, 0o600);
    assert.equal(child.stdout.listenerCount("data"), 0);assert.equal(child.stderr.listenerCount("data"), 0);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(enrolled.length, 3);assert.deepEqual(cleaned.sort(), ["aim", "aim", "clipboard", "clipboard", "clipboard", "macapk"]);
});

test("large provider output stays bounded and inherited pipes cannot hold diagnostics pending", t => {
  const root = directory(t), child = processFixture();t.mock.timers.enable({apis: ["setTimeout"]});
  captureRuntimeOutput(root).attach(child);
  child.stdout.write(Buffer.alloc(1400 * 1024, 65));child.stderr.write("\u001b[31mFinal failure detail\u001b[0m\0\n");
  let diagnosed = 0;child.on("diagnostics", () => diagnosed++);
  child.emit("exit", 1, null);assert.equal(child.completionDiagnostics.pending, true);
  t.mock.timers.tick(999);assert.equal(child.completionDiagnostics.pending, true);
  t.mock.timers.tick(1);assert.equal(child.completionDiagnostics.pending, false);
  assert.equal(child.completionDiagnostics.message, "Final failure detail");assert.equal(diagnosed, 1);
  child.emit("close", 1, null);assert.equal(diagnosed, 1);
  for (const name of ["runtime.log", "runtime.log.previous"]) assert.ok(fs.statSync(path.join(root, name)).size <= 512 * 1024);
  assert.equal(fs.statSync(path.join(root, "runtime.log.head")).size, 64 * 1024);
  assert.equal(child.stdout.destroyed, true);assert.equal(child.stderr.destroyed, true);
});

test("provider stdout supplies bounded failure details while successful exits do not report stale errors", t => {
  const root = directory(t), child = processFixture();captureRuntimeOutput(root).attach(child);
  child.stdout.write("x".repeat(20000) + "\nOriginal stdout failure\n");child.emit("close", 3, null);
  assert.ok(child.completionDiagnostics.message.length <= 2048);assert.match(child.completionDiagnostics.message, /Original stdout failure/);
  const success = processFixture();captureRuntimeOutput(root).attach(success);
  success.stderr.write("Ordinary startup warning\n");success.emit("close", 0, null);
  assert.equal(success.completionDiagnostics.pending, false);assert.equal(success.completionDiagnostics.message, undefined);
});

test("fast exits, missing mock streams and failed spawns settle without hanging or losing ownership callbacks", async t => {
  const root = directory(t), missing = new EventEmitter();captureRuntimeOutput(root).attach(missing);
  missing.emit("exit", 0, null);assert.equal(missing.completionDiagnostics.pending, false);
  const early = new EventEmitter();early.exitCode = 1;
  captureRuntimeOutput(root).attach(early);assert.equal(early.completionDiagnostics.pending, false);
  const spawnError = new EventEmitter(), output = captureRuntimeOutput(root);output.attach(spawnError);
  spawnError.emit("error", new Error("Controller execution denied"));
  assert.equal(spawnError.completionDiagnostics.pending, false);assert.match(spawnError.completionDiagnostics.message, /execution denied/);
  output.close();
});

test("real CPU child output drains without pipe backpressure deadlock", {timeout: 5000}, async t => {
  const root = directory(t), output = captureRuntimeOutput(root);
  const child = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(2*1024*1024,65));process.stderr.write('Original final controller error\\n');process.exitCode=7"],
    {stdio: ["ignore", "pipe", "pipe"]});
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill(); });
  output.attach(child);await once(child, "close");
  assert.equal(child.exitCode, 7);assert.equal(child.completionDiagnostics.pending, false);
  assert.match(child.completionDiagnostics.message, /Original final controller error/);
  assert.ok(fs.statSync(path.join(root, "runtime.log")).size <= 512 * 1024);
});
