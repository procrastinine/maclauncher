const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createModuleAppActions } = require("../src/main/module-app-actions");
const Modules = require("../src/modules/registry");

function registry(handlers) {
  const manifests = [
    { id: "alpha", ui: { appActions: [{ id: "apply", label: "Apply Graphics To", menus: ["file", "dock"] }] } },
    { id: "beta", ui: { appActions: [{ id: "other", label: "Other", menus: ["dock"] }, { id: "missing", label: "Missing", menus: ["file"] }] } },
    { id: "gamma", ui: {} }
  ];
  return { listModules: () => manifests, getModule: id => ({ appActions: handlers[id] || {} }) };
}

test("app-scope actions render module targets in the declared menus without naming modules", async () => {
  let apps = [{ id: "application:1", label: "One", iconPath: "/Applications/One.app", target: { kind: "application", pid: 1 } },
    { id: "display", label: "Entire Display", separatorBefore: true, target: { kind: "display" } }];
  const chosen = [];
  const actions = createModuleAppActions({
    registry: registry({
      alpha: { apply: { targets: async () => apps, createEntry: target => ({ gameId: "g" + (target.pid || 0), ephemeral: true, target }) } },
      beta: { other: { targets: async () => [{ id: "x", label: "X" }], createEntry: () => ({ gameId: "x", ephemeral: false }) } }
    }),
    choose: async (...args) => chosen.push(args)
  });
  assert.deepEqual(actions.menuItems("file"), [], "nothing renders before the first refresh");
  assert.equal(await actions.refresh(), true);
  assert.equal(await actions.refresh(), false, "an unchanged list does not rebuild menus");
  const file = actions.menuItems("file", { icon: target => target.iconPath ? "icon:" + target.iconPath : null });
  assert.equal(file.length, 1);
  assert.equal(file[0].label, "Apply Graphics To");
  assert.deepEqual(file[0].submenu.map(item => item.type || item.label), ["One", "separator", "Entire Display"]);
  assert.equal(file[0].submenu[0].icon, "icon:/Applications/One.app");
  file[0].submenu[2].click();
  assert.deepEqual(chosen, [["alpha", "apply", apps[1]]]);
  assert.deepEqual(actions.menuItems("dock").map(item => item.label), ["Apply Graphics To", "Other"]);
  apps = apps.slice(1);
  assert.equal(await actions.refresh(), true);
  assert.deepEqual(actions.menuItems("file")[0].submenu.map(item => item.type || item.label), ["separator", "Entire Display"]);
  assert.deepEqual(actions.createEntry("alpha", "apply", { target: { kind: "application", pid: 3 } }), { gameId: "g3", ephemeral: true, target: { kind: "application", pid: 3 } });
  assert.throws(() => actions.createEntry("beta", "other", { target: {} }), /did not create a session/);
  assert.throws(() => actions.createEntry("gamma", "apply", {}), /unavailable/);
});

test("a failing target list is logged and leaves the other actions", async () => {
  const warnings = [];
  const actions = createModuleAppActions({ logger: { warn: line => warnings.push(line) }, choose: async () => {},
    registry: registry({ alpha: { apply: { targets: async () => { throw new Error("helper failed"); }, createEntry: () => ({}) } },
      beta: { other: { targets: async () => [{ id: "x", label: "X" }], createEntry: () => ({}) } } }) });
  await actions.refresh();
  assert.deepEqual(actions.menuItems("dock").map(item => item.label), ["Other"]);
  assert.match(warnings[0], /alpha\/apply: helper failed/);
});

test("the window module declares its app action through the registry", () => {
  const actions = createModuleAppActions({ registry: Modules, choose: async () => {} }), declared = actions.declared();
  assert.deepEqual(declared.map(({ moduleId, action }) => [moduleId, action.id, action.menus]), [["window", "applyGraphics", ["file", "dock"]]]);
  assert.deepEqual(declared[0].sessionShortcuts, [{ shortcut: "windowPointer", action: "windowTogglePointer" }]);
  assert.equal(actions.canAddTarget("window", "applyGraphics"), false, "each window choice starts its own entry");
  assert.equal(actions.canAddTarget("alpha", "apply"), false);
});

