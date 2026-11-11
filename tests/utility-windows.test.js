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
  show() { this.shows++; this.emit("show"); }
  showInactive() { this.inactive=(this.inactive||0)+1; this.emit("show"); }
  focus() { this.focuses++; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

function fixture(options = {}) {
  const windows = [], registrations = [], loads = [];
  const controller = createUtilityWindowController({
    createWindow: configuration => { const win = new Window(configuration); windows.push(win); return win; },
    registerWindow: (win, view) => registrations.push({ win, view }),
    loadView: async (win, request) => { loads.push({ win, request }); await options.load?.(win, request); },
    onContextChange: options.changed,
    ...(options.kept ? { keptViews: options.kept, beforeShow: options.beforeShow, onHidden: options.hidden, isQuitting: options.quitting,
      adaptWindow: options.adapt, idle: options.idle, present: options.present } : {})
  });
  return { controller, windows, registrations, loads };
}

function closeWindow(win) {
  let prevented = false;
  win.emit("close", { preventDefault: () => { prevented = true; } });
  if (!prevented) win.destroy();
  return prevented;
}

test("one hidden spare serves Settings, Runtimes and Credits: switched on open, replacement starts when taken, closed windows hidden at once", async () => {
  const shownWith = [], hidden = [], adapted = [], idle = [], presented = [];
  let quitting = false, holdLoad = null;
  const f = fixture({ kept: ["settings", "runtimes", "credits"], beforeShow: win => shownWith.push(f.controller.stateForWindow(win, {}).utilityWindow),
    hidden: win => hidden.push(win), quitting: () => quitting, adapt: (win, options, request) => adapted.push({ win, title: options.title, view: request.view }),
    idle: callback => idle.push(callback), load: () => holdLoad,
    present: async (win, request) => { presented.push(request); win.show(); } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const runIdle = async () => { await settle(); while (idle.length) { await idle.shift()(); await settle(); } };
  Window.prototype.hide = function () { this.hides = (this.hides || 0) + 1; };
  const live = () => f.windows.filter(win => !win.destroyed);

  await f.controller.prepare();
  assert.equal(f.windows.length, 1, "One spare is prepared");
  assert.equal(f.loads[0].request.view, "settings");
  assert.equal(f.windows[0].shows, 0); assert.ok(f.controller.isHidden(f.windows[0]));

  const runtimes = await f.controller.open({ view: "runtimes", managerId: "wine" });
  assert.equal(runtimes, f.windows[0], "The spare is switched to Runtimes");
  assert.deepEqual(adapted.map(item => [item.view, item.title]), [["runtimes", "Runtimes"]]);
  assert.equal(shownWith.at(-1).view, "runtimes", "Its state names the new view before it shows");
  assert.equal(shownWith.at(-1).managerId, "wine");
  assert.equal(runtimes.shows, 1);
  assert.equal(f.windows.length, 2, "Replacement constructed during open, without idle work");
  await runIdle();
  assert.equal(f.windows.length, 2, "A new spare is prepared when idle");
  assert.equal(f.loads[1].request.view, "settings", "for a kept view without a window");

  assert.deepEqual(presented.at(-1), { view: "runtimes", revision: shownWith.at(-1).revision, switched: true, navigation: true, shown: false, activate: true });
  const settings = await f.controller.open({ view: "settings" });
  assert.equal(settings, f.windows[1], "Opening the spare's own view shows it unchanged");
  assert.equal(adapted.length, 1);
  assert.equal(shownWith.length, 1, "A plain opening sends no state; the hidden window's is current");
  assert.deepEqual(presented.at(-1), { view: "settings", revision: presented.at(-1).revision, switched: false, navigation: false, shown: false, activate: true });
  await runIdle();
  assert.equal(f.windows.length, 3); assert.equal(f.loads[2].request.view, "credits");

  assert.equal(closeWindow(runtimes), true, "Closing hides at once");
  assert.equal(runtimes.hides, 1); assert.equal(runtimes.destroyed, false);
  assert.ok(f.controller.isHidden(runtimes), "A window waiting to go counts as hidden");
  await runIdle();
  assert.equal(runtimes.destroyed, true, "With a spare already hidden, the closed window goes when idle");
  assert.equal(closeWindow(settings), true); await runIdle();
  assert.equal(settings.destroyed, true);
  assert.equal(live().length, 1, "Idle, one hidden window remains");
  assert.deepEqual(hidden, [runtimes, settings]);

  const reopened = await f.controller.open({ view: "runtimes" });
  assert.equal(reopened, f.windows[2], "The Credits spare becomes Runtimes");
  assert.equal(presented.at(-1).switched, true); assert.equal(presented.at(-1).navigation, false, "Switching displays the view the page holds");
  await runIdle();
  assert.equal(closeWindow(reopened), true); await runIdle();
  assert.equal(reopened.destroyed, true);
  assert.equal(live().length, 1, "Idle, one hidden window remains");

  // With no loaded page to reuse, a cold spare stays hidden until ready.
  live()[0].destroy();
  let release; holdLoad = new Promise(resolve => { release = resolve; });
  void f.controller.prepare();
  const loading = f.windows.at(-1);
  assert.equal(f.loads.at(-1).request.view, "settings");
  const count = f.windows.length;
  const opening = f.controller.open({ view: "credits" });
  await settle();
  assert.equal(f.windows.length, count, "A cold page paints its shell before starting another refill");
  assert.equal(loading.shows, 0, "A loading page never exposes an empty frame");
  assert.equal(f.controller.stateForWindow(loading, {}).utilityWindow.view, "credits", "Its first state names the requested view");
  release(); holdLoad = null;
  const credits = await opening;
  assert.equal(credits, loading);
  assert.equal(credits.shows, 1);
  await runIdle();

  // With no other hidden window, a closed view stays as the spare.
  live().filter(win => win !== credits).forEach(win => win.destroy());
  assert.equal(closeWindow(credits), true); await runIdle();
  assert.equal(credits.destroyed, false);
  assert.ok(f.controller.isHidden(credits));
  assert.equal(await f.controller.open({ view: "credits" }), credits, "Reopening shows the same window");
  assert.equal(adapted.length, 3, "Its own view needs no switch");
  await runIdle();

  quitting = true;
  assert.equal(closeWindow(credits), false, "Quitting closes kept views");
  assert.equal(credits.destroyed, true);
  delete Window.prototype.hide;
});

test('inactive utility requests keep one native window and never persist presentation intent',async()=>{
  const f=fixture(),request={view:'runtimes',managerId:'graphics-neural-models',activate:false};
  const win=await f.controller.open(request);assert.equal(win.inactive,1);assert.equal(win.focuses,0);assert.equal(win.shows,0);assert.equal(win.options.show,false);
  assert.equal(f.controller.stateForWindow(win,{}).utilityWindow.activate,undefined);assert.equal(f.loads[0].request.activate,undefined);
  assert.equal(await f.controller.open(request),win);assert.equal(f.windows.length,1);assert.equal(win.inactive,2);assert.equal(win.focuses,0);
  assert.equal(await f.controller.open({view:'runtimes'}),win);assert.equal(win.focuses,1);assert.equal(win.shows,1);
  await assert.rejects(f.controller.open({...request,activate:'false'}),/window presentation/);
});

test("utility windows use independent native frames and keep one window per kind", async () => {
  const f = fixture(), library = new Window({ title: "MacLauncher" });
  const windows = await Promise.all(["settings", "runtimes", "credits", "external"].map(view => f.controller.open({ view })));
  assert.equal(new Set(windows).size, 4);
  assert.equal(f.windows.length, 4);
  assert.deepEqual(f.registrations.map(value => value.view), ["settings", "runtimes", "credits", "external"]);
  for (const win of windows) {
    assert.equal(win.options.frame, true);
    assert.equal(win.options.modal, false);
    assert.equal(win.options.show, false, "Created hidden and shown before its view loads");
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
    assert.deepEqual(shown.recents, [], "utility views show no library rows");
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
    assert.throws(() => normalizeUtilityWindowRequest({ view: "runtimes", sectionId }), /Invalid runtime section/);
  }
  // The shader library and presets are in Settings → Graphics. Earlier Runtimes
  // links to presets, or to the shader library filtered by type, open that section.
  assert.deepEqual(readUtilityWindowContext("?view=runtimes&managerId=graphics-presets&sectionId=ed5f88b7-4041"),
    { view: "settings", sectionId: "graphics:presets:ed5f88b7-4041" });
  assert.deepEqual(normalizeUtilityWindowRequest({ view: "runtimes", managerId: "graphics-presets", activate: false }),
    { view: "settings", activate: false, sectionId: "graphics:presets" });
  assert.deepEqual(normalizeUtilityWindowRequest({ view: "runtimes", managerId: "graphics-shader-library", shaderCategory: "image" }),
    { view: "settings", sectionId: "graphics:shaders", shaderCategory: "image" });
  assert.deepEqual(readUtilityWindowContext("?view=settings&sectionId=graphics:shaders&shaderCategory=upscale"),
    { view: "settings", sectionId: "graphics:shaders", shaderCategory: "upscale" });
  assert.throws(() => normalizeUtilityWindowRequest({ view: "settings", sectionId: "graphics:shaders", shaderCategory: "../x" }), /Invalid shader library filter/);
  // Shader collection downloads stay in Runtimes.
  assert.deepEqual(normalizeUtilityWindowRequest({ view: "runtimes", managerId: "graphics-shader-library" }),
    { view: "runtimes", managerId: "graphics-shader-library" });
  assert.deepEqual(normalizeUtilityWindowRequest({ view: "settings", sectionId: "graphics:presets" }),
    { view: "settings", sectionId: "graphics:presets" });
  assert.deepEqual(readUtilityWindowContext("?view=credits&sectionId=ignored"), { view: "credits" });
  assert.deepEqual(normalizeUtilityWindowRequest({ view: "settings", sectionId: "module:android" }),
    { view: "settings", sectionId: "module:android" });
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
  const request = { view: "runtimes", managerId: "host",activate:false };
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

function productionMenuSource(source) {
  // The menu also builds Stop items from running ephemeral entries. Load that
  // production closure rather than replacing the session menu with a stub.
  return ["findGameByPath", "runningEphemeralEntries", "ephemeralStopItems", "setupAppMenu"].map(name => {
    const start = source.indexOf("function " + name + "("), end = source.indexOf("\n}", start);
    assert.ok(start >= 0 && end > start, "The production menu function exists: " + name);
    return source.slice(start, end + 2);
  }).join("\n");
}

test("the production menu opens native utility windows from any focused view and retains native Library and Cmd-W actions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const menu = productionMenuSource(source);
  let template;
  const opened = [];
  const library = {};
  vm.runInNewContext(menu + "\nsetupAppMenu();", { process: { platform: "darwin" }, app: { name: "MacLauncher" },
    moduleAppActions: require("../src/main/module-app-actions").createModuleAppActions({registry: {listModules: () => []}}), appActionIcon: () => null,
    gameRecordsCache: [], runningGameSessions: new Map(), userDataDir: "/fixture-profile",
    EphemeralEntries: require("../src/core/ephemeral-entries"),
    devtoolsEnabled: false, sendToolsMenuEvent() {}, openGamesFromMenu() {}, openUtilityFromMenu: view => opened.push(view),
    ensureLauncherWindow: () => { opened.push("library"); return Promise.resolve(); }, isChildGame: false,
    launcherWindows: new Set([library]), logger: { error() {} },
    appUpdater: { choose: owner => { opened.push(owner === library ? "update:library" : "update"); return Promise.resolve(); } },
    Menu: { buildFromTemplate: value => { template = value; return value; }, setApplicationMenu() {} } });
  const appMenu = template[0].submenu;
  // Check for Updates… follows About, as in other Mac apps.
  assert.deepEqual(Array.from(appMenu.slice(0, 3), item => item.role || item.label), ["about", "Check for Updates…", "Credits"]);
  appMenu[1].click({}, library);
  appMenu[1].click({}, { gameWindow: true });
  assert.deepEqual(opened.splice(0), ["update:library", "update"]);
  const settings = appMenu.find(item => item.label === "Settings…");
  assert.equal(settings.accelerator, "CmdOrCtrl+,");
  settings.click();
  appMenu.find(item => item.label === "Credits").click();
  template.find(item => item.label === "View").submenu.find(item => item.label === "External").click();
  template.find(item => item.label === "View").submenu.find(item => item.label === "Runtimes").click();
  template.find(item => item.label === "View").submenu.find(item => item.label === "Library").click();
  assert.deepEqual(opened, ["settings", "credits", "external", "runtimes", "library"]);
  assert.ok(template.find(item => item.label === "File").submenu.some(item => item.role === "close"));
  // The log moved from the library header to the Help menu.
  const help = template.find(item => item.role === "help");
  assert.deepEqual(Array.from(help.submenu, item => item.label), ["Show Log in Finder"]);
});

test("renderer confirmations become native alerts with Cancel as the default and a verb button", async () => {
  const { confirmActionOptions, registerConfirmAction } = require("../src/main/confirm-action");
  assert.deepEqual(confirmActionOptions({ message: "Forget this game?", detail: "Files stay on disk.", confirmLabel: "Forget", destructive: true }),
    { type: "warning", buttons: ["Cancel", "Forget"], defaultId: 0, cancelId: 0, noLink: true, message: "Forget this game?", detail: "Files stay on disk." });
  assert.equal(confirmActionOptions({ message: "Patch files?", confirmLabel: "Patch" }).type, "question");
  for (const request of [null, { message: "", confirmLabel: "Go" }, { message: "Go?", confirmLabel: "" },
    { message: "Go?", confirmLabel: "x".repeat(65) }, { message: "Go?", confirmLabel: "Go", destructive: "yes" }, { message: "Go?", confirmLabel: "Go", detail: 1 }])
    assert.throws(() => confirmActionOptions(request), /Invalid confirmation/);
  let handler, shown, answer = 1;
  const owner = { isDestroyed: () => false };
  registerConfirmAction({ ipcMain: { handle: (channel, callback) => { assert.equal(channel, "launcher:confirmAction"); handler = callback; } },
    BrowserWindow: { fromWebContents: sender => sender === "sender" ? owner : null },
    dialog: { showMessageBox: async (window, options) => { shown = [window, options.buttons]; return { response: answer }; } } });
  assert.equal(await handler({ sender: "sender" }, { message: "Remove?", confirmLabel: "Remove" }), true);
  assert.deepEqual(shown, [owner, ["Cancel", "Remove"]]);
  answer = 0;
  assert.equal(await handler({ sender: "sender" }, { message: "Remove?", confirmLabel: "Remove" }), false);
});

test("fullscreen keeps the Mac shortcut hidden beside the native command and retains the native role elsewhere", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const menu = productionMenuSource(source);
  function templateFor(platform) {
    let template;
    vm.runInNewContext(menu + "\nsetupAppMenu();", { process: { platform }, app: { name: "MacLauncher" },
      moduleAppActions: require("../src/main/module-app-actions").createModuleAppActions({registry: {listModules: () => []}}), appActionIcon: () => null,
      gameRecordsCache: [], runningGameSessions: new Map(), userDataDir: "/fixture-profile",
      EphemeralEntries: require("../src/core/ephemeral-entries"),
      devtoolsEnabled: false, sendToolsMenuEvent() {}, openGamesFromMenu() {}, openUtilityFromMenu() {}, isChildGame: false,
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
    nativeTheme: { shouldUseDarkColors: true },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, APP_NAME: "MacLauncher", isDebug: false,
    BrowserWindow: class extends Window { constructor(options) { super(options); windows.push(this); } },
    registerLauncherWindow() {}, attachWebContentsLogging() {}, attachDevToolsShortcut() {}, attachDevToolsAutoOpen() {},
    loadLauncherView: async () => { throw new Error("Failed local view"); }, logger: { info() {}, error() {} }
  };
  vm.runInNewContext(mainFunction("createLauncherWindow", "ensureLauncherWindow"), context);
  for (const shouldUseDarkColors of [true, false]) {
    context.nativeTheme.shouldUseDarkColors = shouldUseDarkColors;
    const before = windows.length;
    await assert.rejects(context.createLauncherWindow(), /Failed local view/);
    assert.equal(windows.length, before + 1);
    assert.equal(windows.at(-1).options.backgroundColor, shouldUseDarkColors ? "#111318" : "#f5f6f8");
    assert.equal(windows.at(-1).destroyed, true);
  }
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
    backendService: { request: async (_lane, method, _entry, _settings, options) => {
      if (method === "libraryEntry") {
        assert.equal(options.availability.available, true);
        order.push("checks"); return { checks: { runtimeId: "native", runtimeSupport: ["native"] } };
      }
      assert.equal(method, "importEntry"); order.push("detect"); return { ...entry };
    } }, loadSettings: () => settings,
    findGameByPath: () => null, GameData: { createGameId: () => "game" },
    upsertGame: (_games, detected, _settings, checks) => {
      assert.equal(checks.runtimeId, "native"); return { entry: detected, games: [detected] };
    },
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
  assert.deepEqual(order, ["detect", "checks", "persist", "settings", "broadcast"]);
});

test("runtime import and download sheets follow the focused registered window and never attach to a game", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("  callbacks: {");
  const callbacks = source.slice(start + "  callbacks: ".length, source.indexOf("\n  onEvent:", start)).trim().replace(/,$/, "");
  const ownerSource = source.slice(source.indexOf("function getLauncherDialogOwner()"), source.indexOf("\nfunction openUtilityFromMenu("));
  const library = new Window({}), utility = new Window({}), game = new Window({});
  const calls = [];
  const context = { mainWindow: library, launcherWindows: new Set([library, utility]), focused: utility,
    BrowserWindow: { getFocusedWindow: () => context.focused }, shell: {}, followProcessActivation: () => null,
    dialog: Object.fromEntries(["showOpenDialog", "showSaveDialog", "showMessageBox"].map(method => [method,
      async (...args) => { calls.push([method, ...args]); return { canceled: false, filePaths: ["/chosen/runtime"], response: 0 }; }
    ])), path
  };
  vm.runInNewContext(ownerSource + "\nasync function confirmRuntimeInstallation(" +
    source.split("async function confirmRuntimeInstallation(")[1].split("\nconst launcherService")[0], context);
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

test('utility windows receive the launcher state without library rows, other windows receive it whole', async () => {
  const f = fixture(), win = await f.controller.open({ view: 'runtimes', managerId: 'translator-dxvk' });
  const state = { recents: [{ gamePath: '/game', iconUrl: 'data:image/png;base64,' + 'a'.repeat(1000) }], runtimeManagers: { dxvk: {} }, modules: [] };
  const sent = f.controller.stateForWindow(win, state);
  assert.deepEqual(sent.recents, []);
  assert.equal(sent.runtimeManagers, state.runtimeManagers);
  assert.equal(sent.utilityWindow.managerId, 'translator-dxvk');
  assert.equal(f.controller.stateForWindow({}, state), state, 'the library and per-game windows keep every game');
});


test("utility switches acknowledge the mounted DOM without frame callbacks or timers", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/UtilityApp.tsx"), "utf8");
  const start = source.indexOf('  useLayoutEffect(() => {\n    if (!api?.onUtilityViewSwitch)');
  const effect = source.slice(start, source.indexOf('  const initiallyPainted',start+5)).replaceAll('<HTMLElement>','');
  const slots=['settings','runtimes','credits'].map(view=>({dataset:{utilityView:view},hidden:false}));
  let switchView, cleanup; const reported=[];
  vm.runInNewContext(effect,{utilityRevision:1,api:{onUtilityViewSwitch:callback=>{switchView=callback;return ()=>{};},utilityWindowDrawn:revision=>reported.push(revision)},
    document:{querySelectorAll:()=>slots},useLayoutEffect:callback=>{cleanup=callback();}});
  switchView({view:'credits',revision:73});
  assert.deepEqual(slots.map(slot=>slot.hidden),[true,true,false]);
  assert.deepEqual(reported,[73]);cleanup();
});

test("utility navigation acknowledges its React commit without a hidden frame wait", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/UtilityApp.tsx"), "utf8");
  const start = source.indexOf('  useLayoutEffect(() => {\n    if (utilityRevision');
  const effect = source.slice(start,source.indexOf('  useLayoutEffect(() => {',start+5));
  const reported=[];
  vm.runInNewContext(effect,{api:{utilityWindowDrawn:revision=>reported.push(revision)},utilityRevision:73,utilityView:'settings',initiallyPainted:{current:true},useLayoutEffect:callback=>callback()});
  assert.deepEqual(reported,[73]);
});

test('navigation to a mounting spare is delivered after its initial snapshot was read', async () => {
  let release;
  const loading = new Promise(resolve => {release=resolve;});
  const sent=[];
  const f=fixture({kept:['runtimes'],load:()=>loading,beforeShow:win=>sent.push(f.controller.stateForWindow(win,{}).utilityWindow)});
  const preparing=f.controller.prepare();
  await new Promise(resolve=>setImmediate(resolve));
  const win=f.windows[0];
  const first=f.controller.stateForWindow(win,{}).utilityWindow;
  assert.equal(first.managerId,undefined);
  const opening=f.controller.open({view:'runtimes',managerId:'wine',sectionId:'installed'});
  assert.equal(win.shows,0,'A loading view stays hidden until content is ready');
  assert.deepEqual(sent,[]);
  release();await preparing;await opening;
  assert.equal(sent.at(-1)?.managerId,'wine');
  assert.equal(sent.at(-1)?.sectionId,'installed');
});

test('the utility preload paints its shell before fetching state and retains a newer request', async () => {
  const ipc=new EventEmitter(),messages=[];let api,fetches=0,finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const request={view:'settings',revision:1},heading={textContent:''},shell={dataset:{},querySelector:()=>heading};
  ipc.sendSync=channel=>{assert.equal(channel,'launcher:utilityWindowRequest');return request;};
  ipc.send=(...args)=>messages.push(args);ipc.invoke=channel=>{assert.equal(channel,'launcher:getState');fetches++;return pending;};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/modules/shared/web/preload/launcher.js'),'utf8'),{
    window:{location:{search:'?view=settings'}},URLSearchParams,document:{getElementById:()=>shell},
    require:()=>({ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(_name,value)=>{api=value.launcher;}}})
  });
  assert.equal(fetches,0);assert.equal(api.initialState(),null);
  api.utilityShellReady();assert.equal(heading.textContent,'Settings');assert.equal(shell.dataset.utilityShellView,'settings');
  assert.equal(fetches,0,'Drawing the shell does not fetch or serialize the full state');
  const loading=api.initialStateReady();assert.equal(fetches,1);
  const latest={view:'credits',revision:2};ipc.emit('launcher:utilityViewSwitch',{},latest);
  assert.equal(heading.textContent,'Credits');
  finish({recents:[],utilityWindow:request});
  assert.equal((await loading).utilityWindow,latest);
  const replay=[];const stop=api.onUtilityViewSwitch(value=>replay.push(value),1);
  assert.equal(replay[0],latest,'Mounting controls receive a request newer than their snapshot');stop();
  assert.equal(messages.at(-1)[0],'launcher:utilityWindowDrawn');
});

test('the utility renderer holds all three views without loading the library or inspector', async () => {
  const {build}=require('vite'),Module=require('node:module'),React=require('react');
  const {renderToStaticMarkup}=require('react-dom/server');
  const bundle=await build({configFile:false,logLevel:'silent',build:{
    ssr:path.resolve(__dirname,'../src/renderer/src/ui/UtilityApp.tsx'),write:false,
    rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs',codeSplitting:false}}
  }});
  const chunk=bundle.output.find(chunk=>chunk.type==='chunk');
  assert.ok(!chunk.moduleIds.some(id=>/\/(?:App|GameDetails|GameRow)\.tsx$/.test(id)), 'Utility pages do not parse the library and inspector');
  const compiled=new Module(path.join(__dirname,'utility-render.cjs'),module);compiled.paths=module.paths;
  compiled._compile(chunk.code,compiled.id);
  const state=require('./library-layout-fixture').createLibraryFixture();state.recents=[];
  state.utilityWindow={view:'runtimes',managerId:'fixture-manager',revision:1};
  const previous=globalThis.window;
  globalThis.window={location:{search:'?view=runtimes'},MacLauncher:{launcher:{initialState:()=>state}}};
  try {
    const markup=renderToStaticMarkup(React.createElement(compiled.exports.default || compiled.exports));
    for(const view of ['settings','runtimes','credits'])assert.ok(markup.includes(`data-utility-view="${view}"`));
    assert.match(markup,/data-utility-view="runtimes"><main/);
    assert.doesNotMatch(markup,/game-search-input|gameRow|>Loading…</);
  } finally {globalThis.window=previous;}
});

test('full utility controls produce a content frame before acknowledging their readiness', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/renderer/src/ui/UtilityApp.tsx'),'utf8');
  const start=source.indexOf('  useLayoutEffect(() => {\n    if (utilityRevision');
  const effect=source.slice(start,source.indexOf('  useLayoutEffect(() => { performance.mark',start));
  const frames=[],reported=[],initiallyPainted={current:false};let cleanup;
  vm.runInNewContext(effect,{api:{utilityWindowDrawn:revision=>reported.push(revision)},utilityRevision:1,utilityView:'settings',initiallyPainted,
    requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},cancelAnimationFrame(){},useLayoutEffect:callback=>{cleanup=callback();}});
  assert.deepEqual(reported,[]);
  frames.shift()();assert.deepEqual(reported,[],'The first callback precedes the first content paint');
  frames.shift()();assert.deepEqual(reported,[1]);
  assert.equal(initiallyPainted.current,true);cleanup();
});

