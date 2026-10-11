const assert = require("node:assert/strict");
const test = require("node:test");

const RpgmakerModule = require("../src/modules/shared/mvmz/rpgmaker-module");

test("normalizeRuntimeId lowercases input and falls back", () => {
  assert.equal(RpgmakerModule.normalizeRuntimeId("Electron"), "electron");
  assert.equal(RpgmakerModule.normalizeRuntimeId("NWJS"), "nwjs");
  assert.equal(RpgmakerModule.normalizeRuntimeId("native"), "native");
  assert.equal(RpgmakerModule.normalizeRuntimeId("custom"), "custom");
  assert.equal(RpgmakerModule.normalizeRuntimeId(""), "electron");
  assert.equal(RpgmakerModule.normalizeRuntimeId(null, "nwjs"), "nwjs");
});

test("buildPatchedConfig gates Kawariki scripts and vars by engine and version", () => {
  const mvConfig = RpgmakerModule.buildPatchedConfig({
    engineId: "mv",
    runtimeSettings: {
      enableRemapFixes: true,
      enableVarsInspector: true,
      enableDecryptedAssets: true
    },
    nwVersion: "0.103.1"
  });
  assert.ok(mvConfig.modules.includes("rpg-inject.mjs"));
  assert.ok(mvConfig.modules.includes("rpg-remap.mjs"));
  assert.ok(mvConfig.modules.includes("rpg-fixes.mjs"));
  assert.ok(mvConfig.modules.includes("rpg-vars.mjs"));
  assert.ok(mvConfig.scripts.includes("mv-decrypted-assets.js"));

  const mzConfig = RpgmakerModule.buildPatchedConfig({
    engineId: "mz",
    runtimeSettings: { enableDecryptedAssets: true },
    nwVersion: "0.103.1"
  });
  assert.ok(mzConfig.scripts.includes("mz-decrypted-assets.js"));
  assert.ok(!mzConfig.scripts.includes("mv-decrypted-assets.js"));

  const legacyConfig = RpgmakerModule.buildPatchedConfig({
    engineId: "mv",
    runtimeSettings: { enableVarsInspector: true },
    nwVersion: "0.56.0"
  });
  assert.ok(!legacyConfig.modules.includes("rpg-vars.mjs"));

  const otherConfig = RpgmakerModule.buildPatchedConfig({
    engineId: "other",
    runtimeSettings: { enableDecryptedAssets: true },
    nwVersion: "0.103.1"
  });
  assert.equal(otherConfig.scripts.length, 0);
});