test("a shortcut finds its available action, and sessions get a Stop submenu per action", async () => {
  const actions = createModuleAppActions({ choose: async () => {}, registry: {
    listModules: () => [{ id: "alpha", ui: { appActions: [{ id: "apply", label: "Apply", menus: ["dock"], shortcut: "windowGraphics", stopLabel: "Stop Alpha" }] } }],
    getModule: () => ({ appActions: { apply: { targets: async () => [{ id: "application:5", label: "Five", target: { kind: "application", pid: 5 } }], createEntry: () => ({}) } } }) } });
  assert.equal(actions.forShortcut("windowGraphics"), null, "nothing is available before the first refresh");
  await actions.refresh();
  assert.deepEqual(actions.forShortcut("windowGraphics").targets.map(target => target.target.pid), [5]);
  assert.equal(actions.forShortcut("other"), null);
  const stopped = [];
  const items = actions.stopItems([{ moduleId: "alpha", name: "Five", gamePath: "/a" }, { moduleId: "beta", name: "Other", gamePath: "/b" }], entry => stopped.push(entry.gamePath));
  assert.deepEqual(items.map(item => [item.label, item.submenu.map(row => row.label)]), [["Stop Alpha", ["Five"]]]);
  items[0].submenu[0].click();
  assert.deepEqual(stopped, ["/a"]);
  assert.deepEqual(actions.stopItems([], () => {}), []);
  const opened = [], asked = [];
  const unassigned = actions.stopItems([{ moduleId: "alpha", name: "Five", gamePath: "/a" }], () => {}, null,
    { shortcutLabel: name => { asked.push(name);return null; }, openShortcutSettings: () => opened.push("settings") });
  assert.deepEqual(unassigned[0].submenu.map(row => row.label || row.type), ["Five", "separator", "Toggle Graphics for Front App"]);
  unassigned[0].submenu[2].click();
  assert.deepEqual([asked, opened], [["windowGraphics"], ["settings"]]);
  const assigned = actions.stopItems([{ moduleId: "alpha", name: "Five", gamePath: "/a" }], () => {}, null,
    { shortcutLabel: () => "Control+Option+Command+G", openShortcutSettings: () => opened.push("settings") });
  const command = assigned[0].submenu[2];
  assert.equal(command.label, "Toggle Graphics for Front App");assert.equal(command.accelerator, "Control+Alt+Command+G");
  assert.equal(command.registerAccelerator, false);assert.equal(command.enabled, false, "global shortcuts are references in launcher menus");
  assert.equal(command.click, undefined);
});

test("a session shortcut runs its module action in a running session while its action is available", async () => {
  const requests = [];
  const manifests = [{ id: "alpha", ui: { appActions: [{ id: "apply", label: "Apply", menus: ["dock"], shortcut: "windowGraphics",
    sessionShortcuts: [{ shortcut: "windowPointer", action: "togglePointer" }, { shortcut: 3 }, null, { shortcut: "broken" }] }] } }];
  let targets = [];
  const actions = createModuleAppActions({ choose() {}, registry: { listModules: () => manifests,
    getModule: () => ({ appActions: { apply: { targets: async () => targets, createEntry: () => ({}) } } }) },
    sessions: { request: async (...args) => { requests.push(args);return true; } } });
  assert.deepEqual(actions.declared()[0].sessionShortcuts, [{ shortcut: "windowPointer", action: "togglePointer" }]);
  await actions.refresh();
  assert.equal(actions.sessionShortcut("windowPointer"), null, "an unavailable action holds no session shortcut");
  targets = [{ id: "application:5", label: "Five", target: { kind: "application", pid: 5 } }];
  await actions.refresh();
  assert.deepEqual(actions.sessionShortcut("windowPointer"), { moduleId: "alpha", actionId: "apply", action: "togglePointer" });
  assert.equal(actions.sessionShortcut("windowGraphics"), null);
  const entry = { moduleId: "alpha", gameId: "g" };
  assert.equal(await actions.sessionAction(entry, "togglePointer"), true);
  assert.deepEqual(requests, [[entry, "togglePointer", {}]]);
  assert.equal(createModuleAppActions({ registry: { listModules: () => [] } }).sessionAction(entry, "togglePointer"), false);
});

test("a picker action opens its window from the menus and streams its picker only on request", async () => {
  const manifests = [{ id: "alpha", ui: { appActions: [{ id: "apply", label: "Apply Graphics…", menus: ["file", "dock"], picker: true }] } }];
  const watched = [];
  const handler = { targets: async () => [{ id: "application:1", label: "One", target: { kind: "application", pid: 1 } }],
    createEntry: () => ({}), picker: (context, update) => { watched.push(context);update({ sections: [] });return { stop: () => watched.push("stopped") }; } };
  const opened = [];
  const actions = createModuleAppActions({ registry: { listModules: () => manifests, getModule: () => ({ appActions: { apply: handler } }) }, choose: async () => {} });
  await actions.refresh();
  assert.deepEqual(actions.menuItems("file"), [], "a picker item needs a window to open");
  const [item] = actions.menuItems("dock", { openPicker: (...args) => opened.push(args) });
  assert.equal(item.label, "Apply Graphics…");
  assert.equal(item.submenu, undefined);
  item.click();
  assert.deepEqual(opened, [["alpha", "apply"]]);
  assert.equal(actions.title("alpha", "apply"), "Apply Graphics");
  const updates = [];
  const watch = actions.watchPicker("alpha", "apply", { excludePid: 2 }, update => updates.push(update));
  assert.deepEqual([watched[0], updates], [{ excludePid: 2 }, [{ sections: [] }]]);
  watch.stop();
  assert.equal(watched.at(-1), "stopped");
  assert.throws(() => actions.watchPicker("alpha", "missing", {}, () => {}), /unavailable/);
});

