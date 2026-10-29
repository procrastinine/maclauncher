const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => {resolve = yes;});return {promise, resolve}; }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-import-lifecycle-"))), source = path.join(root, "Source.zip");
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));fs.writeFileSync(source, "original source");
  const main = fs.readFileSync(require.resolve("../src/main/main"), "utf8"), gate = deferred(), calls = {imports: 0, refresh: 0, quit: 0, exits: 0, cleanup: 0, flush: 0};let quitHandler;
  const context = {fs, AbortController, graphicsImportsClosing: false, graphicsImportControllers: new Map(), importProgress: new Map(), userDataDir: root,
    require: name => {
      assert.equal(name, "../modules/shared/effects/prepared-rows");
      return {flush() {assert.equal(calls.quit, 0, "Prepared rows persist before app exit");calls.flush++;}};
    },
    getRuntimeManager: () => ({}), loadSettings: () => ({}), settingsCoordinator: {applySettings: async () => {}}, broadcastActivity() {},
    refreshRuntimeSnapshots: async () => {calls.refresh++;},
    runRuntimeManagerAction: async options => {
      calls.imports++;calls.signal = options.prerequisiteContext.signal;
      try {await gate.promise;calls.signal.throwIfAborted();return {modelPath: "/managed/model.dlssmodel"};}
      finally {calls.cleanup++;}
    },
    app: {on: (_event, handler) => {quitHandler = handler;}, quit: () => {calls.quit++;requestQuit();}},
    gameImports: {list: () => [], cancel: () => assert.fail("direct picker is independent of game import queue")},
    externalStores: {hasActive: () => false, dispose: async () => {}},
    steamWindow: {snapshot: () => ({downloads: []}), dispose: async () => {}},
    microgAccounts: {hasPending: () => false, dispose: async () => {}}, googleAccountProcesses: new Set(),
    googleAccountController: new AbortController(), googlePlayAuth: {dispose() {}},
    backendService: {beginShutdown() {}, hasTemporaryProcesses: () => false, hasPendingOperations: () => false, shutdownTemporaryProcesses: async () => {}},
    logger: {hasPending: () => false, flush: async () => {}}
  };
  function requestQuit() {let prevented = false;quitHandler({preventDefault: () => {prevented = true;}});if (!prevented) calls.exits++;return prevented;}
  const start = main.indexOf("async function importNeuralModelFile("), end = main.indexOf("async function openGamesFromMenu()", start);
  vm.runInNewContext(main.slice(start, end), context);
  const quitStart = main.indexOf("let quitCleanupPending"), quitEnd = main.indexOf('\nipcMain.handle("launcher:forgetGame"', quitStart);
  vm.runInNewContext(main.slice(quitStart, quitEnd), context);
  return {root, source, context, gate, calls, requestQuit};
}
test("quit aborts a direct picker import and awaits cleanup before exit without refreshing closed workers", async t => {
  const f = fixture(t), imported = f.context.importNeuralModelFile(f.source), failed = assert.rejects(imported, {name: "AbortError"});
  await flush();assert.equal(f.calls.imports, 1);
  assert.equal(f.requestQuit(), true);assert.equal(f.calls.signal.aborted, true);assert.equal(f.requestQuit(), true);
  assert.equal(f.calls.flush, 1, "Repeated quit requests persist prepared rows once");
  await flush();assert.equal(f.calls.quit, 0);assert.equal(f.calls.cleanup, 0);
  f.gate.resolve();await failed;await flush();
  assert.equal(f.calls.cleanup, 1);assert.equal(f.calls.refresh, 0);assert.equal(f.calls.quit, 1);assert.equal(f.calls.exits, 1);
  assert.equal(f.context.graphicsImportControllers.size, 0);assert.equal(f.context.importProgress.size, 0);
  assert.equal(fs.readFileSync(f.source, "utf8"), "original source");
  await assert.rejects(f.context.importNeuralModelFile(f.source), {name: "AbortError"});assert.equal(f.calls.imports, 1);
});
test("duplicate canonical and aliased requests share one cancellable import and retain ownership until settlement", async t => {
  const f = fixture(t), alias = path.join(f.root, "Alias.zip");fs.symlinkSync(f.source, alias);
  const first = f.context.importNeuralModelFile(f.source), second = f.context.importNeuralModelFile(alias);
  const settled = Promise.allSettled([first, second]);await flush();assert.equal(f.calls.imports, 1);
  assert.equal(f.context.graphicsImportControllers.get(f.source), f.context.graphicsImportControllers.get(alias));
  f.context.graphicsImportControllers.get(alias).abort();
  assert.equal(f.context.graphicsImportControllers.size, 2);f.gate.resolve();
  assert.deepEqual((await settled).map(row => row.status), ["rejected", "rejected"]);
  assert.equal(f.calls.cleanup, 1);assert.equal(f.calls.refresh, 0);assert.equal(f.context.graphicsImportControllers.size, 0);
  assert.equal(f.calls.flush, 0, "Import cancellation alone does not flush shutdown state");
});
test("quit before the first import microtask starts still cancels and drains its registered operation", async t => {
  const f = fixture(t), imported = f.context.importNeuralModelFile(f.source), failed = assert.rejects(imported, {name: "AbortError"});
  assert.equal(f.requestQuit(), true);await failed;await flush();
  assert.equal(f.calls.flush, 1);
  assert.equal(f.calls.imports, 0);assert.equal(f.calls.quit, 1);assert.equal(f.context.graphicsImportControllers.size, 0);
});
test("normal direct import completion refreshes once and clears all aliases without modifying its source", async t => {
  const f = fixture(t), first = f.context.importNeuralModelFile(f.source), second = f.context.importNeuralModelFile(f.source);
  f.gate.resolve();assert.deepEqual(await first, await second);
  assert.equal(f.calls.imports, 1);assert.equal(f.calls.refresh, 1);assert.equal(f.context.graphicsImportControllers.size, 0);
  assert.equal(fs.readFileSync(f.source, "utf8"), "original source");assert.equal(f.requestQuit(), false);
  assert.equal(f.calls.flush, 1, "Immediate normal quit still persists prepared rows");
});
