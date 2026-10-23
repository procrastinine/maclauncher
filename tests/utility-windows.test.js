const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createUtilityWindowController } = require("../src/main/utility-windows");
const { normalizeUtilityWindowRequest, readUtilityWindowContext } = require("../src/core/utility-window-model.mjs");

class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.destroyed = false; this.minimized = false; this.focuses = 0; this.shows = 0; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; this.restored = true; }
  show() { this.shows++; }
  focus() { this.focuses++; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

function fixture(options = {}) {
  const windows = [], registrations = [], loads = [];
  const controller = createUtilityWindowController({
    createWindow: configuration => { const win = new Window(configuration); windows.push(win); return win; },
    registerWindow: (win, view) => registrations.push({ win, view }),
    loadView: async (win, request) => { loads.push({ win, request }); await options.load?.(win, request); },
    onContextChange: options.changed
  });
  return { controller, windows, registrations, loads };
}

test("utility windows use independent native frames and keep one window per kind", async () => {
  const f = fixture(), library = new Window({ title: "MacLauncher" });
  const windows = await Promise.all(["settings", "runtimes", "credits", "external"].map(view => f.controller.open({ view })));
  assert.equal(new Set(windows).size, 4);
  assert.equal(f.windows.length, 4);
  assert.deepEqual(f.registrations.map(value => value.view), ["settings", "runtimes", "credits", "external"]);
  for (const win of windows) {
    assert.equal(win.options.frame, true);
    assert.equal(win.options.modal, false);
    assert.equal(win.options.show, false, "Show after the local view loads");
    assert.equal(win.options.parent, undefined, "The library stays independently usable");
    assert.ok(win.options.minWidth > 0 && win.options.minHeight > 0);
    assert.equal(win.focuses, 1);
  }
  assert.deepEqual(windows.map(win => win.options.title), ["Settings", "Runtimes", "Credits", "External"]);
  assert.equal(library.destroyed, false);
  assert.equal(library.focuses, 0);
});

test("reopening restores and focuses the same window without reloading its settings or tab drafts", async () => {
  const f = fixture();
  const win = await f.controller.open({ view: "settings" });
  win.minimized = true;
  win.draft = { selectedTab: "module", value: "draft" };
  const before = f.controller.stateForWindow(win, {}).utilityWindow;
  assert.equal(await f.controller.open({ view: "settings" }), win);
  assert.equal(f.loads.length, 1);
  assert.equal(win.restored, true);
  assert.equal(win.focuses, 2);
  assert.deepEqual(win.draft, { selectedTab: "module", value: "draft" });
  assert.deepEqual(f.controller.stateForWindow(win, {}).utilityWindow, before);
});

test("reopening External restores its singleton and preserves search, selection and download state", async () => {
  const f = fixture();
  const win = await f.controller.open({ view: "external" });
  win.minimized = true;
  win.draft = { search: "example", selectedIds: ["steam-game"], activeDownload: "download" };
  assert.equal(await f.controller.open({ view: "external" }), win);
  assert.equal(f.windows.length, 1); assert.equal(f.loads.length, 1);
  assert.equal(win.restored, true); assert.equal(win.focuses, 2);
  assert.deepEqual(win.draft, { search: "example", selectedIds: ["steam-game"], activeDownload: "download" });
  assert.equal(f.controller.stateForWindow(win, {}).utilityWindow.view, "external");
});

test("concurrent opens share one in-flight window and the latest runtime-manager target", async () => {
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const f = fixture({ load: () => loading });
  const first = f.controller.open({ view: "runtimes", managerId: "first-manager" });
  const second = f.controller.open({ view: "runtimes", managerId: "second-manager" });
  assert.equal(f.windows.length, 1);
  const context = f.controller.stateForWindow(f.windows[0], {}).utilityWindow;
  assert.equal(context.managerId, "second-manager");
  release();
  assert.equal(await first, await second);
  assert.equal(f.loads.length, 1);
  const revision = context.revision;
  await f.controller.open({ view: "runtimes", managerId: "second-manager" });
  assert.ok(f.controller.stateForWindow(f.windows[0], {}).utilityWindow.revision > revision,
    "A repeated inspector request can reselect a manager after a manual tab switch");
});

test("closed windows are removed and a failed local load can be reopened cleanly", async () => {
  let fail = true;
  const f = fixture({ load: () => { if (fail) throw new Error("Local view failed"); } });
  await assert.rejects(f.controller.open({ view: "credits" }), /Local view failed/);
  assert.equal(f.windows[0].destroyed, true);
  fail = false;
  const win = await f.controller.open({ view: "credits" });
  assert.notEqual(win, f.windows[0]);
  let prevented = false;
  win.emit("page-title-updated", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "The native title keeps the selected view name");
  win.destroy();
  assert.notEqual(await f.controller.open({ view: "credits" }), win);
});

test("all utility windows receive the same current shared state without a divergent settings cache", async () => {
  const f = fixture();
  const windows = await Promise.all(["settings", "runtimes", "credits", "external"].map(view => f.controller.open({ view })));
  const library = new Window({}), settings = { launcher: { showIcons: true } };
  const before = { recents: [{ gamePath: "/game" }], launcherSettings: settings.launcher, runtimeManagers: {} };
  assert.equal(f.controller.stateForWindow(library, before), before);
  for (const win of windows) {
    const shown = f.controller.stateForWindow(win, before);
    assert.equal(shown.recents, before.recents);
    assert.equal(shown.launcherSettings, before.launcherSettings);
    shown.utilityWindow.view = "changed";
  }
  const after = { ...before, launcherSettings: { showIcons: false }, runtimeManagers: { host: { defaultVersion: "2.0" } } };
  for (const win of windows) {
    const shown = f.controller.stateForWindow(win, after);
    assert.equal(shown.launcherSettings, after.launcherSettings);
    assert.equal(shown.runtimeManagers.host.defaultVersion, "2.0");
    assert.notEqual(shown.utilityWindow.view, "changed");
  }
  assert.equal(before.utilityWindow, undefined);
  assert.equal(before.launcherSettings.showIcons, true);
  assert.equal(f.controller.stateForWindow(windows[0], null), null);
});

test("utility route parsing is bounded and does not intercept existing editor routes", () => {
  assert.deepEqual(readUtilityWindowContext("?view=settings"), { view: "settings" });
  assert.deepEqual(readUtilityWindowContext("?view=settings&sectionId=module:android"), { view: "settings", sectionId: "module:android" });
  assert.deepEqual(readUtilityWindowContext("?view=runtimes&managerId=host"), { view: "runtimes", managerId: "host" });
  assert.deepEqual(readUtilityWindowContext("?view=credits&managerId=ignored"), { view: "credits" });
  assert.deepEqual(readUtilityWindowContext("?view=external&managerId=ignored"), { view: "external" });
  for (const view of ["", "library", "runtime-settings", "save-editor", "live-variables", "other"]) {
    assert.equal(readUtilityWindowContext("?view=" + view), null);
  }
  for (const value of [null, {}, { view: ["settings"] }, { view: "__proto__" }, { view: "toString" }, { view: "game" }]) {
    assert.throws(() => normalizeUtilityWindowRequest(value), /Unknown launcher window/);
  }
  for (const managerId of ["../host", "a\0b", "a".repeat(129), 7]) {
    assert.throws(() => normalizeUtilityWindowRequest({ view: "runtimes", managerId }), /Invalid runtime manager/);
  }
  for (const sectionId of ["../android", "a\0b", "a".repeat(129), 7]) {
    assert.throws(() => normalizeUtilityWindowRequest({ view: "settings", sectionId }), /Invalid settings section/);
  }
});

test("account navigation reselects a settings section in the existing native window", async () => {
  const f = fixture();
  const win = await f.controller.open({ view: "settings" });
  const result = await f.controller.open({ view: "settings", sectionId: "module:android" });
  assert.equal(result, win);
  assert.equal(f.windows.length, 1);
  assert.equal(f.controller.stateForWindow(win, {}).utilityWindow.sectionId, "module:android");
  const revision = f.controller.stateForWindow(win, {}).utilityWindow.revision;
  await f.controller.open({ view: "settings", sectionId: "module:android" });
  assert.ok(f.controller.stateForWindow(win, {}).utilityWindow.revision > revision);
});

test("the production launcher preload forwards utility opens and state edits through the existing IPC service", async () => {
  const invocations = [], messages = [], ipc = new EventEmitter();
  ipc.invoke = (...args) => { invocations.push(args); return Promise.resolve(true); };
  ipc.send = (...args) => { messages.push(args); };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8"), {
    require: name => { assert.equal(name, "electron"); return { ipcRenderer: ipc, contextBridge: {
      exposeInMainWorld: (_name, bridge) => { api = bridge.launcher; }
    } }; }
  });
  const request = { view: "runtimes", managerId: "host" };
  await api.openUtilityWindow(request);
  await api.setLauncherSettings({ showIcons: false });
  await api.setModuleSettings("module", { defaultRuntime: "host" });
  assert.deepEqual(invocations, [["launcher:openUtilityWindow", request], ["launcher:setLauncherSettings", { showIcons: false }],
    ["launcher:setModuleSettings", "module", { defaultRuntime: "host" }]]);
  const received = [], stop = api.onState(state => received.push(state));
  const state = { launcherSettings: { showIcons: false } };
  ipc.emit("launcher:state", {}, state);
  assert.equal(received[0], state);
  stop(); assert.equal(ipc.listenerCount("launcher:state"), 0);
  const activity = { downloads: [{ id: "java", downloaded: 12 }] };
  const stopActivity = api.onActivity(value => received.push(value));
  ipc.emit("launcher:activity", {}, { sequence: 1, activity });
  assert.equal(received[1], activity);
  assert.equal(received.length, 2);
  stopActivity(); assert.equal(ipc.listenerCount("launcher:activity"), 0);
  assert.deepEqual(messages, [["launcher:activityReady"], ["launcher:activityAck", 1], ["launcher:activityStopped"]]);
  const stopThrowing = api.onActivity(() => { throw Error("Subscriber failed"); });
  const beforeSecond = messages.length;
  const secondReceived = [];
  const stopSecond = api.onActivity(value => secondReceived.push(value));
  assert.equal(messages.length, beforeSecond, "Additional subscribers share the registered activity channel");
  assert.equal(ipc.listenerCount("launcher:activity"), 1);
  assert.throws(() => ipc.emit("launcher:activity", {}, { sequence: 2, activity }), /Subscriber failed/);
  assert.deepEqual(messages.at(-1), ["launcher:activityAck", 2], "A failed callback must not stall the activity channel");
  assert.equal(secondReceived[0], activity, "A failed subscriber must not prevent other subscribers receiving activity");
  stopThrowing();
  assert.deepEqual(messages.at(-1), ["launcher:activityAck", 2], "Unsubscribing one listener keeps remaining listeners active");
  ipc.emit("launcher:activity", {}, { sequence: 3, activity });
  assert.equal(secondReceived.length, 2);
  stopSecond(); stopSecond();
  assert.equal(ipc.listenerCount("launcher:activity"), 0);
  assert.deepEqual(messages.slice(-2), [["launcher:activityAck", 3], ["launcher:activityStopped"]]);
  assert.equal(api.onOpenSettings, undefined, "Native menu routing needs no HTML view-switch event");
});

