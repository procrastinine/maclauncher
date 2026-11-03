const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const {createLauncher} = require("../src/core/launcher");
const {createSettingsSnapshots} = require("../src/core/settings-snapshots");
const {coordinatorFor} = require("../src/core/runtime-coordinator");
const {readJsonDocument} = require("../src/core/json-files");
const {withoutClearedDefaults} = require("../src/core/settings-merge");
const RuntimeSettings = require("../src/core/runtime-settings");
const LibraryState = require("../src/core/library-state");
const SteamClientStart = require("../src/modules/shared/runtime/steamworks/client-start");
const {MIGRATION} = require("../src/core/backcompat/settings-conversions");
const info = require("../src/modules/gamemaker/manifest.json");
const aliases = require("../src/modules/gamemaker/backcompat/runtime-settings").runtimeSettingAliases;

function fixture(t, value, {runtimeValue} = {}) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "settings-wire-backcompat-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const settingsFile = path.join(userDataDir, "settings.json"), runtimeFile = path.join(userDataDir, "runtimes/official-studio/settings.json");
  const raw = {modules: {gamemaker: {runtimeSettings: {"official-studio": {softwareOpenGLFallback: value}}}},
    runtimes: {}, launcher: {appearance: "dark", library: structuredClone(LibraryState.DEFAULT_LIBRARY_STATE)}};
  fs.writeFileSync(settingsFile, JSON.stringify(raw));
  if (runtimeValue !== undefined) {fs.mkdirSync(path.dirname(runtimeFile), {recursive: true});fs.writeFileSync(runtimeFile, JSON.stringify({softwareOpenGLFallback: runtimeValue}));}
  let aliasCalls = 0, locked = false, beforeAlias = () => {}, commits = 0;
  const registry = {listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info,
    getModule: () => ({id: info.id, manifest: info}), getModuleDir: () => path.dirname(require.resolve("../src/modules/gamemaker/manifest.json")),
    listSharedRuntimeManagers: () => [], getLegacyRuntimeSettingAliases(id) {
      assert.equal(locked, false, "Completed raw conversion does not load module backcompat facts again");
      assert.equal(id, info.id);aliasCalls++;beforeAlias();return aliases;
    }};
  const logger = {warn() {}}, coordinator = coordinatorFor(userDataDir).client();
  const defaults = RuntimeSettings.createRuntimeSettingsStore({userDataDir});
  const context = vm.createContext({userDataDir, Modules: registry, logger, readJsonDocument, CURRENT_SETTINGS_MIGRATION: MIGRATION,
    require: request => require(path.join(__dirname, "../src/main", request)),
    settingsPath: () => settingsFile, structuredClone, LibraryState, SteamClientStart, withoutClearedDefaults,
    ...RuntimeSettings, readRuntimeDefaults: (runtimeId, moduleInfo) => defaults.readDefaults(runtimeId, moduleInfo),
    settingsCoordinator: {applySettings(...args) {commits++;return coordinator.applySettings(...args);}},
    DEFAULT_LAUNCHER_SETTINGS: {networkAccess: false, library: LibraryState.DEFAULT_LIBRARY_STATE}, lastRuntimeSettingsMigration: false});
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  for (const name of ["readSettingsDocument", "shallowEqual", "buildDefaultModuleSettings", "normalizeModuleSettings", "normalizeLauncherSettings", "pruneRuntimeSettingsDefaults", "normalizeSettings"]) {
    const start = main.indexOf("function " + name + "("), end = main.indexOf("\n}", start);
    assert.ok(start >= 0 && end > start, "Exercise the actual main settings wire and pruning: " + name);
    vm.runInContext(main.slice(start, end + 2), context);
  }
  const snapshots = createSettingsSnapshots({readSettings: () => context.readSettingsDocument(),
    normalize: settings => context.normalizeSettings(settings), commitSettings: (...args) => coordinator.applySettings(...args)});
  const launcher = createLauncher({userDataDir, registry, logger});
  return {userDataDir, settingsFile, runtimeFile, snapshots, launcher, raw,
    aliases: () => aliasCalls, commits: () => commits, beforeAlias(callback) {beforeAlias = callback;},
    guardCompleted() {
      locked = true;
      const lstat = fs.lstatSync;
      return t.mock.method(fs, "lstatSync", (file, ...args) => {
        assert.notEqual(file, runtimeFile, "Completed conversion does not probe runtime-owned old settings again");
        return lstat(file, ...args);
      });
    }};
}
const selected = settings => settings.modules.gamemaker.runtimeSettings["official-studio"].softwareOpenGLFallback;

