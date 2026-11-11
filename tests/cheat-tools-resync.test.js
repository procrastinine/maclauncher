const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("the cheats window follows the record restored after a failed Tools button save", async () => {
  const { toolsOverrideAfterFailure } = await import("../src/renderer/src/ui/cheat-tools-model.mjs");
  const pending = { gamePath: "/Games/A", failed: true };
  const record = override => ({ gamePath: "/Games/A", moduleData: override === undefined ? {} : { toolsButtonVisibleOverride: override } });
  assert.equal(toolsOverrideAfterFailure(pending, record(true)), undefined, "the state still shows the failed choice");
  assert.equal(toolsOverrideAfterFailure(pending, record(false)), false);
  assert.equal(toolsOverrideAfterFailure(pending, record(undefined)), null, "an unset override returns to the module default");
  assert.equal(toolsOverrideAfterFailure({ gamePath: "/Games/A", failed: null }, record(undefined)), undefined);
  assert.equal(toolsOverrideAfterFailure(pending, { ...record(false), gamePath: "/Games/B" }), undefined);
  assert.equal(toolsOverrideAfterFailure(null, record(false)), undefined);
});

test("App records a failed Tools button save and adopts the restored record without resending it", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/App.tsx"), "utf8");
  const save = source.slice(source.indexOf("await api.setGameModuleData(payload.gamePath, {"), source.indexOf("cheatAutoSaveOverrideRef.current = {\n              gamePath: payload.gamePath"));
  assert.match(save, /catch \(error\) \{\s*setCheatToolsFailure\(\{ gamePath: payload\.gamePath, failed: payload\.toolsOverride \}\);\s*throw error;/);
  const follow = source.slice(source.indexOf("const value = toolsOverrideAfterFailure("), source.indexOf("function closeCheats()"));
  assert.match(follow, /cheatAutoSaveOverrideRef\.current = \{ gamePath: cheatToolsFailure\.gamePath, value \}/, "the next edit compares against the record");
  assert.match(follow, /cheatAutoSaveSkipRef\.current = true;\s*setToolsButtonOverride\(value\)/, "adopting the record sends nothing");
});