test("the production menu opens native utility windows from any focused view and retains native Library and Cmd-W actions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const menu = source.slice(source.indexOf("function setupAppMenu()"), source.indexOf("\nfunction upsertGame", source.indexOf("function setupAppMenu()")));
  let template;
  const opened = [];
  vm.runInNewContext(menu + "\nsetupAppMenu();", { process: { platform: "darwin" }, app: { name: "MacLauncher" },
    devtoolsEnabled: false, sendToolsMenuEvent() {}, openGamesFromMenu() {}, openUtilityFromMenu: view => opened.push(view),
    ensureLauncherWindow: () => { opened.push("library"); return Promise.resolve(); },
    Menu: { buildFromTemplate: value => { template = value; return value; }, setApplicationMenu() {} } });
  const appMenu = template[0].submenu;
  const settings = appMenu.find(item => item.label === "Settings…");
  assert.equal(settings.accelerator, "CmdOrCtrl+,");
  settings.click();
  appMenu.find(item => item.label === "Credits").click();
  template.find(item => item.label === "View").submenu.find(item => item.label === "External").click();
  template.find(item => item.label === "View").submenu.find(item => item.label === "Runtimes").click();
  template.find(item => item.label === "View").submenu.find(item => item.label === "Library").click();
  assert.deepEqual(opened, ["settings", "credits", "external", "runtimes", "library"]);
  assert.ok(template.find(item => item.label === "File").submenu.some(item => item.role === "close"));
});

