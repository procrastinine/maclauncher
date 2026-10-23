const test = require("node:test"), assert = require("node:assert/strict");
const Binding = require("../src/modules/shared/reshade/launch-binding");
const {warningsForLaunch} = require("../src/main/graphics-launch-status");

test("fallback notices belong to the newly spawned game and never an older launch", t => {
  const record = {schema: 1, phase: "spawned", launchId: "current", pid: 41,
    graphicsWarnings: [{id: "legacy-neural", kind: "neural", method: "mlx-dlss", reason: "Neural rendering is unavailable."}]};
  t.mock.method(Binding, "read", () => record);
  assert.deepEqual(warningsForLaunch({}, {previousLaunchId: "old", pid: 41}), ["Neural rendering is unavailable."]);
  assert.deepEqual(warningsForLaunch({}, {previousLaunchId: "current", pid: 41}), []);
  assert.deepEqual(warningsForLaunch({}, {previousLaunchId: "old", pid: 42}), []);
  record.phase = "prepared";
  assert.deepEqual(warningsForLaunch({}, {previousLaunchId: "old", pid: 41}), []);
});

test("successful or absent graphics preparation has no fallback notice", t => {
  const read = t.mock.method(Binding, "read", () => null);
  assert.deepEqual(warningsForLaunch({}, {}), []);
  read.mock.mockImplementation(() => ({phase: "spawned", launchId: "new", graphicsWarnings: []}));
  assert.deepEqual(warningsForLaunch({}, {}), []);
});

test("whole-preparation failure remains visible without a graphics publication and ignores older launch warnings", t => {
  const reason = "Graphics processing is unavailable. The game is using its original rendering. Shader missing.";
  const read = t.mock.method(Binding, "read", () => null);
  assert.deepEqual(warningsForLaunch({}, {preparationWarnings: [reason]}), [reason]);
  read.mock.mockImplementation(() => ({phase: "spawned", launchId: "old", pid: 41,
    graphicsWarnings: [{reason: "An older neural stage was skipped."}]}));
  assert.deepEqual(warningsForLaunch({}, {previousLaunchId: "old", pid: 42, preparationWarnings: [reason, null, ""]}), [reason]);
});