test("main converts released choices before real pruning and preserves current values", t => {
  for (const [stored, expected] of [[true, "enabled"], ["disabled", "disabled"]]) {
    const f = fixture(t, stored), loaded = f.snapshots.load();
    const conversionWrites = typeof stored === "boolean" ? 1 : 0;
    assert.equal(selected(loaded), expected, "Conversion must precede current select pruning to avoid falling back to auto");
    assert.equal(loaded.launcher.appearance, "dark");assert.equal(f.commits(), conversionWrites);
    const persisted = JSON.parse(fs.readFileSync(f.settingsFile));
    assert.equal(selected(persisted), expected);
    assert.equal(persisted.dataMigrations?.[MIGRATION]?.complete === true, conversionWrites === 1);
    const calls = f.aliases(), guard = f.guardCompleted();
    try {assert.equal(selected(f.snapshots.load()), expected);assert.equal(f.aliases(), calls);assert.equal(f.commits(), conversionWrites);}
    finally {guard.mock.restore();}
  }
});

test("plain Node settings loading shares raw conversion and completed reads avoid old file probes", t => {
  for (const [stored, expected] of [[false, "disabled"], ["enabled", "enabled"]]) {
    const f = fixture(t, stored, {runtimeValue: true}), loaded = f.launcher.loadSettings();
    assert.equal(selected(loaded), expected);assert.equal(loaded.launcher.appearance, "dark");
    assert.equal(JSON.parse(fs.readFileSync(f.runtimeFile)).softwareOpenGLFallback, "enabled");
    assert.equal(JSON.parse(fs.readFileSync(f.settingsFile)).dataMigrations[MIGRATION].complete, true);
    const calls = f.aliases(), guard = f.guardCompleted();
    try {assert.equal(selected(f.launcher.loadSettings()), expected);assert.equal(f.aliases(), calls);}
    finally {guard.mock.restore();}
  }
});

test("raw reads preserve malformed bytes before conversion and Node read failures never commit defaults", t => {
  for (const host of ["main", "node"]) {
    const f = fixture(t, true), malformed = JSON.stringify(f.raw).slice(0, -1) + ',"unfinished":';
    fs.writeFileSync(f.settingsFile, malformed);
    f.beforeAlias(() => {
      const copies = fs.readdirSync(f.userDataDir).filter(name => name.startsWith("settings.unreadable-"));
      assert.equal(copies.length, 1, "readJsonDocument preserves the original before module conversion facts are consulted");
      assert.equal(fs.readFileSync(path.join(f.userDataDir, copies[0]), "utf8"), malformed);
    });
    const loaded = host === "main" ? f.snapshots.load() : f.launcher.loadSettings();
    assert.equal(selected(loaded), "enabled");assert.equal(selected(JSON.parse(fs.readFileSync(f.settingsFile))), "enabled");
  }
  const f = fixture(t, true), original = fs.readFileSync(f.settingsFile, "utf8"), read = fs.readFileSync;
  const denied = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === f.settingsFile) throw Object.assign(new Error("Fixture unreadable settings"), {code: "EACCES"});
    return read(file, ...args);
  });
  try {f.launcher.loadSettings();assert.equal(f.aliases(), 0, "An unreadable document never becomes an empty conversion input");}
  finally {denied.mock.restore();}
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), original);
  assert.equal(JSON.parse(original).dataMigrations, undefined);
});