test('Settings and Runtimes navigation commits its selection without waiting for passive effects', async () => {
  const {build}=require('vite'),Module=require('node:module'),React=require('react');
  let slots=[],cursor=0,dirty=false;
  const hooks={...React,
    useState(initial){const index=cursor++;if(!slots[index])slots[index]={value:typeof initial==='function'?initial():initial};return [slots[index].value,value=>{const next=typeof value==='function'?value(slots[index].value):value;if(!Object.is(next,slots[index].value)){slots[index].value=next;dirty=true;}}];},
    useRef(initial){return slots[cursor++] ||= {current:initial};},useMemo:create=>create(),useEffect() {}};
  // Passive effects are deliberately not flushed by this render-only harness.
  const compile=async name=>{
    const bundle=await build({configFile:false,logLevel:'silent',build:{ssr:path.resolve(__dirname,`../src/renderer/src/ui/components/${name}.tsx`),write:false,
      rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs',codeSplitting:false}}}});
    const compiled=new Module(path.join(__dirname,name+'-navigation.cjs'),module);compiled.paths=module.paths;
    compiled.require=id=>id==='react'?hooks:Module.prototype.require.call(compiled,id);
    compiled._compile(bundle.output.find(chunk=>chunk.type==='chunk').code,compiled.id);return compiled.exports;
  };
  const render=(fn,...args)=>{let value,count=0;do{cursor=0;dirty=false;value=fn(...args);assert.ok(++count<5,'Navigation settles before commit');}while(dirty);return value;};
  const state=require('./library-layout-fixture').createLibraryFixture();
  const {SettingsView}=await compile('SettingsView');
  const props={state,sectionId:'launcher',navigationKey:1,showIcons:true,showNonDefaultTags:true,onSetLauncherSettings(){},onSetModuleSettings(){}};
  assert.ok(JSON.stringify(render(SettingsView,props)).includes('settings-panel-launcher'));
  const graphics=render(SettingsView,{...props,sectionId:'graphics',navigationKey:2});
  assert.ok(JSON.stringify(graphics).includes('settings-panel-graphics'),'The committed DOM targets Graphics before its ACK');
  slots=[];
  const {useRuntimeManagement}=await compile('RuntimesView');
  const initial={...state,utilityWindow:{view:'runtimes',managerId:'fixture-manager',revision:1}};
  assert.equal(render(useRuntimeManagement,undefined,initial,true,'fixture-manager').runtimeManagerId,'fixture-manager');
  const next={...initial,utilityWindow:{view:'runtimes',managerId:'other-manager',revision:2}};
  const selected=render(useRuntimeManagement,undefined,next,true,'fixture-manager');
  assert.equal(selected.runtimeManagerId,'other-manager');
  assert.equal(selected.runtimeSectionId,null);
  assert.deepEqual(next.runtimeManagers,state.runtimeManagers,'Navigation does not alter automatic choices or defaults');
});

test('prepared Settings navigation sends only the request instead of a full launcher snapshot', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8');
  const controller=source.indexOf('const utilityWindows = createUtilityWindowController');
  const start=source.indexOf('  beforeShow: ',controller)+'  beforeShow: '.length;
  const callback=source.slice(start,source.indexOf('\n',start)).trim().replace(/,$/,'');
  const helperStart=source.indexOf('function sendUtilityWindowRequest(');
  const helper=helperStart<0?'':source.slice(helperStart,source.indexOf('async function presentUtilityWindow(',helperStart));
  const request={view:'settings',sectionId:'launcher',revision:17},messages=[];
  const win={isDestroyed:()=>false,webContents:{send:(...args)=>messages.push(args)}};
  vm.runInNewContext(helper+'\n('+callback+')(win);',{win,KEPT_UTILITY_VIEWS:['settings','runtimes','credits'],
    utilityWindows:{stateForWindow:()=>({utilityWindow:request})},sendState:()=>assert.fail('A prepared navigation must not serialize and render the launcher snapshot')});
  assert.equal(messages.length,1);
  assert.equal(messages[0][0],'launcher:utilityViewSwitch');
  assert.equal(messages[0][1],request);
});

test('a Settings navigation commits its request without rebuilding the mounted Runtimes and Credits panels', async () => {
  const {build}=require('vite'),Module=require('node:module');
  const {react,componentHarness}=require('./helpers/renderer-component');
  const testReact={...react,useLayoutEffect:react.useEffect};
  const bundle=await build({configFile:false,logLevel:'silent',build:{ssr:path.resolve(__dirname,'../src/renderer/src/ui/UtilityApp.tsx'),write:false,
    rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs',codeSplitting:false}}}});
  const compiled=new Module(path.join(__dirname,'utility-navigation.cjs'),module);compiled.paths=module.paths;
  compiled.require=id=>id==='react'?testReact:Module.prototype.require.call(compiled,id);
  compiled._compile(bundle.output.find(chunk=>chunk.type==='chunk').code,compiled.id);
  const state=require('./library-layout-fixture').createLibraryFixture();state.recents=[];state.utilityWindow={view:'settings',revision:1};
  let navigate,requests=0;const reported=[],frames=[];
  const slots=["settings","runtimes","credits"].map(view=>({dataset:{utilityView:view},hidden:view!=="settings"}));
  const previous={document:globalThis.document,window:globalThis.window,raf:globalThis.requestAnimationFrame,cancel:globalThis.cancelAnimationFrame};
  globalThis.document={querySelectorAll:()=>slots};
  globalThis.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};globalThis.cancelAnimationFrame=()=>{};
  globalThis.window={location:{search:'?view=settings'},MacLauncher:{launcher:{initialState:()=>state,getState:async()=>{requests++;return state;},
    onState:()=>()=>{},onUtilityViewSwitch:callback=>{navigate=callback;return ()=>{};},utilityWindowDrawn:revision=>reported.push(revision)}}};
  const pane=(tree,view)=>{const queue=[tree];while(queue.length){const node=queue.shift();if(node?.props?.['data-utility-view']===view)return node.props.children;const children=node?.props?.children;if(children)queue.push(...[children].flat(Infinity));}throw Error('Missing '+view);};
  let harness;
  try {
    harness=componentHarness(compiled.exports.default||compiled.exports,{});
    harness.render();frames.shift()();frames.shift()();
    const before=await harness.settle(),runtimes=pane(before,'runtimes'),credits=pane(before,'credits'),initialRequests=requests;
    navigate({view:'settings',sectionId:'launcher',revision:17});
    const after=harness.render();
    assert.equal(pane(after,'settings').props.sectionId,'launcher');
    assert.equal(pane(after,'runtimes'),runtimes,'Settings navigation retains the already mounted Runtimes tree');
    assert.equal(pane(after,'credits'),credits);
    assert.equal(requests,initialRequests,'Navigation requests no full state');
    assert.equal(state.utilityWindow.revision,1,'The live snapshot is not replaced by navigation');
    assert.equal(reported.at(-1),17,'The target is committed before acknowledgement');
    navigate({view:'credits',revision:18});
    assert.deepEqual(slots.map(slot=>slot.hidden),[true,true,false]);
    navigate({view:'settings',sectionId:'launcher',revision:19});harness.render();
    assert.deepEqual(slots.map(slot=>slot.hidden),[false,true,true],'A targeted request restores the view after an intervening DOM-only switch');
    assert.equal(reported.at(-1),19);
  } finally {harness?.close();globalThis.document=previous.document;globalThis.window=previous.window;globalThis.requestAnimationFrame=previous.raf;globalThis.cancelAnimationFrame=previous.cancel;}
});

test('two different views requested zero milliseconds apart open distinct windows with their own views', async () => {
  const f=fixture({kept:['settings','runtimes','credits'],adapt:(win,options,request)=>{win.title=options.title;win.view=request.view;},
    present:async win=>win.show()});
  await f.controller.prepare();
  const first=f.controller.open({view:'runtimes'}),second=f.controller.open({view:'credits'});
  const [runtimes,credits]=await Promise.all([first,second]);
  assert.notEqual(runtimes,credits,'A second click never replaces the first view');
  assert.equal(f.controller.stateForWindow(runtimes,{}).utilityWindow.view,'runtimes');
  assert.equal(f.controller.stateForWindow(credits,{}).utilityWindow.view,'credits');
  assert.equal(runtimes.title,'Runtimes');assert.equal(credits.title,'Credits');
  assert.equal(runtimes.shows,1);assert.equal(credits.shows,1);
});

test('a different view can show its own shell while the first view is still being presented', async () => {
  let release;const firstPresentation=new Promise(resolve=>{release=resolve;});
  const f=fixture({kept:['settings','runtimes','credits'],present:async(win,request)=>{if(request.view==='runtimes')await firstPresentation;win.show();}});
  await f.controller.prepare();
  const first=f.controller.open({view:'runtimes'});
  let credits;const second=f.controller.open({view:'credits'}).then(win=>{credits=win;return win;});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(credits,'The second window does not wait for the first presentation');
    assert.equal(f.controller.stateForWindow(credits,{}).utilityWindow.view,'credits');
    assert.equal(f.controller.stateForWindow(f.windows[0],{}).utilityWindow.view,'runtimes');
  } finally {release();await first;await second;}
});

test('three simultaneous utility requests keep one distinct window for each view', async () => {
  const f=fixture({kept:['settings','runtimes','credits']});
  await f.controller.prepare();
  const views=['runtimes','credits','settings'];
  const windows=await Promise.all(views.map(view=>f.controller.open({view})));
  assert.equal(new Set(windows).size,3);
  assert.deepEqual(windows.map(win=>f.controller.stateForWindow(win,{}).utilityWindow.view),views);
  assert.ok(windows.every(win=>win.shows===1));
});

test('the utility shell entry has no static React or control dependency', async () => {
  const {build}=require('vite');
  const bundle=await build({configFile:path.resolve(__dirname,'../vite.config.mjs'),logLevel:'silent',build:{write:false}});
  const chunks=new Map(bundle.output.filter(item=>item.type==='chunk').map(item=>[item.fileName,item]));
  const entry=[...chunks.values()].find(chunk=>chunk.isEntry&&chunk.name==='utility');
  assert.ok(entry);
  const queue=[entry],seen=new Set(),modules=[];
  while(queue.length){const chunk=queue.pop();if(seen.has(chunk.fileName))continue;seen.add(chunk.fileName);modules.push(...chunk.moduleIds);for(const name of chunk.imports)if(chunks.has(name))queue.push(chunks.get(name));}
  assert.ok(!modules.some(id=>/node_modules\/(?:react|react-dom)|\/ui\/UtilityApp\.tsx/.test(id)), 'Showing the shell does not wait for the controls or React graph');
  assert.ok(entry.dynamicImports.length>0,'The controls load asynchronously');
  const html=bundle.output.find(item=>item.type==='asset'&&item.fileName==='utility.html').source;
  assert.match(String(html),/id="utility-shell"/);
});

test('a cold second view returns and shows before constructing its next spare', async () => {
  const idle=[];let release,hold;
  const f=fixture({kept:['settings','runtimes','credits'],idle:callback=>idle.push(callback),load:()=>hold,
    present:async win=>{win.shows++;}});
  await f.controller.prepare();
  hold=new Promise(resolve=>{release=resolve;});
  await f.controller.open({view:'runtimes'});
  const second=f.controller.open({view:'credits'});
  release();const credits=await second;
  assert.equal(f.windows.length,2,'No third native constructor runs on the second open path');
  assert.equal(credits.shows,1);
  credits.emit('show');
  assert.equal(f.windows.length,2,'The native show notification finishes before refill');
  assert.equal(idle.length,1);
  idle.shift()();
  assert.equal(f.windows.length,3,'One spare refills after the second native window is visible');
});

test('the Credits shell reserves the real table layout at the top without a visible title', () => {
  const html=fs.readFileSync(path.join(__dirname,'../src/renderer/utility.html'),'utf8');
  const styles=fs.readFileSync(path.join(__dirname,'../src/renderer/src/ui/styles.css'),'utf8');
  const rule=(source,selector)=>{const start=source.indexOf(selector+'{')>=0?source.indexOf(selector+'{'):source.indexOf(selector+' {');assert.ok(start>=0,'Missing '+selector);return source.slice(source.indexOf('{',start)+1,source.indexOf('}',start)).replace(/\s+/g,'');};
  const body=rule(html,'.shell-body'),realBody=rule(styles,'.launcherViewBody');
  assert.ok(body.includes('padding:16px18px')&&realBody.includes('padding:16px18px'),'The table starts at the same content inset');
  const row=rule(html,'.shell-row'),realRow=rule(styles,'.ackRow');
  for(const property of ['grid-template-columns:minmax(180px,3fr)minmax(0,2fr)','gap:12px','padding:10px12px'])assert.ok(row.includes(property)&&realRow.includes(property),property);
  assert.ok(rule(html,'#utility-shell h1').includes('clip-path:inset(50%)'),'Only the native title is visible, as in CreditsView');
  assert.ok(!rule(html,'#utility-shell').includes('display:grid'),'Auto-sized grid rows must not spread the heading and table over the viewport');
});

test('a second request shows within a frame without waiting for the first window refill', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8');
  const start=source.indexOf('  createWindow: ',source.indexOf('const utilityWindows = createUtilityWindowController'))+'  createWindow: '.length;
  const callback=source.slice(start,source.indexOf('\n  loadView:',start)).trim().replace(/,$/,'');
  const windows=[],registered=new Set(),shown=[];let initial=true,fullRefillDone=false;
  const contents=warm=>({warm,getURL:()=>warm?'file:///utility.html':'',clone:()=>contents(true)});
  class NativeWindow extends Window {
    constructor(options){super(options);this.webContents=options.webContents||contents(false);windows.push(this);}
    show(){shown.push({win:this,at:Date.now()});super.show();}
  }
  const createWindow=vm.runInNewContext('('+callback+')',{BrowserWindow:NativeWindow,launcherWindows:registered,
    KEPT_UTILITY_VIEWS:['settings','runtimes','credits'],utilityWindowSize:()=>({}),nativeTheme:{shouldUseDarkColors:false},
    moduleAppActions:{},path,__dirname:path.join(__dirname,'../src/main'),devtoolsEnabled:false});
  const controller=createUtilityWindowController({keptViews:['settings','runtimes','credits'],createWindow,
    registerWindow:(win,view)=>{win.__maclauncherWindowType=view;registered.add(win);},idle:()=>{},
    loadView:async win=>{
      if(initial){initial=false;win.webContents=contents(true);return;}
      // Model the recorded 130 ms cold start versus a warm shell's next frame.
      // Full control preparation remains outstanding until 300 ms in both cases.
      setTimeout(()=>{fullRefillDone=true;},300);
      await new Promise(resolve=>setTimeout(resolve,win.webContents.warm?8:130));
    },present:async win=>win.show()});
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  await controller.prepare();
  const first=controller.open({view:'runtimes'});await flush();
  t.mock.timers.tick(1);
  const requestedAt=Date.now();let credits;
  const second=controller.open({view:'credits'}).then(win=>{credits=win;});
  t.mock.timers.tick(7);await flush();
  assert.ok(credits,'The second show must not wait for a cold process or the full refill');
  assert.notEqual(credits,await first);
  assert.ok(shown.find(row=>row.win===credits).at-requestedAt<=16);
  assert.equal(fullRefillDone,false);
  await second;
});

test('utility control imports start after the shell has a paint opportunity', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/renderer/src/utility.tsx'),'utf8');
  const frames=[];let imports=0;
  // Keep import evaluation pending; only the scheduling before it is under test.
  const scheduled=source.slice(source.indexOf('void new Promise'),source.indexOf('  .then(([React'));
  const runnable=scheduled.replace(/<void>/g,'').replace(/import\([^)]*\)/g,'loadControls()');
  vm.runInNewContext(runnable,{requestAnimationFrame:callback=>frames.push(callback),api:{initialStateReady:()=>null},loadControls:()=>{imports++;return new Promise(()=>{});}});
  assert.equal(imports,0);
  frames.shift()();await Promise.resolve();assert.equal(imports,0);
  frames.shift()();await Promise.resolve();await Promise.resolve();assert.equal(imports,4);
});