test("fullscreen keeps the Mac shortcut hidden beside the native command and retains the native role elsewhere", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const menu = source.slice(source.indexOf("function setupAppMenu()"), source.indexOf("\nfunction upsertGame", source.indexOf("function setupAppMenu()")));
  function templateFor(platform) {
    let template;
    vm.runInNewContext(menu + "\nsetupAppMenu();", { process: { platform }, app: { name: "MacLauncher" },
      devtoolsEnabled: false, sendToolsMenuEvent() {}, openGamesFromMenu() {}, openUtilityFromMenu() {},
      Menu: { buildFromTemplate: value => { template = value; return value; }, setApplicationMenu() {} } });
    return template;
  }
  const mac = templateFor("darwin").find(item => item.label === "View").submenu;
  const actions = mac.filter(item => item.label === "Toggle Full Screen" || item.role === "togglefullscreen");
  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.role, undefined, "Avoid the native AppKit selector that injects a duplicate menu item");
  assert.equal(action.accelerator, "Control+Command+F");
  assert.equal(action.visible, false, "macOS supplies the sole visible fullscreen command");
  assert.equal(action.acceleratorWorksWhenHidden, true, "Control+Command+F still dispatches while the compatibility item is hidden");
  let fullscreen = false;
  const focused = { isDestroyed: () => false, isFullScreen: () => fullscreen, setFullScreen: value => { fullscreen = value; } };
  action.click({}, focused); assert.equal(fullscreen, true);
  action.click({}, focused); assert.equal(fullscreen, false);
  assert.doesNotThrow(() => action.click({}, null));
  action.click({}, { ...focused, isDestroyed: () => true }); assert.equal(fullscreen, false);
  for (const platform of ["linux", "win32"]) {
    const view = templateFor(platform).find(item => item.label === "View").submenu;
    assert.equal(view.filter(item => item.role === "togglefullscreen").length, 1);
    assert.equal(view.some(item => item.label === "Toggle Full Screen"), false);
  }
});

