const assert = require("node:assert/strict");
const test = require("node:test");
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
  const declared = createModuleAppActions({ registry: Modules, choose: async () => {} }).declared();
  assert.deepEqual(declared.map(({ moduleId, action }) => [moduleId, action.id, action.menus]), [["window", "applyGraphics", ["file", "dock"]]]);
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
});
