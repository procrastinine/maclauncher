const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
function slice(startToken, endToken) {
  const start = source.indexOf(startToken), end = source.indexOf(endToken, start);
  assert(start >= 0 && end > start, `${startToken} is in main.js`);
  return source.slice(start, end);
}

function playFixture() {
  let finishCheck;
  const checking = new Promise(resolve => { finishCheck = resolve; });
  const activity = [], launches = [];
  const gamePreparations = new Map();
  const context = {
    gamePreparations, playFileChecks: new Map(), runningGameSessions: new Map(), cancelGraphicsEdits: () => {},
    gameRecordsCache: [{ gamePath: "/Games/Slow" }], findGameByPath: (games, gamePath) => games.find(game => game.gamePath === gamePath),
    stopRunSession: async () => {}, pendingGameCompletions: new Map([["/Games/Slow", { code: 1 }]]),
    gameLaunchNotices: new Map(), graphicsLaunchWarnings: new Map(), cachedState: null, userDataDir: "/data",
    assertGameNotRemoving: () => {}, prioritizeLibraryEntry: () => {},
    assertGameFilesAvailable: async () => {
      const availability = await checking;
      if (!availability.available) throw new Error("The game's files are unavailable.");
    },
    broadcastActivity: () => activity.push(JSON.parse(JSON.stringify(Object.fromEntries(gamePreparations)))),
    ReShade: { executionRequirements: () => ({ needed: { processor: false } }) },
    StoredPlan: { read: () => ({ source: "effects" }), notices: () => [] },
    backendService: { launchEntry: async (entry, options) => { launches.push(`${entry.gamePath} ${options.runtimeId}`); return { kind: "cancelled" }; },
      cancelLaunch: async () => false },
    loadSettings: () => ({}), require
  };
  vm.runInNewContext(slice("async function runGameEntry(", "\nasync function runGameByPath("), context);
  vm.runInNewContext(slice("async function stopGameRuns(", "\n}\n") + "\n}", context);
  return { context, activity, launches, finishCheck };
}

test("Play shows the game as starting before its file check returns", async () => {
  const f = playFixture(), entry = { gamePath: "/Games/Slow", runtimeId: "player" };
  const playing = f.context.runGameEntry(entry, "player");
  assert.deepEqual(f.activity, [{ "/Games/Slow": { phase: "check", label: "Starting game…" } }],
    "the starting state is broadcast while the drive is still being checked");
  assert.equal(f.context.pendingGameCompletions.has("/Games/Slow"), true, "an earlier run's diagnostics stay until the files are known");
  f.finishCheck({ available: true });
  assert.equal(await playing, false);
  assert.deepEqual(f.launches, ["/Games/Slow player"]);
  assert.equal(f.context.pendingGameCompletions.has("/Games/Slow"), false);
  assert.equal(f.context.gamePreparations.size, 0);
  assert.deepEqual(f.activity.at(-1), {});
});

test("Play clears the starting state when the game's files are unavailable", async () => {
  const f = playFixture();
  const playing = f.context.runGameEntry({ gamePath: "/Games/Slow" }, "player");
  assert.equal(f.context.gamePreparations.has("/Games/Slow"), true);
  f.finishCheck({ available: false });
  await assert.rejects(playing, /files are unavailable/);
  assert.deepEqual(f.launches, []);
  assert.equal(f.context.gamePreparations.size, 0);
  assert.deepEqual(f.activity.at(-1), {});
  assert.equal(f.context.pendingGameCompletions.has("/Games/Slow"), true);
});

function moduleDataFixture({ fail = false, initial = false, unset = false, perRequest = false } = {}) {
  let saved = { gameId: "g", gamePath: "/Games/Tools", moduleId: "engine", moduleData: { ...(unset ? {} : { toolsButtonVisibleOverride: initial }), kept: 1 } };
  let finishPatch;
  const patching = new Promise(resolve => { finishPatch = resolve; });
  const broadcasts = [], patches = [], handlers = new Map(), outcomes = [];
  const context = {
    Date, loadSettings: () => ({}), loadGamesHydrated: () => [structuredClone(saved)],
    findGameByPath: (games, gamePath) => games.find(game => game.gamePath === gamePath), resolveModuleId: game => game.moduleId,
    getCheatsPatcherIfSupported: () => ({}), resolveToolsButtonVisible: entry => entry.moduleData.toolsButtonVisibleOverride === true,
    saveGameRecord: entry => { saved = structuredClone(entry); },
    backendService: { request: async (...args) => {
      patches.push(args[5]);
      if (perRequest) { const failed = await new Promise(resolve => outcomes.push(resolve)); if (failed) throw new Error("patch failed"); return; }
      await patching; if (fail) throw new Error("patch failed");
    } },
    toolsButtonPatches: new Map(),
    buildState: (_settings, games) => ({ recents: games }), broadcastState: () => broadcasts.push(saved.moduleData.toolsButtonVisibleOverride ?? null),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, cachedState: null
  };
  vm.runInNewContext(slice("function updateEntryModuleData(", "\nfunction updateEntryRuntimeData("), context);
  vm.runInNewContext(slice('ipcMain.handle("launcher:setGameModuleData",', 'ipcMain.handle("launcher:setGameRuntimeData",'), context);
  return { get saved() { return saved; }, broadcasts, patches, finishPatch, outcomes,
    invoke: patch => handlers.get("launcher:setGameModuleData")(null, "/Games/Tools", patch) };
}