test("the real library search handler preserves Cmd-F and leaves Control+Command+F to the native menu", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/App.tsx"), "utf8");
  const marker = '  useEffect(() => {\n    if (isSecondaryView) return;\n    const onKeyDown = (event: KeyboardEvent)';
  const start = source.indexOf(marker), endMarker = '}, [isSecondaryView, saveGame, cheatGame]);';
  assert.ok(start >= 0);
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0);
  const { code } = await require("vite").transformWithOxc(source.slice(start, end + endMarker.length), "library-search-handler.ts");
  let listener, cleanup, focuses = 0, selections = 0;
  const context = { isSecondaryView: false, saveGame: null, cheatGame: null,
    useEffect: setup => { cleanup = setup(); },
    window: { addEventListener: (type, callback) => { assert.equal(type, "keydown"); listener = callback; },
      removeEventListener: (type, callback) => { assert.equal(type, "keydown"); assert.equal(callback, listener); listener = null; } },
    document: { getElementById: id => { assert.equal(id, "game-search-input"); return {
      focus: () => { focuses++; }, select: () => { selections++; }
    }; } }
  };
  vm.runInNewContext(code, context);
  const key = overrides => ({ key: "f", metaKey: true, ctrlKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...overrides });
  const search = key(); listener(search);
  assert.equal(search.defaultPrevented, true); assert.equal(focuses, 1); assert.equal(selections, 1);
  const fullscreen = key({ ctrlKey: true }); listener(fullscreen);
  assert.equal(fullscreen.defaultPrevented, false); assert.equal(focuses, 1); assert.equal(selections, 1);
  const controlOnly = key({ metaKey: false, ctrlKey: true }); listener(controlOnly);
  assert.equal(controlOnly.defaultPrevented, false);
  const uppercase = key({ key: "F" }); listener(uppercase);
  assert.equal(uppercase.defaultPrevented, true); assert.equal(focuses, 2);
  context.saveGame = {}; const save = key(); listener(save); assert.equal(save.defaultPrevented, false);
  context.saveGame = null; context.cheatGame = {}; const cheat = key(); listener(cheat); assert.equal(cheat.defaultPrevented, false);
  cleanup(); assert.equal(listener, null);
  context.isSecondaryView = true;
  vm.runInNewContext(code, context);
  assert.equal(listener, null, "Utility and editor windows never install the library search shortcut");
});

function mainFunction(name, nextName) {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("async function " + name + "(");
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("\nasync function " + nextName + "(", start));
}

function libraryFixture(createWindow = async () => new Window({})) {
  const context = { mainWindow: null, mainWindowOpening: null, createLauncherWindow: createWindow };
  vm.runInNewContext(mainFunction("ensureLauncherWindow", "createRuntimeSettingsWindow"), context);
  return context;
}

