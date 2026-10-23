const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function shutdownFixture({ imports = [], temporary = false, pending = false, logPending = false,
  logFlush = Promise.resolve(), cancel = Promise.resolve(), drain = Promise.resolve() } = {}) {
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = main.indexOf("let quitCleanupPending"), end = main.indexOf('\nipcMain.handle("launcher:forgetGame"', start);
  assert.ok(start >= 0 && end > start, "The actual main-process quit handler must be exercised");
  const calls = { begin: 0, cancel: 0, drain: 0, quit: 0, exit: 0 };
  let handler;
  const requestQuit = () => {
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } });
    if (!prevented) calls.exit++;
    return prevented;
  };
  vm.runInNewContext(main.slice(start, end), {
    app: { on: (event, callback) => { assert.equal(event, "before-quit"); handler = callback; },
      quit: () => { calls.quit++; requestQuit(); } },
    gameImports: { list: () => imports, cancel: () => { calls.cancel++; return cancel; } },
    graphicsImportsClosing: false, graphicsImportControllers: new Map(),
    externalStores: { hasActive: () => false, dispose: async () => {} },
    steamWindow: { snapshot: () => ({downloads: []}), dispose: async () => {} },
    microgAccounts: { hasPending: () => false, dispose: async () => {} },
    googleAccountController: new AbortController(), googleAccountProcesses: new Set(),
    googlePlayAuth: { dispose() {} },
    logger: { hasPending: () => logPending, flush: () => logFlush },
    backendService: { beginShutdown: () => calls.begin++, hasTemporaryProcesses: () => temporary,
      hasPendingOperations: () => pending, shutdownTemporaryProcesses: () => { calls.drain++; return drain; } }
  });
  return { calls, requestQuit };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("repeated quit requests wait for import and temporary-tool cleanup before final exit", async () => {
  const cancellation = deferred(), draining = deferred();
  const fixture = shutdownFixture({ imports: [{ inputPath: "/tmp/game.zip" }], temporary: true,
    cancel: cancellation.promise, drain: draining.promise });
  assert.equal(fixture.requestQuit(), true);
  assert.equal(fixture.requestQuit(), true);
  assert.equal(fixture.requestQuit(), true);
  assert.deepEqual(fixture.calls, { begin: 1, cancel: 1, drain: 1, quit: 0, exit: 0 });
  cancellation.resolve(); await flush();
  assert.equal(fixture.requestQuit(), true); assert.equal(fixture.calls.exit, 0);
  draining.resolve(); await flush();
  assert.deepEqual(fixture.calls, { begin: 1, cancel: 1, drain: 1, quit: 1, exit: 1 });
});

test("quit waits for a pending first inspector and completes after cleanup failures settle", async () => {
  const draining = deferred();
  const fixture = shutdownFixture({ pending: true, drain: draining.promise });
  assert.equal(fixture.requestQuit(), true); assert.equal(fixture.requestQuit(), true);
  draining.reject(new Error("cleanup already completed elsewhere")); await flush();
  assert.deepEqual(fixture.calls, { begin: 1, cancel: 0, drain: 1, quit: 1, exit: 1 });
});

test("quit without imports, pending work or temporary tools remains immediate", () => {
  const fixture = shutdownFixture();
  assert.equal(fixture.requestQuit(), false);
  assert.deepEqual(fixture.calls, { begin: 1, cancel: 0, drain: 0, quit: 0, exit: 1 });
});

test("normal quit waits for the final diagnostic write without repeating cleanup", async () => {
  const output = deferred();
  const fixture = shutdownFixture({ logPending: true, logFlush: output.promise });
  assert.equal(fixture.requestQuit(), true);
  await flush();
  assert.equal(fixture.calls.exit, 0);
  assert.equal(fixture.requestQuit(), true);
  output.resolve(); await flush();
  assert.deepEqual(fixture.calls, { begin: 1, cancel: 0, drain: 1, quit: 1, exit: 1 });
});