test("the Tools button choice shows before the game's files are patched", async () => {
  const f = moduleDataFixture(), changing = f.invoke({ toolsButtonVisibleOverride: true });
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, true);
  assert.deepEqual(f.broadcasts, [true], "broadcast while the patch is still running");
  assert.equal(JSON.stringify(f.patches), JSON.stringify([{ toolsButtonVisible: true }]));
  f.finishPatch();
  assert.equal(await changing, true);
  assert.deepEqual(f.broadcasts, [true]);
  assert.equal(f.saved.moduleData.kept, 1);
});

test("a Tools button patch that fails restores the earlier choice and reports the error", async () => {
  const f = moduleDataFixture({ fail: true }), changing = f.invoke({ toolsButtonVisibleOverride: true });
  assert.deepEqual(f.broadcasts, [true]);
  f.finishPatch();
  await assert.rejects(changing, /patch failed/);
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, false);
  assert.deepEqual(f.broadcasts, [true, false]);
  assert.equal(f.saved.moduleData.kept, 1);
});

test("opening a runtime's settings again focuses its window instead of loading another", async () => {
  const windows = [], loads = [];
  class BrowserWindow {
    constructor() { this.listeners = {}; this.destroyed = false; this.focused = 0; this.webContents = {}; windows.push(this); }
    on(name, fn) { this.listeners[name] = fn; } isDestroyed() { return this.destroyed; } isMinimized() { return false; }
    show() {} focus() { this.focused++; }
  }
  const context = { BrowserWindow, runtimeSettingsWindows: new Map(), nativeTheme: { shouldUseDarkColors: false }, path, __dirname: "/app/src/main",
    registerLauncherWindow: () => {}, attachWebContentsLogging: () => {}, attachDevToolsShortcut: () => {}, attachDevToolsAutoOpen: () => {},
    isDebug: false, loadLauncherView: async (_win, view) => loads.push(JSON.stringify(view)) };
  vm.runInNewContext(slice("async function createRuntimeSettingsWindow(", "\nasync function createSaveEditorWindow("), context);
  const game = { scope: "game", moduleId: "engine", runtimeId: "player", gamePath: "/Games/A" };
  const first = await context.createRuntimeSettingsWindow(game);
  assert.equal(await context.createRuntimeSettingsWindow({ ...game }), first);
  assert.equal(first.focused, 1);assert.equal(windows.length, 1);assert.equal(loads.length, 1);
  const other = await context.createRuntimeSettingsWindow({ ...game, gamePath: "/Games/B" });
  assert.notEqual(other, first);assert.equal(windows.length, 2);
  first.destroyed = true;first.listeners.closed();
  assert.notEqual(await context.createRuntimeSettingsWindow(game), first, "a closed window is replaced");
  assert.equal(windows.length, 3);
});

test("Cancel during Play's file check stops the launch before it starts", async () => {
  const f = playFixture();
  const playing = f.context.runGameEntry({ gamePath: "/Games/Slow" }, "player");
  assert.equal(await f.context.stopGameRuns("/Games/Slow"), true, "Cancel reports that it stopped something");
  f.finishCheck({ available: true });
  assert.equal(await playing, false);
  assert.deepEqual(f.launches, [], "the backend launch never starts");
  assert.equal(f.context.gamePreparations.size, 0);assert.equal(f.context.playFileChecks.size, 0);
  assert.deepEqual(f.activity.at(-1), {});
  assert.equal(await f.context.stopGameRuns("/Games/Slow"), false, "nothing is left to stop");
});

test("a failed Tools patch never restores over a newer choice and restores the last choice that was applied", async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  // Unset, then off (request 1), then on (request 2); request 1 fails first.
  let f = moduleDataFixture({ unset: true, perRequest: true });
  const off = f.invoke({ toolsButtonVisibleOverride: false }), on = f.invoke({ toolsButtonVisibleOverride: true });
  await settle();f.outcomes[0](true);
  await assert.rejects(off, /patch failed/);
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, true, "the newer choice stays");
  f.outcomes[1](true);
  await assert.rejects(on, /patch failed/);
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, undefined, "no patch succeeded, so the original unset value returns");
  // Off succeeds, then on fails: the files show off, so off returns.
  f = moduleDataFixture({ unset: true, perRequest: true });
  const first = f.invoke({ toolsButtonVisibleOverride: false }), second = f.invoke({ toolsButtonVisibleOverride: true });
  await settle();f.outcomes[0](false);assert.equal(await first, true);
  f.outcomes[1](true);await assert.rejects(second, /patch failed/);
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, false);
  // Off, on, off: the first request failing while the record holds the third's equal value restores nothing.
  f = moduleDataFixture({ initial: true, perRequest: true });
  const a = f.invoke({ toolsButtonVisibleOverride: false }), b = f.invoke({ toolsButtonVisibleOverride: true }), c = f.invoke({ toolsButtonVisibleOverride: false });
  await settle();f.outcomes[0](true);await assert.rejects(a, /patch failed/);
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, false, "the third request owns the record");
  f.outcomes[1](false);f.outcomes[2](false);assert.equal(await b, true);assert.equal(await c, true);
  assert.equal(f.saved.moduleData.toolsButtonVisibleOverride, false);
});