test("window sessions offer each target for removal and keep Stop for the whole helper", async () => {
  const actions = createModuleAppActions({ registry: Modules, choose() {}, sessions: { running: () => ({ moduleId: "window" }) } });
  const entry = { moduleId: "window", gameId: "g", moduleData: { targets: [
    { target: "window", windowID: 3, windowTitle: "Document" }, { target: "display", displayID: 9, displayName: "Screen" }] } };
  const removed = [], stopped = [], requests = [];
  const [item] = actions.stopItems([entry], row => stopped.push(row.gameId), (row, id) => removed.push([row.gameId, id]));
  assert.deepEqual(item.submenu.map(row => row.label || row.type), ["Remove Document", "Remove Screen (Display)", "separator", "Stop"]);
  item.submenu[0].click();item.submenu[1].click();item.submenu[3].click();
  assert.deepEqual(removed, [["g", "w3"], ["g", "d9"]]);assert.deepEqual(stopped, ["g"]);
  const single = { ...entry, name: "Document", moduleData: { targets: [{ target: "window", windowID: 3, windowTitle: "Document" }] } };
  assert.deepEqual(actions.stopItems([single], () => {}, () => {})[0].submenu.map(row => row.label), ["Document"], "one target offers only Stop, by name");
  const long = { ...entry, moduleData: { targets: [{ target: "window", windowID: 3, windowTitle: "x".repeat(80) }, { target: "display", displayID: 9 }] } };
  assert.equal(actions.stopItems([long], () => {}, () => {})[0].submenu[0].label.length, "Remove ".length + 60);
  assert.equal(actions.runningSession("window", "applyGraphics"), null, "a choice never joins a running window entry");
  assert.equal(await actions.addTarget(entry, "applyGraphics", { target: { kind: "display", displayID: 4, name: "Fourth" } }, {
    userDataDir: "/Library", request: async (...args) => { requests.push(args);return true; } }), false);
  assert.deepEqual(requests, []);
});

test("a picker reaches its module's running session, and session events reach only that session's listeners", async () => {
  const { createSessionEvents } = require("../src/main/module-app-actions");
  const events = createSessionEvents(), seen = [], requests = [];
  const entry = { moduleId: "alpha", gameId: "g" };
  let context = null;
  const handler = { targets: async () => [], createEntry: () => ({}), addTarget: () => true,
    picker: value => { context = value;return { stop() {} }; } };
  const manifests = [{ id: "alpha", ui: { appActions: [{ id: "apply", label: "Apply…", menus: ["file"], picker: true }] } }];
  let running = null;
  const actions = createModuleAppActions({ registry: { listModules: () => manifests, getModule: () => ({ appActions: { apply: handler } }) },
    choose() {}, sessions: { running: moduleId => moduleId === "alpha" ? running : null,
      request: async (...args) => { requests.push(args);return true; }, subscribe: (row, listener) => events.subscribe(row.gameId, listener) } });
  actions.watchPicker("alpha", "apply", { excludePid: 2 }, () => {});
  assert.deepEqual(context, { excludePid: 2 }, "without a running session the picker runs on its own");
  running = entry;
  actions.watchPicker("alpha", "apply", { excludePid: 2 }, () => {});
  assert.equal(actions.runningSession("alpha", "apply"), entry);
  assert.equal(await context.session.request("listStart", { a: 1 }), true);
  assert.deepEqual(requests, [[entry, "listStart", { a: 1 }]]);
  const unsubscribe = context.session.subscribe(event => seen.push(event));
  events.dispatch({ gameId: "other", event: { event: "list" } });
  events.dispatch({ gameId: "g", event: { event: "list" } });
  unsubscribe();
  events.dispatch({ gameId: "g", event: { event: "thumbnail" } });
  assert.deepEqual(seen, [{ event: "list" }]);
});

