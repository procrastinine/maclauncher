const assert = require("node:assert/strict");
const test = require("node:test");

const { mergeDetectedEntry } = require("../src/main/launch-utils");

test("mergeDetectedEntry merges module/runtime data and preserves overrides", () => {
  const existing = {
    gamePath: "/old",
    moduleData: { a: 1, shared: "old" },
    runtimeData: { r: 1 },
    saveDirOverride: "/saves",
    cheats: { enabled: true },
    runtimeId: "mkxpz",
    runtime: "legacy"
  };
  const detected = {
    gamePath: "/new",
    name: "New",
    moduleData: { shared: "new", b: 2 },
    runtimeData: { r: 2, extra: 3 }
  };

  const merged = mergeDetectedEntry(existing, detected, { now: 123 });

  assert.equal(merged.gamePath, "/new");
  assert.deepEqual(merged.moduleData, { a: 1, shared: "new", b: 2 });
  assert.deepEqual(merged.runtimeData, { r: 2, extra: 3 });
  assert.equal(merged.saveDirOverride, "/saves");
  assert.deepEqual(merged.cheats, { enabled: true });
  assert.equal(merged.runtimeId, "mkxpz");
  assert.equal(merged.lastPlayedAt, 123);
});

test("mergeDetectedEntry respects legacy runtime fields", () => {
  const merged = mergeDetectedEntry({ runtime: "legacy" }, { runtime: "detected" }, { now: 42 });

  assert.equal(merged.runtimeId, "legacy");
  assert.equal(merged.lastPlayedAt, 42);
});
