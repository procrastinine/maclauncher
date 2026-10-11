const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { TOKEN_ENV, PROTOCOL_PREFIX, MAX_DIAGNOSTIC_BYTES, MAX_REPORT_BYTES,
  launchHostedProcess, createHostedStartupReporter } = require("../src/core/hosted-process");
const { runElectronGame } = require("../src/runtime/electron-game");
const { guardHostedOutput } = require("../src/core/hosted-startup-reporter");

function fixture(extra = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 42, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    ref() {}, unref() {}, killed: [], kill(signal) { this.killed.push(signal); return true; } });
  let options;
  const launch = launchHostedProcess({ executable: "/owned/electron", args: ["bootstrap", "--game=fixture"],
    timeoutMs: 1000, ...extra, spawn: async (executable, args, value) => {
      assert.equal(executable, "/owned/electron"); assert.deepEqual(args, ["bootstrap", "--game=fixture"]);
      options = value; return child;
    } });
  const report = record => `${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify({ protocol: 1, ...record })}\n`;
  return { child, launch, report, options: () => options };
}
async function attached() { await new Promise(resolve => setImmediate(resolve)); }
function noStartupListeners(child) {
  for (const event of ["exit", "close", "error"]) assert.equal(child.listenerCount(event), 0, event);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
}

test("hosted startup waits for its loaded-window token and returns the tracked child", async () => {
  const f = fixture(); await attached();
  assert.deepEqual(f.options().stdio, ["ignore", "pipe", "pipe"]);
  let finished = false; f.launch.then(() => { finished = true; });
  f.child.stdout.write(`${PROTOCOL_PREFIX}${"a".repeat(48)} {"protocol":1,"status":"ready","windowId":1,"url":"http://localhost/game"}\n`);
  await attached(); assert.equal(finished, false);
  const ready = f.report({ status: "ready", windowId: 4, url: "http://127.0.0.1:1234/index.html" });
  f.child.stdout.write(ready.slice(0, 15)); await attached(); assert.equal(finished, false);
  f.child.stdout.write(ready.slice(15));
  assert.equal(await f.launch, f.child); assert.deepEqual(f.child.killed, []);
  noStartupListeners(f.child);
});

test("an early host exit returns bounded stderr and removes startup listeners", async () => {
  const diagnostics = [];
  const f = fixture({ onDiagnostics: record => diagnostics.push(record) }); await attached();
  const failure = assert.rejects(f.launch, error => {
    assert.equal(error.code, "HOSTED_STARTUP_EXIT"); assert.equal(error.exitCode, 9);
    assert.ok(Buffer.byteLength(error.stderr) <= MAX_DIAGNOSTIC_BYTES);
    assert.ok(error.message.length <= 601);
    assert.match(error.stderr, /final diagnostic/); return true;
  });
  f.child.stderr.write(Buffer.alloc(MAX_DIAGNOSTIC_BYTES * 3, 0xff));
  f.child.exitCode = 9; f.child.emit("exit", 9, null);
  f.child.stderr.write("\nfinal diagnostic"); f.child.emit("close", 9, null);
  await failure; noStartupListeners(f.child); assert.deepEqual(f.child.killed, []);
  assert.equal(diagnostics.length, 1); assert.match(diagnostics[0].stderr, /final diagnostic/);
  assert.ok(Buffer.byteLength(diagnostics[0].stderr) > 30000);
});

test("a startup timeout terminates only its owned child", async () => {
  const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, calls: [], kill(signal) { this.calls.push(signal); } });
  await assert.rejects(launchHostedProcess({ executable: "/owned/electron", timeoutMs: 15,
    spawn: async () => child }), { code: "HOSTED_STARTUP_TIMEOUT" });
  assert.deepEqual(child.calls, ["SIGKILL"]); noStartupListeners(child);
});

test("a matching-session error and invalid readiness refuse successful startup", async () => {
  for (const record of [{ status: "error", message: "Detection failed" }, { status: "ready", windowId: 1, url: "" }]) {
    const f = fixture(); await attached();
    const failure = assert.rejects(f.launch, error => {
      assert.equal(error.code, record.status === "error" ? "HOSTED_STARTUP_ERROR" : "HOSTED_STARTUP_PROTOCOL");
      assert.match(error.stderr, /trailing host diagnostic/); return true;
    });
    f.child.stdout.write(f.report(record));
    f.child.stderr.write("trailing host diagnostic"); f.child.emit("close", null, "SIGKILL");
    await failure;
    assert.deepEqual(f.child.killed, ["SIGKILL"]); noStartupListeners(f.child);
  }
});

