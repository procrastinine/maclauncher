const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { installCheatsRuntime } = require("../src/modules/shared/mvmz/cheats/runtime");

test("cheat file polling retries an incomplete write at the same timestamp", t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-cheats-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cheatsFilePath = path.join(root, "cheats.json");
  const window = new EventTarget();
  const api = installCheatsRuntime({
    DEFAULT_CHEATS: { enabled: true, speed: 1 },
    normalizeCheats: raw => ({ enabled: raw?.enabled !== false, speed: Number(raw?.speed) || 1 }),
    cheatsFilePath,
    window,
    document: {},
    enablePatcher: false,
    enableToolsUi: false
  });
  fs.writeFileSync(cheatsFilePath, '{"speed":');
  const timestamp = new Date(Date.now() + 2000);
  fs.utimesSync(cheatsFilePath, timestamp, timestamp);
  t.mock.timers.tick(500);
  assert.equal(api.getCheatsState().speed, 1);
  fs.writeFileSync(cheatsFilePath, '{"enabled":false,"speed":3}');
  fs.utimesSync(cheatsFilePath, timestamp, timestamp);
  t.mock.timers.tick(500);
  assert.equal(api.getCheatsState().speed, 3);
  assert.equal(api.getCheatsState().enabled, false);
});

test("holding the Tools hotkey or composing text does not repeatedly toggle it", t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const window = new EventTarget();
  window.location = {};
  installCheatsRuntime({
    DEFAULT_CHEATS: { enabled: true },
    normalizeCheats: raw => ({ enabled: raw?.enabled !== false }),
    window,
    document: { body: null, getElementById: () => null },
    enableFileSync: false,
    enablePatcher: false
  });
  let toggles = 0;
  window.__maclauncher_toolsUiV2RequestToggle = () => toggles++;
  for (const flags of [{ repeat: true }, { isComposing: true }, {}]) {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: "t", metaKey: true, shiftKey: true, ...flags });
    window.dispatchEvent(event);
  }
  assert.equal(toggles, 1);
});
