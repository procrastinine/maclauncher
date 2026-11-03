const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION: KEY } = require("../src/core/backcompat/data-migrations");

const game = id => ({ gameId: id, moduleId: "fixture", gamePath: `/Games/${id}` });

// Runs the actual startup migration block and window helpers from main.js with
// Electron replaced by recording stubs.
function startupFixture({ settings = {}, games = [game("a"), game("b")], background = false, directGame = null } = {}) {
  const main = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  function section(start, end) {
    const first = main.indexOf(start), last = main.indexOf(end, first);
    assert.ok(first >= 0 && last > first, "The actual main-process startup source must be exercised");
    return main.slice(first, last);
  }
  const events = [], win = {
    setClosable: value => events.push(`closable:${value}`),
    webContents: { send: (channel, progress) => events.push(`${channel}:${progress.done}/${progress.total}`) }
  };
  const context = vm.createContext({
    settings, games, userDataDir: "/profile", logger: { warn() {} }, setImmediate,
    require: request => require(path.join(__dirname, "../src/main", request)), ORIGINAL_GAME_MIRRORS_MIGRATION: KEY, backgroundStartup: background,
    Modules: { getModule: () => ({ legacyGameMirrors(entry) { events.push(`migrate:${entry.gameId}`);return []; } }) },
    saveSettings: () => events.push("checkpoint"), saveGameRecord: entry => entry, serializeGameEntry: entry => entry,
    LibraryState: { syncLibraryStateWithGames: () => ({ library: {}, changed: false }) },
    buildState: () => ({ recents: [] }), cachedState: null, mainWindow: null, launcherWindows: new Set(),
    getArgValue: prefix => prefix === "--maclauncher-game=" ? directGame : null,
    ensureLauncherWindow: async options => {
      events.push(`window:${options.background}`);
      context.launcherWindows.add(win);context.mainWindow = win;
      return win;
    },
    broadcastState: () => { if (context.launcherWindows.size) events.push(`state:${Boolean(context.cachedState)}`); },
    getLauncherActivity: () => ({}), activityDelivery: { ready: () => events.push("activity") }
  });
  vm.runInContext(section("let startupMigration = null;", "async function init() {"), context);
  const startup = vm.runInContext("(async function () {" +
    section("    if (settings?.dataMigrations?.[ORIGINAL_GAME_MIRRORS_MIGRATION]?.complete !== true) await require(", "    syncCheatsFiles(games);") + "})", context);
  return { context, events, startup };
}

test("migration progress follows each persisted checkpoint and is silent when nothing remains", async () => {
  let saved = null;
  const progress = [], options = { games: [game("a"), game("b")], userDataDir: "/profile",
    registry: { getModule: () => ({ legacyGameMirrors: () => [] }) }, saveEntry() {},
    saveSettings: next => { saved = structuredClone(next.dataMigrations[KEY]); },
    onProgress: value => { progress.push({ ...value, remaining: saved.remainingIds.length, pending: saved.pendingIds.length }); } };
  await runDataMigrations({ ...options, settings: {} });
  assert.deepEqual(progress, [{ done: 0, total: 2, remaining: 2, pending: 0 },
    { done: 1, total: 2, remaining: 1, pending: 0 }, { done: 2, total: 2, remaining: 0, pending: 0 }]);
  assert.equal(saved.complete, true);
  progress.length = 0;
  await runDataMigrations({ ...options, settings: { dataMigrations: { [KEY]: saved } } });
  await runDataMigrations({ ...options, games: [], settings: {} });
  assert.deepEqual(progress, [], "Completed and empty profiles report no migration");
});

test("a migration with work shows the window before the first game and the library afterwards", async () => {
  const f = startupFixture();
  await f.startup();
  // The window opens once, before any game is migrated, and cannot close until
  // the library state replaces the progress.
  assert.deepEqual(f.events.filter(event => event !== "checkpoint"), [
    "window:false", "launcher:startupMigration:0/2", "closable:false",
    "migrate:a", "launcher:startupMigration:1/2", "migrate:b", "launcher:startupMigration:2/2",
    "closable:true", "state:true", "activity"
  ]);
});

test("a completed migration leaves startup unchanged", async () => {
  const f = startupFixture({ settings: { dataMigrations: { [KEY]: { complete: true, remainingIds: [], pendingIds: [] } } } });
  await f.startup();
  assert.deepEqual(f.events, []);
  assert.ok(f.context.cachedState, "The library state is built as before");
});

test("background and direct-game startups keep their window behavior", async () => {
  const background = startupFixture({ background: true });
  await background.startup();
  assert.equal(background.events.filter(event => event.startsWith("window:")).join(), "window:true");
  const direct = startupFixture({ directGame: "/Games/a" });
  await direct.startup();
  assert.deepEqual(direct.events.filter(event => event !== "checkpoint"), ["migrate:a", "migrate:b"]);
});
