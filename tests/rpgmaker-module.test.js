const assert = require("node:assert/strict");
const test = require("node:test");

const RpgmakerModule = require("../src/modules/shared/mvmz/rpgmaker-module");

const manifest = {
  id: "example",
  family: "example",
  label: "Example",
  shortLabel: "Ex",
  gameType: "web",
  runtime: {
    default: "electron",
    supported: ["electron"],
    entries: {
      electron: {
        label: "MacLauncher",
        settings: {
          defaults: {
            enableProtections: true
          },
          fields: [
            {
              key: "enableProtections",
              type: "boolean",
              label: "Enable protections"
            }
          ]
        }
      }
    }
  },
  supports: {
    cheats: false,
    cheatsPatcher: false,
    saveEditing: false
  },
  settingsDefaults: {}
};

const mod = RpgmakerModule.buildRpgmakerModule({
  manifest,
  engineId: "example",
  saveExtension: "save"
});

test("normalizeRuntimeId maps legacy values", () => {
  assert.equal(RpgmakerModule.normalizeRuntimeId("embedded"), "electron");
  assert.equal(RpgmakerModule.normalizeRuntimeId("external"), "nwjs");
  assert.equal(RpgmakerModule.normalizeRuntimeId("electron"), "electron");
  assert.equal(RpgmakerModule.normalizeRuntimeId("nwjs"), "nwjs");
  assert.equal(RpgmakerModule.normalizeRuntimeId("native"), "native");
  assert.equal(RpgmakerModule.normalizeRuntimeId("custom"), "custom");
  assert.equal(RpgmakerModule.normalizeRuntimeId(""), "electron");
});

test("migrateSettings maps legacy defaults and runtime settings", () => {
  const settings = {
    defaults: {
      rpgmaker: {
        toolsButtonVisible: false,
        defaultRuntime: "nwjs"
      }
    },
    nwjs: {
      defaultVersion: "0.80.0",
      defaultVariant: "sdk"
    }
  };

  mod.migrateSettings(settings);

  assert.equal(settings.modules.example.toolsButtonVisible, false);
  assert.equal(settings.modules.example.defaultRuntime, "nwjs");
  assert.equal(settings.runtimes.nwjs.defaultVersion, "0.80.0");
});

test("migrateEntry maps legacy runtime and module fields", () => {
  const entry = {
    toolsButtonVisibleOverride: true,
    libVersions: { core: "1" },
    nwjsVersion: "v0.80.0",
    nwjsVariant: "sdk",
    runtime: "nwjs"
  };

  const migrated = mod.migrateEntry(entry);

  assert.equal(migrated.runtimeId, "nwjs");
  assert.deepEqual(migrated.moduleData, {
    toolsButtonVisibleOverride: true,
    libVersions: { core: "1" }
  });
  assert.equal(migrated.runtimeData.nwjs.version, "0.80.0");
  assert.equal(migrated.runtimeData.nwjs.variant, "sdk");
});

test("migrateEntry normalizes unknown variant to sdk", () => {
  const entry = {
    nwjsVersion: "0.80.0",
    nwjsVariant: "weird"
  };

  const migrated = mod.migrateEntry(entry);
  assert.equal(migrated.runtimeData.nwjs.variant, "sdk");
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
