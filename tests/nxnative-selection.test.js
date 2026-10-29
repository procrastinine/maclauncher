const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeZipArchive } = require("./helpers/zip-fixture");
const { createManagedPythonTool } = require("../src/modules/shared/runtime/managed-python-tool");
const { confirmToolInstall } = require("../src/modules/shared/runtime/tool-install");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const { createManager } = require("../src/modules/nxnative/runtime/manager");

const VERSION = "git-" + "a".repeat(40), OTHER = "git-" + "b".repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nxnative-selection-")), events = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "source.zip");
  writeZipArchive(archive, [{ name: "source/main.py", data: "print('fixture')\n" }, { name: "source/LICENSE", data: "Fixture license" }]);
  const row = { version: VERSION, url: "https://example.com/nxnative.zip", bytes: fs.statSync(archive).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), archivePrefix: "source" };
  const source = createManagedPythonTool({ id: "nxnative", label: "nxnative", scriptName: "main.py",
    requiredFiles: ["main.py", "LICENSE"], sourceUrl: "https://github.com/seedds/nxnative",
    discoverCatalog: async () => { events.push("discover");return [row]; } });
  let native = null, previous = null;
  const tools = { resolveSelection(_entry, settings) {
    const stored = settings?.runtimes?.["nxnative-tools"], version = stored && Object.hasOwn(stored, "defaultVersion") ? stored.defaultVersion : "tools-1";
    return { version, install: version && native?.version === version ? native : null,
      ready: Boolean(version && native?.version === version), reason: version ? "Native tools are not installed." : "Choose native tools." };
  }, async installRuntime(options) {
    const selected = tools.resolveSelection(null, options.settings);
    if (!selected.version) throw Error(selected.reason);
    if (!selected.ready) {
      await confirmToolInstall(options, { managerId: "nxnative-tools", version: selected.version, requiresDownload: true });
      events.push("install-tools:" + selected.version);
      native = { version: selected.version, root: path.join(root, selected.version), installDir: path.join(root, selected.version) };
    }
    return native;
  } };
  const legacy = { ui: {}, customRuntime: { inspect() { throw Error("Not a custom runtime"); } },
    getState: () => ({ installed: previous ? [previous] : [], catalog: { versions: [], versionRequirements: {} } }),
    resolveSelection(_entry, _settings, _userDataDir, options = {}) {
      const version = options.version || previous?.version;
      return { version: version || null, install: version === previous?.version ? previous : null,
        ready: Boolean(version && version === previous?.version), reason: "Legacy runtime is not installed." };
    }, async installRuntime(options) { events.push("install-legacy:" + options.version);return { version: options.version }; } };
  const manager = createManager({ sourceManager: source, legacyManager: legacy, toolsManager: tools,
    downloadToFile: async (_url, target) => { events.push("download-source");fs.copyFileSync(archive, target); } });
  const context = { userDataDir: path.join(root, "profile"), settings: {}, runtimeId: "nxnative",
    confirmRuntimeInstall: async plan => { events.push("consent:" + plan.managerId + ":" + (plan.version || "discovery"));return true; } };
  return { root, manager, source, context, events, row, tools,
    setNative: value => { native = value; }, setLegacy: value => { previous = value; } };
}

test("nxnative cold Play consents before source discovery, installs native tools and reuses the exact result offline", async t => {
  const f = fixture(t), entry = { moduleId: "nxnative", runtimeId: "nxnative", runtimeData: {} };
  const cold = f.manager.resolveSelection(entry, f.context.settings, f.context.userDataDir);
  assert.equal(cold.version, null);assert.equal(cold.discoveryRequired, true);assert.notEqual(cold.selectionRequired, true);
  assert.deepEqual(f.events, []);
  const mod = { id: "nxnative", runtimeManagers: [f.manager] }, info = { runtime: { manager: { nxnative: "nxnative" } } };
  const registry = { listModuleIds: () => ["nxnative"], getModule: () => mod, listSharedRuntimeManagers: () => [] };
  let installed;
  const prepare = context => prepareForLaunch({ entry, mod, info, context, registry,
    runAction: () => assert.fail("No extra preparation action is required"),
    install: async (manager, payload) => { installed = await manager.installRuntime({ ...context, ...payload,
      confirmRuntimeInstall: plan => plan.managerId === manager.id && (plan.version == null || plan.version === payload.version) ? true : context.confirmRuntimeInstall(plan) }); } });
  assert.equal(await prepare({ ...f.context, confirmRuntimeInstall: async () => false }), false);
  assert.deepEqual(f.events, [], "declined Play neither discovers nor installs");
  assert.equal(await prepare(f.context), true);
  assert.deepEqual(f.events, ["consent:nxnative:discovery", "discover", "download-source", "consent:nxnative-tools:tools-1", "install-tools:tools-1"]);
  assert.equal(installed.version, VERSION);assert.equal(installed.sourceInstall.version, VERSION);
  assert.equal(installed.install.version, "tools-1");assert.equal(installed.toolsVersion, "tools-1");
  assert.equal(installed.toolsManagerId, "nxnative-tools");
  assert.deepEqual(installed.runtimeUses.map(row => [row.managerId, row.version]), [["nxnative", VERSION], ["nxnative-tools", "tools-1"]]);
  const before = [...f.events], selected = f.manager.resolveSelection(entry, {}, f.context.userDataDir);
  assert.equal(selected.ready, true);assert.equal(selected.version, VERSION);
  const reused = await f.manager.installRuntime({ ...f.context, version: VERSION,
    confirmRuntimeInstall: () => assert.fail("Installed source and tools are reused without consent or network") });
  assert.equal(reused.sourceInstall.root, installed.sourceInstall.root);assert.deepEqual(f.events, before);
  assert.deepEqual(f.manager.updateSettingsAfterInstall({}, installed), { defaultVersion: VERSION });
  assert.deepEqual(f.manager.updateSettingsAfterInstall({ defaultVersion: null }, installed), { defaultVersion: VERSION });
});