test("simultaneous Dock and import reopening share one library load and retain usable utility windows", async () => {
  let release, created = 0;
  const loading = new Promise(resolve => { release = resolve; });
  const library = new Window({}), utility = new Window({});
  const context = libraryFixture(async () => { created++; await loading; return library; });
  const first = context.ensureLauncherWindow(), second = context.ensureLauncherWindow();
  await Promise.resolve();
  assert.equal(created, 1);
  release();
  assert.equal(await first, library);
  assert.equal(await second, library);
  library.minimized = true;
  assert.equal(await context.ensureLauncherWindow(), library);
  assert.equal(created, 1);
  assert.equal(library.restored, true);
  assert.equal(utility.destroyed, false);
  library.destroy();
  assert.equal(context.mainWindow, null);
  assert.equal(context.mainWindowOpening, null);
});

test("library reopening retries failed loads and old close events never remove the replacement", async () => {
  let fail = true;
  const windows = [];
  const context = libraryFixture(async () => {
    if (fail) throw new Error("Local library load failed");
    const win = new Window({}); windows.push(win); return win;
  });
  await assert.rejects(context.ensureLauncherWindow(), /Local library load failed/);
  assert.equal(context.mainWindowOpening, null);
  fail = false;
  const old = await context.ensureLauncherWindow();
  old.destroy();
  const current = await context.ensureLauncherWindow();
  assert.notEqual(current, old);
  old.emit("closed");
  assert.equal(context.mainWindow, current);
  assert.equal(windows.length, 2);
});

test("a failed actual library view load destroys its native window before retry", async () => {
  const windows = [];
  const context = { screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    app: { isPackaged: false }, path, __dirname: path.join(__dirname, "../src/main"), process: { platform: "darwin" },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_NAME: "MacLauncher", isDebug: false,
    BrowserWindow: class extends Window { constructor(options) { super(options); windows.push(this); } },
    registerLauncherWindow() {}, attachWebContentsLogging() {}, attachDevToolsShortcut() {}, attachDevToolsAutoOpen() {},
    loadLauncherView: async () => { throw new Error("Failed local view"); }, logger: { info() {}, error() {} }
  };
  vm.runInNewContext(mainFunction("createLauncherWindow", "ensureLauncherWindow"), context);
  await assert.rejects(context.createLauncherWindow(), /Failed local view/);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].destroyed, true);
});

test("native Dock activation reopens the library without opening it in game children or during startup", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const activation = source.slice(source.indexOf('app.on("activate"'), source.indexOf('\napp.on("window-all-closed"'));
  const app = new EventEmitter();
  let opens = 0;
  const context = { app, isChildGame: false, isSmoke: false, cachedState: null,
    ensureLauncherWindow: async () => { opens++; }, logger: { error() {} } };
  vm.runInNewContext(activation, context);
  app.emit("activate"); assert.equal(opens, 0);
  context.cachedState = { recents: [] };
  context.isChildGame = true; app.emit("activate"); assert.equal(opens, 0);
  context.isChildGame = false; context.isSmoke = true; app.emit("activate"); assert.equal(opens, 0);
  context.isSmoke = false; app.emit("activate"); assert.equal(opens, 1);
});

test("successful File Open imports reopen the library before delivering imported-game selection", async () => {
  const order = [], entry = { gamePath: "/game/original.exe", gameId: "game" };
  const win = new Window({});
  win.__maclauncherWindowType = "launcher";
  win.webContents = { send: (channel, value) => order.push([channel, value]) };
  const settings = { launcher: {} };
  const context = { loadGamesHydrated: () => [], assertGameNotRemoving() {},
    backendService: { request: async () => ({ ...entry }) }, loadSettings: () => settings,
    findGameByPath: () => null, GameData: { createGameId: () => "game" },
    upsertGame: () => ({ entry, games: [entry] }), persistGames: () => order.push("persist"), saveSettings() {},
    buildState: () => ({ recents: [entry] }), cachedState: null, broadcastState() {},
    ensureLauncherWindow: async () => { order.push("open-library"); },
    BrowserWindow: { getAllWindows: () => [win] }, isLauncherWindow: native => native.__maclauncherWindowType === "launcher"
  };
  vm.runInNewContext(mainFunction("importGameIntoLibrary", "openGamesFromMenu"), context);
  assert.equal(await context.importGameIntoLibrary(entry.gamePath), entry);
  assert.deepEqual(order, ["persist", "open-library", ["launcher:gameImported", entry.gamePath]]);
});

