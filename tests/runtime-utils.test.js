const assert = require("node:assert/strict");
const test = require("node:test");

const { pickRuntimeId } = require("../src/main/runtime-utils");

test("pickRuntimeId falls back from native when missing native path", () => {
  const runtime = pickRuntimeId({
    requestedRuntime: "native",
    supported: ["electron", "nwjs", "native"],
    defaultRuntime: "native",
    nativePath: null,
    entry: {},
    moduleSettings: {},
    context: {}
  });

  assert.equal(runtime, "electron");
});

test("pickRuntimeId keeps native when path is available", () => {
  const runtime = pickRuntimeId({
    requestedRuntime: "native",
    supported: ["electron", "native"],
    defaultRuntime: "native",
    nativePath: "/Games/MyGame.app",
    entry: {},
    moduleSettings: {},
    context: {}
  });

  assert.equal(runtime, "native");
});

test("pickRuntimeId respects canLaunchRuntime fallbacks", () => {
  const runtime = pickRuntimeId({
    requestedRuntime: "nwjs",
    supported: ["electron", "nwjs"],
    defaultRuntime: "electron",
    nativePath: null,
    canLaunchRuntime: id => id === "electron",
    entry: {},
    moduleSettings: {},
    context: {}
  });

  assert.equal(runtime, "electron");
});
