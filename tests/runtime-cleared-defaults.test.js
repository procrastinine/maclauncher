const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withoutClearedDefaults, mergeSettingsChanges } = require("../src/core/settings-merge");
const { createLauncher } = require("../src/core/launcher");

test("a cleared runtime default is the absence of a saved default", () => {
  const runtimes = {
    siglus: { defaultVersion: null }, love: { defaultVersion: "" }, mkxpz: { defaultVersion: "auto", keep: 1 },
    godot: { defaultVersion: "4.6-stable" }, onsyuri: { mac: { defaultVersion: null }, web: { defaultVersion: "1.2.3" } }
  };
  assert.deepEqual(withoutClearedDefaults(runtimes), {
    siglus: {}, love: {}, mkxpz: { keep: 1 }, godot: { defaultVersion: "4.6-stable" }, onsyuri: { mac: {}, web: { defaultVersion: "1.2.3" } }
  });
  assert.equal(withoutClearedDefaults(undefined), undefined);
});

test("launcher settings never present a cleared default to runtime selection", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-cleared-defaults-"));
  try {
    fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ runtimes: { siglus: { defaultVersion: null }, love: { defaultVersion: "11.5" } } }));
    const launcher = createLauncher({ userDataDir });
    const settings = launcher.loadSettings();
    assert.equal(Object.hasOwn(settings.runtimes.siglus, "defaultVersion"), false);
    assert.equal(settings.runtimes.love.defaultVersion, "11.5");
    // Clearing through an ordinary settings change stores no default either.
    const merged = mergeSettingsChanges(settings, { ...settings, runtimes: { ...settings.runtimes, love: { defaultVersion: null } } }, settings);
    assert.deepEqual(withoutClearedDefaults(merged.runtimes).love, {});
  } finally { fs.rmSync(userDataDir, { recursive: true, force: true }); }
});