test("background Steam imports persist and broadcast library edits without focus or selection events", async () => {
  const order = [], entry = { gamePath: "/steam/Example Game/Example.app", gameId: "game" };
  const settings = { launcher: {} };
  const context = { loadGamesHydrated: () => [], assertGameNotRemoving() {},
    backendService: { request: async () => { order.push("detect"); return { ...entry }; } }, loadSettings: () => settings,
    findGameByPath: () => null, GameData: { createGameId: () => "game" },
    upsertGame: (_games, detected) => ({ entry: detected, games: [detected] }),
    persistGames: games => { assert.equal(games[0].importPath, "/steam/Example Game"); order.push("persist"); },
    saveSettings: () => order.push("settings"), buildState: (_settings, games) => ({ recents: games }), cachedState: null,
    broadcastState: () => order.push("broadcast"),
    ensureLauncherWindow: () => assert.fail("A background import must leave the Steam window focused"),
    BrowserWindow: { getAllWindows: () => assert.fail("A background import must not send game-selection events") }
  };
  vm.runInNewContext(mainFunction("importGameIntoLibrary", "openGamesFromMenu"), context);
  const { createGameImportQueue } = require("../src/core/game-import-queue");
  const queue = createGameImportQueue(); queue.setImporter(context.importGameIntoLibrary);
  const imported = await queue.import("/steam/Example Game", { background: true });
  assert.equal(imported.gamePath, entry.gamePath); assert.equal(imported.importPath, "/steam/Example Game");
  assert.equal(context.cachedState.recents[0], imported);
  assert.deepEqual(order, ["detect", "persist", "settings", "broadcast"]);
});

test("runtime import and download sheets follow the focused registered window and never attach to a game", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("  callbacks: {");
  const callbacks = source.slice(start + "  callbacks: ".length, source.indexOf("\n  onEvent:", start)).trim().replace(/,$/, "");
  const ownerSource = source.slice(source.indexOf("function getLauncherDialogOwner()"), source.indexOf("\nfunction openUtilityFromMenu("));
  const library = new Window({}), utility = new Window({}), game = new Window({});
  const calls = [];
  const context = { mainWindow: library, launcherWindows: new Set([library, utility]), focused: utility,
    BrowserWindow: { getFocusedWindow: () => context.focused }, shell: {},
    dialog: Object.fromEntries(["showOpenDialog", "showSaveDialog", "showMessageBox"].map(method => [method,
      async (...args) => { calls.push([method, ...args]); return { canceled: false, filePaths: ["/chosen/runtime"], response: 0 }; }
    ])), path
  };
  vm.runInNewContext(ownerSource + "\nasync function confirmRuntimeInstallation(plan, entry)" +
    source.split("async function confirmRuntimeInstallation(plan, entry)")[1].split("\nconst launcherService")[0], context);
  const api = vm.runInNewContext("(" + callbacks + ")", context);
  await api.chooseImportPath({ label: "Import runtime", kinds: ["file"], extensions: ["zip"] });
  await api.chooseImportPath({ label: "Add application…", kinds: ["file"], extensions: ["app"] });
  const applicationPicker = calls.at(-1).at(-1);
  assert.deepEqual(Array.from(applicationPicker.properties), ["openFile"]);
  assert.deepEqual(Array.from(applicationPicker.filters[0].extensions), ["app"]);
  assert.ok(!applicationPicker.properties.includes("treatPackageAsDirectory"), "The native picker selects the intact app bundle");
  await api.chooseInstalledActionInput({ label: "Import library", extensions: ["dll"] });
  await api["dialog.showSaveDialog"]({ title: "Save" });
  await api.confirmRuntimeInstall({ label: "Runtime", version: "1", kind: "runtime" }, null);
  assert.ok(calls.every(call => call[1] === utility), "Sheets use the active Runtimes or Settings window");
  context.focused = game;
  await api.chooseImportPath({ label: "Import", kinds: ["file"], extensions: [] });
  assert.equal(calls.at(-1)[1], library, "An unregistered game cannot receive launcher sheets");
  utility.destroy(); context.focused = utility;
  assert.equal(context.getLauncherDialogOwner(), library);
  library.destroy();
  await api.chooseImportPath({ label: "Import", kinds: ["file"], extensions: [] });
  assert.equal(calls.at(-1).length, 2, "No closed native window is passed as a sheet parent");
});
