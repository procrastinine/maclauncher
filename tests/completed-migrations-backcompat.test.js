const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const Modules = require("../src/modules/registry");
const { createLauncher } = require("../src/core/launcher");
const { coordinatorFor } = require("../src/core/runtime-coordinator");
const { readJsonDocument } = require("../src/core/json-files");
const { createGameRemoval } = require("../src/core/game-removal");
const { ORIGINAL_GAME_MIRRORS_MIGRATION, CURRENT_SETTINGS_MIGRATION } = require("../src/core/data-migration-ids");

// This file runs in its own process, so require.cache holds only the startup
// graph: every module, the Node launcher and settings coordinator, the backend
// worker's removal service, and the actual main.js settings read and migration
// call site.
test("a completed profile loads no backcompat module at startup", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "completed-migrations-")));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const settingsFile = path.join(userDataDir, "settings.json"), logger = { warn() {} };
  const completed = { launcher: { appearance: "dark" }, dataMigrations: {
    [ORIGINAL_GAME_MIRRORS_MIGRATION]: { complete: true, remainingIds: [], pendingIds: [] }, [CURRENT_SETTINGS_MIGRATION]: { complete: true } } };
  fs.writeFileSync(settingsFile, JSON.stringify(completed));
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  function section(start, end) {
    const first = main.indexOf(start), last = main.indexOf(end, first);
    assert.ok(first >= 0 && last > first, "The actual main-process startup source must be exercised");
    return main.slice(first, last);
  }
  const coordinator = coordinatorFor(userDataDir).client();
  const context = vm.createContext({ userDataDir, Modules, logger, readJsonDocument, settingsPath: () => settingsFile,
    settingsCoordinator: coordinator, ORIGINAL_GAME_MIRRORS_MIGRATION, CURRENT_SETTINGS_MIGRATION, games: [], showStartupMigration() {},
    require: request => require(path.join(__dirname, "../src/main", request)) });
  vm.runInContext(section("function readSettingsDocument(", "\n}") + "\n}", context);
  context.settings = context.readSettingsDocument();
  assert.deepEqual(context.settings, completed);
  await vm.runInContext("(async function () {" +
    section("    if (settings?.dataMigrations?.[ORIGINAL_GAME_MIRRORS_MIGRATION]?.complete !== true) await require(", "    const synced = ") + "})", context)();
  assert.equal(createLauncher({ userDataDir, registry: Modules, logger }).loadSettings().launcher.appearance, "dark");
  coordinator.applySettings(completed, { ...completed, launcher: { appearance: "light" } });
  assert.equal(readJsonDocument(settingsFile).launcher.appearance, "light");
  createGameRemoval({ userDataDir, registry: Modules, lifecycle: {}, logger });
  assert.deepEqual(Object.keys(require.cache).filter(file => file.includes(`${path.sep}backcompat${path.sep}`)), []);
});
