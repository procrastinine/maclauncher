const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const manifest = require("../src/modules/crossover/main").manifest;
const { composeRuntimeProviders } = require("../src/modules/shared/runtime/providers");
const { createRuntimeSettingsStore, resolveRuntimeSettingsSchema, buildRuntimeSettingsDefaults } = require("../src/core/runtime-settings");

test("Windows metadata registers a managed Wine choice without changing the game type or local CrossOver settings", () => {
  assert.equal(manifest.id, "crossover");
  assert.equal(manifest.gameType, "windows");
  assert.equal(manifest.runtime.default, "sikarugir");
  assert.equal(manifest.settingsDefaults.defaultRuntime, "sikarugir");
  assert.deepEqual(manifest.runtime.supported, ["sikarugir", "crossover"]);
  assert.equal(manifest.runtime.manager.sikarugir, "sikarugir");
  assert.equal(manifest.runtime.manager.crossover, "crossover");
  assert.equal(manifest.runtime.managerUi.sikarugir.tabLabel, "Sikarugir");
  assert.equal(manifest.runtime.managerUi.sikarugir.management, "managed");
  assert.equal(manifest.runtime.managerUi.crossover.tabLabel, "CrossOver");
  assert.equal(manifest.runtime.managerUi.crossover.groupId, "crossover");
  assert.equal(manifest.runtime.managerUi.crossover.sectionLabel, "CrossOver");
  assert.equal(manifest.runtime.managerUi.sikarugir.groupId, "sikarugir");
  assert.equal(manifest.runtime.managerUi.sikarugir.sectionLabel, "Sikarugir");
  assert.equal(manifest.ui.actions.some(action => action.id === "runtimeStatus"), false);
  assert.ok(manifest.ui.actions.some(action => action.id === "revealWindowsFiles"));
  const wine = buildRuntimeSettingsDefaults(resolveRuntimeSettingsSchema(manifest, "sikarugir"));
  assert.equal(wine.graphicsBackend, "auto");
  assert.equal(wine.vulkanBackend, "auto");
  assert.equal(wine.cncDdraw, false);
  assert.equal(wine.windowsVersion, "win10");
  assert.deepEqual(wine.environment, []);
  const synchronization = manifest.runtime.entries.sikarugir.settings.fields.find(field => field.key === "synchronization");
  assert.deepEqual(synchronization.options.map(option => option.value), ["auto", "msync", "off"]);
  const crossover = buildRuntimeSettingsDefaults(resolveRuntimeSettingsSchema(manifest, "crossover"));
  assert.equal(crossover.bottleTemplate, "win10_64");
  assert.equal(crossover.synchronization, "auto");
  assert.equal(crossover.vulkanBackend, undefined);
});

test("managed Wine defaults survive storage and combine with per-engine and per-game overrides", t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-runtime-settings-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const store = createRuntimeSettingsStore({ userDataDir });
  const defaults = store.writeDefaults("sikarugir", manifest, {
    graphicsBackend: "dxvk", vulkanBackend: "moltenvk", locale: "ja_JP.UTF-8", windowsVersion: "win7",
    synchronization: "msync", cncDdraw: true, executable: "bin/Game.exe", bepInExWinhttp: true,
    dllOverrides: "winhttp=n,b\nd3d11=n,b", environment: "GAME_FLAGS=a,b\nLANGUAGE=ja",
    arguments: "--title=a,b\nwindowed", wineDebug: "-all,+seh", graphicsBridgeVersion: "1.0.21"
  });
  assert.deepEqual(defaults.dllOverrides, ["winhttp=n,b", "d3d11=n,b"]);
  assert.deepEqual(defaults.environment, ["GAME_FLAGS=a,b", "LANGUAGE=ja"]);
  assert.deepEqual(defaults.arguments, ["--title=a,b", "windowed"]);
  const restored = createRuntimeSettingsStore({ userDataDir });
  assert.deepEqual(restored.readDefaults("sikarugir", manifest), defaults);
  const native = { id: "rgss", manifest: { id: "rgss", runtime: { default: "mkxpz", supported: ["mkxpz"] } } };
  const info = composeRuntimeProviders(native, [{ runtimeId: "sikarugir", managerId: "sikarugir",
    runtime: manifest.runtime.entries.sikarugir, supportsEntry: () => true, launchRuntime: () => {} }]).manifest;
  assert.equal(info.runtime.default, "mkxpz");
  const selected = restored.resolveForEntry({ moduleId: "rgss", runtimeId: "sikarugir", runtimeSettings: {
    sikarugir: { graphicsBackend: "wined3d", bepInExWinhttp: false, arguments: ["-fullscreen"] }
  } }, { modules: { rgss: { runtimeSettings: { sikarugir: { synchronization: "off" } } } } }, info, "sikarugir");
  assert.equal(selected.graphicsBackend, "wined3d");
  assert.equal(selected.synchronization, "off");
  assert.equal(selected.bepInExWinhttp, false);
  assert.equal(selected.cncDdraw, true);
  assert.equal(selected.locale, "ja_JP.UTF-8");
  assert.equal(selected.windowsVersion, "win7");
  assert.equal(selected.graphicsBridgeVersion, "1.0.21");
  assert.deepEqual(selected.arguments, ["-fullscreen"]);
  assert.deepEqual(selected.dllOverrides, ["winhttp=n,b", "d3d11=n,b"]);
  assert.deepEqual(restored.readDefaults("sikarugir", manifest), defaults);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes", "crossover", "settings.json")), false);
});

test("Windows runtime status follows the selected provider and reports its readable snapshot label", t => {
  const module = require("../src/modules/crossover/main");
  const wine = require("../src/modules/crossover/sikarugir/runtime/manager");
  const crossover = require("../src/modules/crossover/runtime/manager");
  const settings = { runtimes: { sikarugir: { defaultVersion: "selected-snapshot" } } };
  const runtimeSettings = { graphicsBackend: "dxmt" };
  const userDataDir = path.join(os.tmpdir(), "windows-status");
  const calls = [];
  t.mock.method(wine, "resolveSelection", (entry, selectedSettings, directory, options) => {
    calls.push("sikarugir");
    assert.equal(selectedSettings, settings);
    assert.equal(directory, userDataDir);
    assert.equal(options, runtimeSettings);
    return { ready: true, version: "selected-snapshot", versionLabel: "11.0 · support 1.0.21",
      install: { executablePath: "/selected/wine", engineVersion: "11.0_1" } };
  });
  t.mock.method(crossover, "resolveSelection", () => {
    calls.push("crossover");
    return { ready: true, version: "local-app", install: { executablePath: "/local/wine", upstreamVersion: "26.3" } };
  });
  const entry = { runtimeId: "crossover" };
  const context = { settings, userDataDir, runtimeSettings, runtimeId: "sikarugir" };
  const selected = module.actions.runtimeStatus(entry, {}, context);
  assert.equal(selected.install.executablePath, "/selected/wine");
  assert.equal(selected.versionLabel, "11.0 · support 1.0.21");
  const local = module.actions.runtimeStatus(entry, {}, { ...context, runtimeId: "crossover" });
  assert.equal(local.versionLabel, "26.3");
  assert.deepEqual(calls, ["sikarugir", "crossover"]);
});
