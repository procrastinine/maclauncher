const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const Compat = require("../src/modules/shared/web/preload/nwjs-compat");
const Construct = require("../src/modules/construct/electron");
const Tyrano = require("../src/modules/tyrano/electron");
const { createRpgmakerElectronRuntime } = require("../src/modules/shared/mvmz/rpgmaker-electron");

test("RPG plugin CommonJS imports resolve the writable runtime content rather than the canonical original", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mvmz-runtime-content-")), source = path.join(root, "original"), view = path.join(root, "view");
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [directory, value] of [[source, "original"], [view, "private"]]) {
    fs.mkdirSync(path.join(directory, "js/plugins"), { recursive: true });
    fs.writeFileSync(path.join(directory, "js/plugins/value.cjs"), `module.exports = ${JSON.stringify(value)};`);
    fs.writeFileSync(path.join(directory, "index.html"), "fixture");
  }
  globalThis.window = { __maclauncher_cheatsRuntimeInstalled: {}, StorageManager: {
    __maclauncher_patched: true, isLocalMode() { return true; }, save() {}, localFileDirectoryPath() { return ""; }
  } };
  globalThis.document = { currentScript: { src: "http://127.0.0.1:32000/js/plugins/caller.js" } };
  createRpgmakerElectronRuntime({ engineId: "mv" }).install({ config: { gameDir: source, contentRootDir: view,
    indexHtml: path.join(view, "index.html") }, webFrame: { executeJavaScript: () => Promise.resolve() } });
  assert.equal(window.require("./value.cjs"), "private");
});

test("browser UMD libraries use browser globals while required Node modules keep CommonJS", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electron-browser-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeModule = path.join(root, "module.cjs"); fs.writeFileSync(nodeModule, "module.exports = { answer: 42 };\n");
  const target = vm.createContext({ module: { exports: {} }, exports: {}, jQuery: {}, require: () => { throw Error("jquery is a browser script"); } });
  const library = `(function(root, factory) {
    if (typeof module === "object" && module.exports) factory(require("jquery"));
    else factory(root.jQuery);
  })(this, function(jquery) { jquery.pluginInstalled = true; });`;
  assert.throws(() => vm.runInContext(library, target), /browser script/);
  Compat.prepareBrowserGlobals(target);
  vm.runInContext(library, target);
  assert.equal(target.jQuery.pluginInstalled, true);
  assert.deepEqual(require(nodeModule), { answer: 42 });
});

test("Construct, Tyrano and RPG adapters share the NW window IPC facade", () => {
  for (const adapter of [Construct, Tyrano, createRpgmakerElectronRuntime({ engineId: "mv" }), createRpgmakerElectronRuntime({ engineId: "mz" })]) {
    const sent = [], exposed = {}, versions = {};
    const context = { config: { manifest: { name: "authored-game" }, nwjsVersion: "0.117.0" }, process: { versions },
      ipcRenderer: { send: (...args) => sent.push(args) }, exposeInMainWorld: (name, value) => { exposed[name] = value; } };
    const setup = adapter.setup(context), shim = setup.requireOverrides["nw.gui"];
    assert.equal(setup.requireOverrides.nw, shim); assert.equal(exposed.nw, shim);
    assert.equal(shim.App.manifest, context.config.manifest);
    assert.equal(shim.Window.get(), shim.Window.get());
    shim.Window.get().show(); shim.Window.get().resizeTo(256, 240); shim.Window.get().close();
    assert.deepEqual(sent, [["maclauncher:window:show"], ["maclauncher:window:resizeTo", 256, 240, { mode: "outer" }], ["maclauncher:debug:closeWindow"]]);
    assert.equal(versions.nw, "0.117.0");
  }
});

test("NW window compatibility does not invent a runtime version when none is known", () => {
  for (const nwjsVersion of [undefined, "", "not-a-version"]) {
    const sent = [], versions = { electron: "44.0.0" }, target = {};
    const setup = Compat.setupNwjsCompatibility({ config: { nwjsVersion }, process: { versions },
      ipcRenderer: { send: (...args) => sent.push(args) } }, target);
    assert.deepEqual(versions, { electron: "44.0.0" });
    setup.requireOverrides["nw.gui"].Window.get().show();
    assert.deepEqual(sent, [["maclauncher:window:show"]]);
  }
  const versions = { nw: "0.103.1", "node-webkit": "0.103.1" };
  Compat.setupNwjsCompatibility({ config: { nwjsVersion: "0.115.0" }, process: { versions }, ipcRenderer: { send() {} } }, {});
  assert.deepEqual(versions, { nw: "0.103.1", "node-webkit": "0.103.1" });
});

test("a page reload skips the legacy close callback and App.quit", () => {
  let beforeUnload, closed = 0;
  const target = { addEventListener: (event, listener) => { assert.equal(event, "beforeunload"); beforeUnload = listener; } };
  const setup = Compat.setupNwjsCompatibility({ config: {}, ipcRenderer: { send: () => closed++ } }, target);
  const shim = setup.requireOverrides["nw.gui"];
  shim.Window.get().on("close", () => shim.App.quit());
  target.__maclauncher_reloading = true; beforeUnload(); assert.equal(closed, 0);
  target.__maclauncher_reloading = false; beforeUnload(); assert.equal(closed, 1);
});

test("legacy fullscreen calls reach the host without aborting game startup", () => {
  const sent = [];
  const setup = Compat.setupNwjsCompatibility({ config: {}, ipcRenderer: { send: (...args) => sent.push(args) } }, {});
  const win = setup.requireOverrides["nw.gui"].Window.get();
  win.enterFullscreen(); win.leaveFullscreen(); win.toggleFullscreen();
  assert.deepEqual(sent, [["maclauncher:window:setFullScreen", true], ["maclauncher:window:setFullScreen", false], ["maclauncher:window:toggleFullScreen"]]);
});

test("NW compatibility exposes the game's argument array without sharing mutable configuration", () => {
  const gameArguments = ["--windowed", "A name", "", "line\nbreak"];
  const setup = Compat.setupNwjsCompatibility({ config: { gameArguments }, ipcRenderer: { send() {} } }, {});
  const argv = setup.requireOverrides["nw.gui"].App.argv;
  assert.deepEqual(argv, gameArguments);
  argv.push("changed");
  assert.equal(gameArguments.length, 4);
});