test("module hosts can validate their real loaded-window metadata without weakening the Electron default", async () => {
  const report = { status: "ready", nativeWindowLoaded: true, url: "file:///game/index.html" };
  const strict = fixture(); await attached();
  const rejected = assert.rejects(strict.launch, { code: "HOSTED_STARTUP_PROTOCOL" });
  strict.child.stdout.write(strict.report(report)); strict.child.emit("close", null, "SIGKILL"); await rejected;
  const calls = [];
  const custom = fixture({ validateReady: record => {
    calls.push(record); return record.nativeWindowLoaded === true && typeof record.url === "string" && Boolean(record.url);
  } });
  await attached(); custom.child.stdout.write(custom.report(report));
  assert.equal(await custom.launch, custom.child); assert.equal(calls.length, 1);
  noStartupListeners(custom.child);
});

test("protocol and diagnostic buffers remain bounded under long output", async () => {
  const f = fixture(); await attached();
  f.child.stdout.write("ordinary game output ".repeat(MAX_REPORT_BYTES));
  const failure = assert.rejects(f.launch, { code: "HOSTED_STARTUP_PROTOCOL" });
  f.child.stdout.write(`${PROTOCOL_PREFIX}${f.options().env[TOKEN_ENV]} ${"x".repeat(MAX_REPORT_BYTES * 2)}`);
  await failure; noStartupListeners(f.child);
});

test("startup reporter is optional, sends once, and bounds escaped Unicode errors", () => {
  const output = [];
  const absent = createHostedStartupReporter({ token: "invalid", write: text => output.push(text) });
  assert.equal(absent.enabled, false); absent.ready({}); assert.deepEqual(output, []);
  const reporter = createHostedStartupReporter({ token: "b".repeat(48), write: text => output.push(text) });
  reporter.error(new Error("\u0001漢".repeat(5000))); reporter.ready({ windowId: 1, url: "ignored" });
  assert.equal(output.length, 1);
  const record = output[0].trim().slice(PROTOCOL_PREFIX.length + 49);
  assert.ok(Buffer.byteLength(record) <= MAX_REPORT_BYTES); assert.equal(JSON.parse(record).status, "error");
});

test("detached host output tolerates closed startup pipes and preserves other errors", () => {
  const stream = new EventEmitter();
  guardHostedOutput([stream]); guardHostedOutput([stream]);
  assert.equal(stream.listenerCount("error"), 1);
  for (const code of ["EPIPE", "ECONNRESET"]) {
    assert.doesNotThrow(() => stream.emit("error", Object.assign(new Error("closed pipe"), { code })));
  }
  const failure = Object.assign(new Error("unrelated error"), { code: "EIO" });
  assert.throws(() => stream.emit("error", failure), error => error === failure);
});

test("a real detached child continues after its parent closes both startup pipes", { timeout: 5000 }, async t => {
  const reporter = require.resolve("../src/core/hosted-startup-reporter");
  const source = `
const { createHostedStartupReporter, guardHostedOutput } = require(${JSON.stringify(reporter)});
guardHostedOutput();
createHostedStartupReporter().ready({ windowId: 1, url: "http://127.0.0.1/game" });
setTimeout(() => {
  let closedPipes = 0;
  const written = error => {
    if (error && ["EPIPE", "ECONNRESET"].includes(error.code)) closedPipes++;
    if (closedPipes === 2) setTimeout(() => process.exit(0), 20);
  };
  process.stdout.write("later game stdout", written);
  process.stderr.write("later game stderr", written);
  setTimeout(() => process.exit(2), 500);
}, 100);
`;
  const child = await launchHostedProcess({ executable: process.execPath, args: ["-e", source], timeoutMs: 2000 });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); });
  child.ref();
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.destroy(); child.stderr.destroy();
  assert.deepEqual(await closed, { code: 0, signal: null });
});