test("nxnative installed sources needing tools remain selectable and preserve the independent native-tools default", async t => {
  const f = fixture(t);
  await f.source.installRuntime(f.context, { downloadToFile: async (_url, target) => fs.copyFileSync(path.join(f.root, "source.zip"), target) });
  f.events.length = 0;
  const settings = { runtimes: { "nxnative-tools": { defaultVersion: "tools-kept" } } };
  const pending = f.manager.resolveSelection({}, settings, f.context.userDataDir);
  assert.equal(pending.version, VERSION);assert.equal(pending.ready, false);assert.ok(pending.sourceInstall);
  await f.manager.installRuntime({ ...f.context, settings });
  assert.deepEqual(f.events, ["consent:nxnative-tools:tools-kept", "install-tools:tools-kept"]);
  assert.equal(f.manager.resolveSelection({}, settings, f.context.userDataDir).ready, true);
  const clearedTools = { runtimes: { "nxnative-tools": { defaultVersion: null } } };
  assert.equal(f.manager.resolveSelection({}, clearedTools, f.context.userDataDir).ready, false);
  await assert.rejects(f.manager.installRuntime({ ...f.context, settings: clearedTools }), /Choose native tools/);
});

test("nxnative preserves manual, real recommendation, global and explicit-clear layers before fallbacks", async t => {
  const f = fixture(t), settings = { runtimes: { nxnative: { defaultVersion: VERSION } } };
  const select = (entry = {}, cfg = settings, options = {}) => f.manager.resolveSelection(entry, cfg, f.context.userDataDir, options);
  assert.equal(select({ runtimeData: { nxnative: { version: OTHER } } }, settings, { recommendedVersion: VERSION }).version, OTHER);
  assert.equal(select({}, settings, { recommendedVersion: OTHER }).version, OTHER);
  assert.equal(select({}, settings, { recommended: OTHER }).version, OTHER);
  let recommendations = 0;
  const recommendedVersion = () => { recommendations++;return OTHER; };
  assert.equal(select({}, settings, { version: VERSION, recommendedVersion }).version, VERSION);
  assert.equal(recommendations, 0, "manual selection does not evaluate a game recommendation");
  assert.equal(select({}, settings, { recommendedVersion }).version, OTHER);
  assert.ok(recommendations > 0, "automatic selection evaluates the game recommendation");
  assert.equal(select().version, VERSION);
  assert.equal(select({}, settings, { version: "latest" }).version, VERSION, "automatic installation retains the saved global");
  const cleared = { runtimes: { nxnative: { defaultVersion: null } } };
  assert.notEqual(select({}, cleared).selectionRequired, true);assert.equal(select({}, cleared).discoveryRequired, true);
  assert.equal(select({}, cleared, { recommendedVersion: OTHER }).version, OTHER);
  assert.deepEqual(f.events, []);
  const result = await f.manager.installRuntime({ ...f.context, version: "legacy-exact", recommendedVersion: OTHER, settings });
  assert.equal(result.version, "legacy-exact");assert.deepEqual(settings.runtimes.nxnative, { defaultVersion: VERSION });
  assert.deepEqual(f.events, ["install-legacy:legacy-exact"]);
});

test("nxnative retains committed local legacy and cached-source fallbacks without catalog seeds", async t => {
  const f = fixture(t);
  f.setLegacy({ version: "legacy-ready", ready: true, root: path.join(f.root, "legacy") });
  assert.equal(f.manager.resolveSelection({}, {}, f.context.userDataDir).version, "legacy-ready");
  assert.equal(f.manager.resolveSelection({}, {}, f.context.userDataDir).ready, true);
  assert.deepEqual(f.events, []);
  f.setLegacy(null);
  await f.manager.refreshCatalog(f.context);
  const selected = f.manager.resolveSelection({}, {}, f.context.userDataDir);
  assert.equal(selected.version, VERSION);assert.equal(selected.ready, false);assert.equal(selected.sourceInstall, null);
  assert.deepEqual(f.events, ["discover"]);
});

