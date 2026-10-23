const assert = require("node:assert/strict");
const test = require("node:test");

const constructRuntime = require("../src/modules/construct/electron");

function withChrome(tempChrome, fn) {
  const hasChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  try {
    globalThis.chrome = tempChrome;
    fn();
  } finally {
    if (hasChrome) {
      globalThis.chrome = originalChrome;
    } else {
      delete globalThis.chrome;
    }
  }
}

test("construct electron runtime installs WebView2 shim", () => {
  withChrome(undefined, () => {
    constructRuntime.install({});
    assert.ok(globalThis.chrome);
    assert.ok(globalThis.chrome.webview);
    assert.equal(typeof globalThis.chrome.webview.addEventListener, "function");
    assert.equal(typeof globalThis.chrome.webview.postMessage, "function");
  });
});

test("construct electron runtime responds to wrapper init", () => {
  withChrome(undefined, () => {
    constructRuntime.install({});
    let response = null;
    globalThis.chrome.webview.addEventListener("message", event => {
      response = event.data;
    });
    globalThis.chrome.webview.postMessage(
      JSON.stringify({ type: "wrapper-init" })
    );
    assert.deepEqual(response, {
      type: "wrapper-init-response",
      registeredComponentIds: []
    });
  });
});

test("construct electron runtime preserves existing webview", () => {
  const webview = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {}
  };
  withChrome({ webview }, () => {
    constructRuntime.install({});
    assert.equal(globalThis.chrome.webview, webview);
  });
});

test("construct electron runtime replaces non-extensible chrome object", () => {
  const locked = Object.preventExtensions({});
  withChrome(locked, () => {
    constructRuntime.install({});
    assert.ok(globalThis.chrome);
    assert.ok(globalThis.chrome.webview);
    assert.equal(typeof globalThis.chrome.webview.addEventListener, "function");
  });
});

test("construct WebView2 exports do not advertise NW.js or Node-only compatibility", () => {
  const exposed = {}, sent = [], versions = { electron: "44.5.1" };
  const setup = constructRuntime.setup({
    config: { manifest: { settings: { "content-mode": "bundle", "distribution-mode": "evergreen" } } },
    process: { versions },
    ipcRenderer: { send: (...args) => sent.push(args) },
    exposeInMainWorld: (name, value) => { exposed[name] = value; }
  });
  assert.deepEqual(exposed, {});
  assert.deepEqual(setup, {});
  assert.deepEqual(versions, { electron: "44.5.1" });
  assert.deepEqual(sent, []);
});

test("construct NW.js exports and unrecognized manifests retain the window and require facade", () => {
  const manifests = [
    undefined, null, {}, [], "invalid",
    { name: "game", main: "index.html", window: { width: 800, height: 600 } },
    { settings: null }, { settings: [] }, { settings: "invalid" },
    { settings: { "content-mode": "bundle" } },
    { settings: { "distribution-mode": "evergreen" } },
    { settings: { "content-mode": "other", "distribution-mode": "evergreen" } },
    { settings: { "content-mode": "bundle", "distribution-mode": "other" } }
  ];
  for (const manifest of manifests) {
    const exposed = {}, sent = [], versions = {};
    const setup = constructRuntime.setup({
      config: { manifest, nwjsVersion: "0.117.0", gameArguments: ["--windowed"] },
      process: { versions },
      ipcRenderer: { send: (...args) => sent.push(args) },
      exposeInMainWorld: (name, value) => { exposed[name] = value; }
    });
    const shim = setup.requireOverrides["nw.gui"];
    assert.equal(setup.requireOverrides.nw, shim);
    assert.equal(exposed.nw, shim);
    assert.equal(shim.App.manifest, manifest || null);
    assert.deepEqual(shim.App.argv, ["--windowed"]);
    assert.equal(versions.nw, "0.117.0");
    assert.equal(versions["node-webkit"], "0.117.0");
    shim.Window.get().show();
    assert.deepEqual(sent, [["maclauncher:window:show"]]);
  }
});
