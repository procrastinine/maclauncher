const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Rename = require("../src/core/backcompat/kosmickrisp-rename");
const Managed = require("../src/modules/shared/vulkan/managed");
const { KOSMICKRISP_RENAME_MIGRATION } = require("../src/core/data-migration-ids");

const former = "vulkan-kosmickrisp-gles32", version = "27.0.0-devel-MCLv8";
function profile(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kosmickrisp-rename-migration-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  return userDataDir;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const collect = () => { const warnings = []; return { warnings, logger: { warn: (...args) => warnings.push(args.join(" ")) } }; };

test("an old profile's KosmicKrisp settings, runtime defaults and game choices move to the current IDs once", t => {
  const userDataDir = profile(t), { warnings, logger } = collect();
  const settings = {
    launcher: { appearance: "dark" },
    runtimes: { [former]: { defaultVersion: version, defaultArchitecture: "arm64" }, "vulkan-moltenvk": { defaultVersion: "1.3.0" } },
    modules: {
      android: { runtimeSettings: { klepton: { vulkanRuntime: "kosmickrisp:maclauncher-gles32" } } },
      crossover: { runtimeSettings: { crossover: { translatorVulkan: `${former}:${version}` } } },
      anyps5: { runtimeSettings: { anyps5: { vulkanRuntime: "moltenvk:auto" } } }
    }
  };
  const runtimeDefaults = path.join(userDataDir, "runtimes", "anyps5", "settings.json");
  writeJson(runtimeDefaults, { vulkanRuntime: `kosmickrisp-gles32:${version}`, showFps: true });
  const untouched = path.join(userDataDir, "runtimes", "prosper", "settings.json");
  writeJson(untouched, { vulkanRuntime: "kosmickrisp:auto" });
  const untouchedBytes = fs.readFileSync(untouched, "utf8"), before = JSON.stringify(settings), commits = [];
  const migrated = Rename.migrateSettings(settings, { userDataDir, logger, commitSettings: (previous, next) => { commits.push([previous, next]); return next; } });

  assert.deepEqual(migrated.runtimes, { "vulkan-moltenvk": { defaultVersion: "1.3.0" }, [Managed.projectId]: { defaultVersion: version, defaultArchitecture: "arm64" } });
  assert.equal(migrated.modules.android.runtimeSettings.klepton.vulkanRuntime, Managed.selectionId);
  assert.equal(migrated.modules.crossover.runtimeSettings.crossover.translatorVulkan, `${Managed.projectId}:${version}`);
  assert.equal(migrated.modules.anyps5.runtimeSettings.anyps5.vulkanRuntime, "moltenvk:auto");
  assert.equal(migrated.launcher.appearance, "dark");
  assert.deepEqual(migrated.dataMigrations[KOSMICKRISP_RENAME_MIGRATION], { settings: true });
  assert.equal(commits.length, 1); assert.equal(commits[0][0], settings); assert.equal(commits[0][1], migrated);
  assert.equal(JSON.stringify(settings), before, "the saved document is replaced, not changed in place");
  assert.deepEqual(readJson(runtimeDefaults), { vulkanRuntime: `${Managed.projectId}:${version}`, showFps: true });
  assert.equal(fs.readFileSync(untouched, "utf8"), untouchedBytes, "runtime defaults without a former choice are not rewritten");

  const game = { gameId: "g", runtimeData: { [former]: { version, architecture: "x64" }, other: { version: "1" } },
    runtimeSettings: { prosper: { vulkanRuntime: "kosmickrisp-gles32:../invalid", showFps: false }, crossover: { translatorVulkan: `${former}:${version}` } } };
  const entry = Rename.migrateGameEntry(game, { logger });
  assert.deepEqual(entry.runtimeData, { other: { version: "1" }, [Managed.projectId]: { version, architecture: "x64" } });
  assert.deepEqual(entry.runtimeSettings, { prosper: { vulkanRuntime: "auto", showFps: false }, crossover: { translatorVulkan: `${Managed.projectId}:${version}` } });
  assert.equal(warnings.length, 1, "an unreadable saved version becomes Automatic with a warning");

  // A second run changes nothing.
  assert.equal(Rename.migrateSettings(migrated, { userDataDir, logger }), migrated);
  const { dataMigrations, ...unmarked } = migrated;
  assert.equal(Rename.migrateSettings(unmarked, { userDataDir, logger }), unmarked);
  assert.equal(Rename.migrateGameEntry(entry, { logger }), null);
  assert.deepEqual(readJson(runtimeDefaults), { vulkanRuntime: `${Managed.projectId}:${version}`, showFps: true });
  assert.equal(warnings.length, 1);
  assert.equal(commits.length, 1);
});

test("values saved under the current ID stay and unreadable former settings are dropped with a warning", t => {
  const userDataDir = profile(t), { warnings, logger } = collect();
  const current = { defaultVersion: "27.0.0-devel-MCLv12" };
  const both = Rename.migrateSettings({ runtimes: { [former]: { defaultVersion: version }, [Managed.projectId]: current } }, { userDataDir, logger });
  assert.deepEqual(both.runtimes, { [Managed.projectId]: current });
  const unreadable = Rename.migrateSettings({ runtimes: { [former]: { defaultVersion: { version } } } }, { userDataDir, logger });
  assert.deepEqual(unreadable.runtimes, {});
  assert.equal(warnings.length, 1);
  const entry = Rename.migrateGameEntry({ runtimeData: { [former]: { version }, [Managed.projectId]: { version: "27.0.0-devel-MCLv12" } } });
  assert.deepEqual(entry.runtimeData, { [Managed.projectId]: { version: "27.0.0-devel-MCLv12" } });
  assert.equal(Rename.migrateGameEntry({ runtimeSettings: { anyps5: { vulkanRuntime: "auto" } } }), null);
  assert.equal(Rename.migrateGameEntry(null), null);
});

test("each former choice form converts to its current form", () => {
  const { warnings, logger } = collect();
  assert.equal(Rename.convertChoice("kosmickrisp:maclauncher-gles32", logger), "kosmickrisp:maclauncher");
  assert.equal(Rename.convertChoice(`kosmickrisp-gles32:${version}`, logger), `maclauncher-kosmickrisp:${version}`);
  assert.equal(Rename.convertChoice(`${former}:${version}`, logger), `maclauncher-kosmickrisp:${version}`);
  assert.equal(Rename.convertChoice("auto", logger), "auto");
  assert.equal(Rename.convertChoice(former, logger), former, "a bare ID is not a choice");
  assert.equal(Rename.convertChoice(null, logger), null);
  assert.equal(warnings.length, 0);
  assert.equal(Rename.convertChoice("kosmickrisp-gles32:../invalid", logger), "auto");
  assert.equal(warnings.length, 1);
});

test("a profile without former values is returned unchanged for startup to record completion", t => {
  const userDataDir = profile(t), settings = { launcher: { appearance: "light" }, runtimes: { [Managed.projectId]: { defaultVersion: version } } };
  let committed = false;
  assert.equal(Rename.migrateSettings(settings, { userDataDir, commitSettings: () => { committed = true; } }), settings);
  assert.equal(committed, false);
  assert.equal(Rename.migrateSettings(null, { userDataDir }), null);
});