test("nxnative state inventories retain independent native-tools preferences across backend and action contexts", async t => {
  const f = fixture(t), sourceInstall = { version: VERSION, root: path.join(f.root, "source") };
  const own = { defaultVersion: VERSION }, runtimes = { nxnative: own, "nxnative-tools": { defaultVersion: "tools-kept" } };
  const settings = { runtimes, accounts: { privateValue: "not part of runtime state context" } };
  t.mock.method(f.source, "getState", () => ({ installed: [{ ...sourceInstall, ready: true, actions: [{ id: "inspect" }] }],
    catalog: { versions: [VERSION], versionRequirements: {} }, sections: [{ id: "default" }] }));
  t.mock.method(f.source, "resolve", () => sourceInstall);
  f.setNative({ version: "tools-kept", root: path.join(f.root, "tools") });
  const state = cfg => f.manager.getState({ userDataDir: f.context.userDataDir, settings: own, runtimeSettings: cfg.runtimes });
  assert.equal(state(settings).installed[0].ready, f.manager.resolveSelection({}, settings, f.context.userDataDir).ready);
  assert.equal(state(settings).installed[0].ready, true);
  const cleared = { runtimes: { ...runtimes, "nxnative-tools": { defaultVersion: null } } };
  assert.equal(state(cleared).installed[0].ready, f.manager.resolveSelection({}, cleared, f.context.userDataDir).ready);
  assert.equal(state(cleared).installed[0].ready, false);

  const info = { id: "nxnative" }, events = [];
  f.manager.performInstalledAction = async () => "inspected";
  const nativeManager = { id: "nxnative-tools", getState: () => ({ installed: [], catalog: { versions: [] } }),
    applySettingsUpdate: (_action, payload) => ({ defaultVersion: payload.version }) };
  const settingsFile = path.join(f.context.userDataDir, "settings.json");
  fs.mkdirSync(f.context.userDataDir, { recursive: true });fs.writeFileSync(settingsFile, JSON.stringify(settings));
  let unrelatedSave = false;
  const runtimeCoordinator = { async applySettings(_base, patch) {
    const current = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const next = unrelatedSave ? { ...current, audio: { volume: 0.5 } } : { ...current, runtimes: { ...current.runtimes, ...patch.runtimes } };
    fs.writeFileSync(settingsFile, JSON.stringify(next));
  } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModule: () => ({ runtimeManagers: [f.manager, nativeManager] }),
    getModuleInfo: () => info, getModuleDir: () => f.root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  const operations = require("../src/core/backend-operations").createBackendOperations({ userDataDir: f.context.userDataDir, registry,
    runtimeCoordinator, emit: (event, payload) => events.push({ event, payload }) });
  const original = f.manager.getState;
  const received = [];
  t.mock.method(f.manager, "getState", options => {
    received.push(options);
    return original(options);
  });
  await operations.runtimeStates(settings);
  const published = events.find(row => row.event === "runtimeState").payload.state;
  assert.equal(published.sections[0].installed[0].ready, true);
  assert.equal(received[0].settings, own, "the manager's own settings ABI stays intact");
  assert.equal(received[0].runtimeSettings, runtimes, "only the runtime preference map is forwarded");
  assert.equal(Object.hasOwn(received[0], "accounts"), false);
  received.length = 0;
  const result = await require("../src/core/runtime-manager-service").runRuntimeManagerAction({ manager: f.manager,
    action: "installedAction", payload: { version: VERSION, installedActionId: "inspect" }, userDataDir: f.context.userDataDir,
    readSettings: () => own, prerequisiteContext: { settings } });
  assert.equal(result, "inspected");
  assert.ok(received.some(options => options.settings === own && options.runtimeSettings === runtimes), "action workers receive the same preference context");
  events.length = 0;
  await operations.runtimeAction("nxnative-tools", "setDefault", { version: null });
  assert.equal(events.filter(row => row.event === "runtimeChanged").length, 1, "changed runtime preferences invalidate dependent inventories");
  events.length = 0;
  await operations.runtimeStates(JSON.parse(fs.readFileSync(settingsFile, "utf8")));
  assert.equal(events.find(row => row.event === "runtimeState" && row.payload.id === "nxnative").payload.state.installed[0].ready, false);
  events.length = 0;unrelatedSave = true;
  await operations.runtimeAction("nxnative-tools", "setDefault", { version: null });
  assert.equal(events.some(row => row.event === "settingsChanged"), true);
  assert.equal(events.some(row => row.event === "runtimeChanged"), false, "an unrelated settings save does not invalidate every runtime");
  assert.deepEqual(f.events, [], "state checks do not discover, download or install source/tools");
});
