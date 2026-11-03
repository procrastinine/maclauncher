const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {parseSync} = require("rolldown/experimental");

const root = path.resolve(__dirname, ".."), renderer = path.join(root, "src/renderer/src");
const appFile = path.join(renderer, "ui/App.tsx");
const parents = new WeakMap();
function parse(file) {
  const result = parseSync(file, fs.readFileSync(file, "utf8"));
  assert.deepEqual(result.errors, [], `${file}: renderer source parses`);
  return result.program;
}
function children(node, callback) {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") callback(child);
    } else if (value && typeof value.type === "string") callback(value);
  }
}
function visit(node, callback, parent) {
  if (parent) parents.set(node, parent);
  callback(node); children(node, child => visit(child, callback, node));
}
const isString = node => node?.type === "Literal" && typeof node.value === "string";
const isFunction = node => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
function files(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}
function name(node) {
  if (!node) return null;
  return node.type === "Identifier" ? node.name : node.type === "MemberExpression"
    ? node.computed ? isString(node.property) ? node.property.value : null : node.property.name : null;
}
function containingFunction(node) {
  for (let parent = parents.get(node); parent; parent = parents.get(parent))
    if (isFunction(parent) && parent.id) return parent.id.name;
  return null;
}
function uiDispatches() {
  const dispatches = [], forwards = [];
  for (const file of files(renderer)) visit(parse(file), node => {
    if (node.type !== "CallExpression") return;
    if (name(node.callee) === "onRuntimeAction") {
      assert.ok(isString(node.arguments[1]), `${file}: runtime operations must retain their explicit action ID`);
      dispatches.push({action: node.arguments[1].value, node, file, wrapper: containingFunction(node)});
    } else if (name(node.callee) === "runtimeAction") {
      if (isString(node.arguments[1])) dispatches.push({action: node.arguments[1].value, node, file});
      else {
        assert.equal(containingFunction(node), "onRuntimeAction", `${file}: cover any new runtime-action forwarding adapter`);
        assert.deepEqual(node.arguments.map(name), ["managerId", "action", "payload"]);
        forwards.push(node);
      }
    }
  });
  assert.ok(forwards.length > 0, "The actual renderer IPC adapter is covered");
  assert.ok(dispatches.length > 0, "The actual UI dispatches are covered");
  return dispatches;
}
function ownedProfile(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-action-contract-"));
  const home = path.join(directory, "home"), userDataDir = path.join(directory, "profile");
  fs.mkdirSync(home); fs.mkdirSync(userDataDir);
  t.mock.method(os, "homedir", () => home);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {home, userDataDir};
}

test("every runtime action emitted by the renderer reaches its real service handler", async t => {
  const {userDataDir} = ownedProfile(t);
  const {runRuntimeManagerAction} = require("../src/core/runtime-manager-service");
  const handlers = {refreshCatalog: "refreshCatalog", registerCustom: "registerCustomRuntime", install: "installRuntime",
    import: "importRuntime", installedAction: "performInstalledAction", setup: "performSetupAction",
    uninstall: "uninstallRuntime", setDefault: "applySettingsUpdate"};
  const actions = new Set(uiDispatches().map(row => row.action));
  for (const action of actions) {
    const calls = [], contexts = [];
    // No id means no real registry manager, coordinator, download or installation.
    const manager = Object.fromEntries(Object.values(handlers).map(method => [method, (...args) => {
      calls.push(method); contexts.push(args); return {version: "fixture-1"};
    }]));
    manager.getState = () => ({sections: [{id: "default", installed: [{version: "fixture-1", actions: [{id: "fixture-installed"}]}]}]});
    const payload = {sectionId: "default", version: "fixture-1", setupActionId: "fixture-setup", installedActionId: "fixture-installed", force: false};
    await runRuntimeManagerAction({manager, action, payload, userDataDir, readSettings: () => ({}),
      chooseImportPath: () => path.join(userDataDir, "selected-source"),
      rosetta: {ensure: () => assert.fail("Dispatch coverage cannot acquire Rosetta")}});
    assert.deepEqual(calls, [handlers[action]], `${action} must reach its corresponding service operation`);
    if (action === "refreshCatalog") assert.equal(contexts[0][0].force, true, "Refresh always means an explicit fresh catalog request");
    if (action === "setup") assert.equal(contexts[0][0].setupActionId, payload.setupActionId);
    if (action === "installedAction") assert.equal(contexts[0][0].installedActionId, payload.installedActionId);
  }
  t.diagnostic(`${actions.size} renderer action IDs exercised through the real service`);
});