function hostedFixture({ loading = false } = {}) {
  const app = new EventEmitter(); Object.assign(app, { setName() {}, getPath: () => "/tmp", setPath() {},
    whenReady: async () => {}, quit() {}, commandLine: { appendSwitch() {} } });
  const win = new EventEmitter(); const webContents = new EventEmitter();
  Object.assign(webContents, { isDestroyed: () => false, isLoadingMainFrame: () => loading,
    getURL: () => "http://127.0.0.1:1234/game" });
  Object.assign(win, { id: 5, webContents, isDestroyed: () => false });
  let complete, hostOptions, hosted;
  const load = new Promise(resolve => { complete = resolve; });
  const reports = [];
  const promise = runElectronGame({ argv: ["--game=/tmp/game", "--runtime=electron"], electron: { app },
    startupReporter: { enabled: true, ready: detail => reports.push({ status: "ready", ...detail }),
      error: error => reports.push({ status: "error", message: error.message }) },
    createLauncher: options => {
      hosted = options.launchHosted;
      return { loadSettings: () => ({}), getLaunchContext: () => ({}), resolveEntry: async () => ({ gamePath: "/tmp/game" }),
        launchEntry: async entry => hosted(entry, "electron", {}) };
    },
    createElectronGameHost: options => {
      hostOptions = options;
      return { installIpc() {}, installMenu() {}, dispose: async () => {}, createGameWindow: async () => {
        hostOptions.onWindowCreated(win); await load; return { win };
      } };
    } });
  return { promise, complete: () => complete(), setLoading: value => { loading = value; }, win, reports };
}

test("standalone Electron host reports ready only after the game-window load completes", async () => {
  const f = hostedFixture(); await attached(); assert.deepEqual(f.reports, []);
  f.complete(); const result = await f.promise; assert.equal(result.result.win, f.win);
  assert.deepEqual(f.reports, [{ status: "ready", windowId: 5, url: "http://127.0.0.1:1234/game" }]);
  assert.equal(f.win.listenerCount("closed"), 0);
  assert.equal(f.win.webContents.listenerCount("did-fail-load"), 0);
  assert.equal(f.win.webContents.listenerCount("render-process-gone"), 0);
  assert.equal(f.win.webContents.listenerCount("did-stop-loading"), 0);
});

test("standalone host waits when loadURL resolves before main-frame loading stops", async () => {
  const f = hostedFixture({ loading: true }); await attached();
  f.complete(); await attached();
  assert.deepEqual(f.reports, []);
  f.win.webContents.emit("did-stop-loading"); await attached();
  assert.deepEqual(f.reports, []);
  f.setLoading(false); f.win.webContents.emit("did-stop-loading");
  const result = await f.promise; assert.equal(result.result.win, f.win);
  assert.equal(f.reports[0].status, "ready");
  assert.equal(f.win.webContents.listenerCount("did-stop-loading"), 0);
});

test("a renderer exit while loading stops rejects startup and clears its listeners", async () => {
  const f = hostedFixture({ loading: true }); await attached();
  f.complete(); await attached();
  const failure = assert.rejects(f.promise, /renderer exited.*crashed/);
  f.win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  await failure;
  assert.equal(f.reports.some(report => report.status === "ready"), false);
  for (const event of ["did-stop-loading", "did-fail-load", "render-process-gone"]) {
    assert.equal(f.win.webContents.listenerCount(event), 0);
  }
});

test("a window closing during startup does not access its destroyed webContents getter", async () => {
  const f = hostedFixture({ loading: true }); await attached();
  f.complete(); await attached();
  const webContents = f.win.webContents;
  Object.defineProperty(f.win, "webContents", { get() { throw new Error("Object has been destroyed"); } });
  const failure = assert.rejects(f.promise, /window closed before it loaded/);
  f.win.emit("closed"); await failure;
  assert.equal(f.reports.some(report => report.status === "ready"), false);
  for (const event of ["did-stop-loading", "did-fail-load", "render-process-gone"]) {
    assert.equal(webContents.listenerCount(event), 0);
  }
});

test("standalone Electron host reports a main-frame load failure before ready", async () => {
  const f = hostedFixture(); await attached();
  f.win.webContents.emit("did-fail-load", {}, -102, "CONNECTION_REFUSED", "http://localhost/game", true);
  assert.equal(f.reports[0].status, "error"); assert.match(f.reports[0].message, /CONNECTION_REFUSED/);
  const failure = assert.rejects(f.promise, /CONNECTION_REFUSED/);
  f.complete(); await failure;
  assert.equal(f.reports.some(report => report.status === "ready"), false);
  assert.equal(f.win.listenerCount("closed"), 0);
});