test("Stop menu retains shortcut labels and native accelerators as disabled references", () => {
  const run = [], settings = [], actions = createModuleAppActions({ registry: Modules, choose() {} });
  const entry = { moduleId: "window", gameId: "session", name: "TextEdit", gamePath: "/session", moduleData: {
    targets: [{ target: "window", windowID: 1, pid: 21, applicationName: "TextEdit" }]
  } };
  const menu = actions.stopItems([entry], () => {}, null, {
    shortcutLabel: name => name === "windowGraphics" ? "Control+Option+Command+G" : "Control+Option+Command+P",
    runSessionAction: (owned, action) => run.push([owned, action]), openShortcutSettings: () => settings.push(true)
  })[0].submenu;
  assert.deepEqual(menu.slice(-2).map(item => [item.label, item.accelerator, item.registerAccelerator, item.enabled]), [
    ["Toggle Graphics for Front App", "Control+Alt+Command+G", false, false],
    ["Toggle pointer in window graphics", "Control+Alt+Command+P", false, false]
  ]);
  for (const reference of menu.slice(-2)) assert.equal(reference.click, undefined, "foreground-dependent hotkeys have no menu click dispatch");
  const pointer = menu.find(item => item.sublabel === entry.name);
  assert.equal(pointer.label, "Toggle pointer in window graphics");assert.equal(pointer.accelerator, undefined);
  pointer.click();assert.deepEqual(run, [[entry, "windowTogglePointer"]]);
  const unassigned = actions.stopItems([entry], () => {}, null, { openShortcutSettings: () => settings.push(true) })[0].submenu;
  assert.equal(unassigned.at(-1).sublabel, "Assign in Settings…");unassigned.at(-1).click();assert.equal(settings.length, 1);
});

test("File menu pointer commands use the current owned entry and ignore ended or replaced sessions without a foreground lookup", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("function ephemeralStopItems() {"), end = source.indexOf("// Removes one target", start);
  assert.ok(start >= 0 && end > start);
  const entry = (gameId, gamePath, name, pid) => ({ moduleId: "window", gameId, gamePath, name,
    moduleData: { targets: [{ target: "window", windowID: pid, pid, applicationName: name }] } });
  const first = entry("first", "/first", "TextEdit", 21), second = entry("second", "/second", "Preview", 22);
  const display = { moduleId: "window", gameId: "display", gamePath: "/display", name: "Display",
    moduleData: { targets: [{ target: "display", displayID: 1 }] } };
  let running = [first, second, display];
  const requests = [], errors = [], stopped = [];
  const actions = createModuleAppActions({ registry: Modules, choose() {}, sessions: {
    request: async (owned, action, payload) => { requests.push([owned, action, payload]);return true; }
  } });
  const forbidden = () => { throw new Error("a File-menu session action must not resolve or dispatch a front-app shortcut"); };
  const context = vm.createContext({ moduleAppActions: actions, runningEphemeralEntries: () => running,
    graphicsShortcuts: { status: () => [{ action: "windowGraphics", accelerator: "Control+Option+Command+G" }, { action: "windowPointer", accelerator: "Control+Option+Command+P" }] },
    GraphicsShortcuts: { frontmostPid: forbidden }, toggleAppActionSession: forbidden, runSessionShortcut: forbidden,
    stopGameRuns: async gamePath => stopped.push(gamePath), removeSessionTarget: async () => {},
    utilityWindows: { open: async () => {} }, logger: { error: (...args) => errors.push(args) }
  });
  vm.runInContext(source.slice(start, end), context);
  const submenu = context.ephemeralStopItems()[0].submenu;
  const pointer = submenu.find(item => item.sublabel === first.name);
  const otherPointer = submenu.find(item => item.sublabel === second.name);
  assert.ok(pointer && otherPointer);assert.equal(submenu.some(item => item.sublabel === display.name), false, "display-only entries do not offer app-pointer commands");
  assert.deepEqual(submenu.slice(-2).map(item => [item.enabled, item.click]), [[false, undefined], [false, undefined]]);
  pointer.click();await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);assert.equal(requests[0][0], first);assert.equal(requests[0][1], "windowTogglePointer");assert.deepEqual(requests[0][2], {});
  const refreshed = { ...first, name: "Current record" };running = [refreshed, second, display];
  pointer.click();await new Promise(resolve => setImmediate(resolve));assert.equal(requests.length, 2);assert.equal(requests[1][0], refreshed, "the menu does not dispatch its stored record");
  for (const replacement of [null, { ...first, gameId: "new-incarnation" }, { ...first, gamePath: "/moved" }, { ...first, moduleId: "other" }]) {
    running = [second, display, ...(replacement ? [replacement] : [])];
    pointer.click();await new Promise(resolve => setImmediate(resolve));assert.equal(requests.length, 2, "an old entry's command cannot target a new or ended session");
  }
  otherPointer.click();await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);assert.equal(requests[2][0], second);
  assert.deepEqual(errors, []);assert.deepEqual(stopped, []);
});