test("descriptor IDs stay inside setup/installed payloads and startup effects send no runtime actions", () => {
  const source = parse(appFile), dispatches = uiDispatches();
  for (const [wrapper, action, key] of [["onRuntimeSetupAction", "setup", "setupActionId"],
    ["onRuntimeInstalledAction", "installedAction", "installedActionId"]]) {
    const matches = dispatches.filter(row => row.wrapper === wrapper);
    assert.equal(matches.length, 1, wrapper);
    const call = matches[0].node;
    assert.equal(call.arguments[1].value, action);
    assert.equal(call.arguments[2].type, "ObjectExpression");
    assert.ok(call.arguments[2].properties.some(property => name(property.key) === key), `${wrapper} retains the nested descriptor ID`);
  }
  const runtimeWrappers = new Set(dispatches.map(row => row.wrapper).filter(Boolean));
  let effects = 0;
  visit(source, node => {
    if (node.type !== "CallExpression" || name(node.callee) !== "useEffect") return;
    const callback = node.arguments[0];
    if (!callback || !isFunction(callback)) return;
    effects++;
    function inspect(current) {
      // Deferred event handlers are not startup work.
      if (current !== callback && isFunction(current)) return;
      if (current.type === "CallExpression") {
        const called = name(current.callee);
        assert.ok(called !== "runtimeAction" && called !== "onRuntimeAction" && !runtimeWrappers.has(called),
          `Startup effect must not dispatch ${called}`);
      }
      children(current, inspect);
    }
    inspect(callback);
  });
  assert.ok(effects > 0, "Startup effects are actually inspected");
});

test("every registered manager's exposed runtime controls have handlers and state stays offline", async t => {
  const {userDataDir} = ownedProfile(t), attempted = [];
  const deny = description => { attempted.push(description); throw new Error(`State inspection attempted ${description}`); };
  t.mock.method(globalThis, "fetch", () => deny("fetch"));
  for (const protocol of [require("node:http"), require("node:https")])
    for (const method of ["request", "get"]) t.mock.method(protocol, method, () => deny(`network ${method}`));
  t.mock.method(require("node:net").Socket.prototype, "connect", () => deny("socket connection"));
  // Import after the owned-home and network guards, including any eager module declarations.
  const registry = require("../src/modules/registry");
  const managers = require("../src/core/runtime-preparation").listRuntimeManagers(registry);
  const byId = new Map(managers.map(manager => [manager.id, manager]));
  assert.ok(managers.length > 0);
  let sectionsChecked = 0, descriptors = 0;
  for (const info of registry.listModules()) {
    const declared = info.runtime?.manager;
    for (const id of typeof declared === "string" ? [declared] : Object.values(declared || {}))
      assert.ok(byId.has(id), `${info.id} names registered runtime manager ${id}`);
    for (const [id, ui] of Object.entries(info.runtime?.managerUi || {})) {
      assert.ok(byId.has(id), `${info.id} runtime UI names registered manager ${id}`);
      assert.ok(ui && typeof ui === "object");
    }
  }
  for (const manager of managers) {
    const handler = (method, control) => assert.equal(typeof manager[method], "function", `${manager.id}: ${control} needs ${method}`);
    handler("getState", "state");
    // The audit never executes actual install/import/removal/setup handlers.
    for (const method of ["refreshCatalog", "installRuntime", "importRuntime", "registerCustomRuntime", "performSetupAction", "performInstalledAction", "uninstallRuntime"])
      if (typeof manager[method] === "function") t.mock.method(manager, method, () => deny(`${manager.id}.${method}`));
    const settings = manager.normalizeSettings?.({}) || {};
    const state = await manager.getState({userDataDir, settings, runtimeSettings: {}, home: os.homedir(), logger: {debug() {}, info() {}, warn() {}, error() {}}});
    assert.ok(state && typeof state === "object", `${manager.id} has local state`);
    const sections = state.sections?.length ? state.sections : [{...state, id: "default"}];
    for (const section of sections) {
      sectionsChecked++;
      const catalog = section.catalog;
      if (catalog && !catalog.packagesFrom) handler("refreshCatalog", `${section.id} catalog reload`);
      if (catalog?.importable) handler("importRuntime", `${section.id} import`);
      if (catalog?.installable) handler("installRuntime", `${section.id} install`);
      if (section.customRuntime) handler("registerCustomRuntime", `${section.id} custom registration`);
      if (section.supportsDefault === true) handler("applySettingsUpdate", `${section.id} default selection`);
      for (const action of section.setupActions || state.setupActions || []) {
        descriptors++; assert.equal(typeof action.id, "string");
        handler("performSetupAction", `${section.id} setup descriptor ${action.id}`);
      }
      for (const installed of section.installed || []) {
        if (installed.removable !== false) handler("uninstallRuntime", `${section.id} installed removal`);
        if (installed.ready !== false && (installed.custom || section.supportsDefault !== false))
          handler("applySettingsUpdate", `${section.id} installed default selection`);
        for (const action of installed.actions || []) {
          descriptors++; assert.equal(typeof action.id, "string");
          handler("performInstalledAction", `${section.id} installed descriptor ${action.id}`);
        }
      }
    }
  }
  assert.deepEqual(attempted, [], "Registry status cannot fetch, connect, acquire or mutate runtimes");
  t.diagnostic(`${managers.length} registered managers, ${sectionsChecked} sections and ${descriptors} setup/installed descriptors inspected offline`);
});
