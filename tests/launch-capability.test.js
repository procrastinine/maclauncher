const assert = require("node:assert/strict");
const test = require("node:test");
const { canLaunchEntry } = require("../src/core/launch-capability");

const info = { supports: {}, runtime: { supported: ["runner", "inspect"], entries: { runner: {}, inspect: { launch: false } } } };
test("playback capability does not require an already installed runtime", () => {
  const entry = { moduleData: { format: "reviewed" } };
  assert.equal(canLaunchEntry({ info, entry, runtimeId: "runner", mod: {
    canLaunchRuntime: (_id, game) => game.moduleData.format === "reviewed"
  } }), true);
  assert.equal(canLaunchEntry({ info, entry, runtimeId: "inspect" }), false);
  assert.equal(canLaunchEntry({ info, entry, runtimeId: "missing" }), false);
});
test("module-owned host/format filtering disables unrelated entries without engine branches", () => {
  const mod = {
    filterRuntimeSupport: entry => entry.moduleData?.format === "reviewed" ? ["runner"] : [],
    canLaunchRuntime: (_id, _entry, _settings, context) => context.arch === "arm64"
  };
  const entry = { moduleData: { format: "reviewed" } };
  assert.equal(canLaunchEntry({ info, mod, entry, runtimeId: "runner", context: { arch: "arm64" } }), true);
  assert.equal(canLaunchEntry({ info, mod, entry, runtimeId: "runner", context: { arch: "x64" } }), false);
  assert.equal(canLaunchEntry({ info, mod, entry: { moduleData: { format: "other" } }, runtimeId: "runner", context: { arch: "arm64" } }), false);
  assert.equal(canLaunchEntry({ info: { ...info, supports: { launch: false } }, entry, runtimeId: "runner" }), false);
});
