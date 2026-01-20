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
