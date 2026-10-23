const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const Browser = require("../src/modules/construct/browser-wrapper");
const shim = fs.readFileSync(path.join(__dirname, "../src/modules/construct/webview2-shim.js"), "utf8");

test("declared Construct browser bundles use the same native NW window with linked original content", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "construct-browser-wrapper-")); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const game = path.join(root, "game"); fs.mkdirSync(path.join(game, "www"), {recursive: true});
  const original = '<!doctype html><script type="module" src="scripts/main.js"></script>';
  fs.writeFileSync(path.join(game, "www/index.html"), original);
  fs.writeFileSync(path.join(game, "package.json"), JSON.stringify({name: "browser-game", settings: {"content-mode": "bundle", "distribution-mode": "evergreen"}}));
  const entry = {gameId: "browser-game", gameType: "web", gamePath: game, contentRootDir: game, indexHtml: path.join(game, "www/index.html")};
  const config = Browser.configuration(entry, shim);
  assert.equal(config.readinessFrame.path, "www/index.html"); assert.equal(entry.indexHtml, path.join(game, "www/index.html"));
  for (const [id, launcher] of [["plain", require("../src/modules/shared/web/runtime/nwjs-launcher")], ["patched", require("../src/modules/shared/web/runtime/nwjs-patched-launcher")]]) {
    const wrapper = launcher.buildWrapper({entry: {...config.entry, gameId: id}, moduleId: "construct", userDataDir: path.join(root, "data"), extraFiles: config.extraFiles, patchConfig: {modules: [], scripts: []}});
    const manifest = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json")));
    assert.equal(manifest.main, "__maclauncher/construct-browser.html");
    assert.equal(fs.lstatSync(path.join(wrapper, "www")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(wrapper, "www/index.html"), "utf8"), original);
    assert.doesNotMatch(manifest["chromium-args"] || "", /enable-node-worker|mixed-context/);
    assert.notEqual(manifest.nodejs, false);
  }
  const source = config.extraFiles.find(item => item.path.endsWith("host.js")).contents, listeners = {}, attributes = {}, injected = [];
  const child = {location: {}, document: {}}, frame = {contentWindow: child, setAttribute: (key, value) => {attributes[key] = value;}, addEventListener() {}};
  vm.runInNewContext(source, {nw: {Window: {get: () => ({on: (event, callback) => {listeners[event] = callback;}, eval: (target, text) => injected.push([target, text])})}}, document: {title: "Game", createElement: () => frame, body: {appendChild: value => assert.equal(value, frame)}}});
  assert.equal(Object.hasOwn(attributes, "nwdisable"), true); assert.equal(Object.hasOwn(attributes, "nwfaketop"), false);
  assert.equal(frame.src, "../www/index.html"); listeners["document-start"](frame);
  assert.equal(injected.length, 1); assert.equal(injected[0][1], shim);
  assert.equal(fs.readFileSync(entry.indexHtml, "utf8"), original);
});

test("ordinary NW packages do not acquire a browser frame and WebView2 shim runs without CommonJS", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "construct-browser-gate-")); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = {gamePath: root, indexHtml: path.join(root, "index.html")}; fs.writeFileSync(entry.indexHtml, "original");
  for (const settings of [{}, {"content-mode": "bundle"}, {"distribution-mode": "evergreen"}]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({settings})); assert.equal(Browser.configuration(entry, shim), null);
  }
  const context = vm.createContext({}); vm.runInContext(shim, context);
  assert.equal(vm.runInContext("typeof nw", context), "undefined"); assert.equal(vm.runInContext("typeof require", context), "undefined");
  assert.equal(vm.runInContext("typeof chrome.webview.postMessage", context), "function");
});
