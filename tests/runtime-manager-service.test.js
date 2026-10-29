const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const { writeRuntimeCatalog } = require("../src/modules/shared/runtime/runtime-catalog");
test('default policy hooks receive owned storage and previous settings through custom runtime wrappers',async()=>{
 let settings={defaultVersion:'old'},checked=false;const manager={id:'typed-models',normalizeSettings:value=>({...value}),getState:()=>({}),applySettingsUpdate:(action,payload,current,context)=>{assert.equal(context.userDataDir,'/owned');return {...current,defaultVersion:payload.version};},updateSettingsAfterDefault:(next,payload,context)=>{assert.equal(context.userDataDir,'/owned');assert.deepEqual(context.previousSettings,{defaultVersion:'old'});checked=true;return {...next,defaultVersions:{render:'old',interpolation:payload.version}};}};
 const Custom=require('../src/modules/shared/runtime/custom-runtime');Custom.configure(manager,{defaultsPath:()=>['defaultVersion']});Custom.instrumentManagers([manager]);
 await runRuntimeManagerAction({manager,action:'setDefault',userDataDir:'/owned',payload:{version:'new',userDataDir:'/untrusted'},readSettings:()=>settings,saveSettings:next=>{settings=next;}});assert.equal(checked,true);assert.deepEqual(settings.defaultVersions,{render:'old',interpolation:'new'});
});

test("fresh headless workers retain cached Play defaults and hydrate an explicit default selection offline", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-default-cache-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  writeRuntimeCatalog({ userDataDir, managerId: "cached-default", entries: ["2.5.0", "2.6.0"].map(version =>
    ({ version, upstreamRevision: "a".repeat(40), localBuild: false })) });
  const make = () => createPinnedNativeManager({ id: "cached-default", label: "Cached tool", supportsDefault: true, catalog: [],
    discoverCatalog: () => assert.fail("Cached settings and Play selection must stay offline") });
  let settings = { defaultVersion: "2.5.0" };
  const beforeState = make();
  assert.equal(beforeState.normalizeSettings(settings).defaultVersion, "2.5.0");
  const selected = beforeState.resolveSelection({}, { runtimes: { "cached-default": settings } }, userDataDir);
  assert.equal(selected.version, "2.5.0"); assert.match(selected.reason, /not installed/);
  assert.equal(make().applySettingsUpdate("setDefault", { version: "2.6.0" }, settings).defaultVersion, "2.6.0");
  assert.equal(settings.defaultVersion, "2.5.0", "A pure settings update leaves the previous snapshot intact");
  await runRuntimeManagerAction({ manager: make(), action: "setDefault", userDataDir,
    payload: { version: "v2.6.0" }, readSettings: () => settings, saveSettings: next => { settings = next; } });
  assert.equal(settings.defaultVersion, "2.6.0");
  assert.equal(make().resolveSelection({}, { runtimes: { "cached-default": settings } }, userDataDir).version, "2.6.0");
});

test("catalog refresh gets launcher-owned storage and broadcasts loading and completion", async () => {
  const states = [];
  let state = "idle";
  const manager = { async refreshCatalog(options) {
    assert.equal(options.userDataDir, "/owned/launcher");
    assert.equal(options.force, true);
    assert.equal(options.latestOnly, false);
    state = "loading";
    await Promise.resolve();
    state = "success";
    return { versions: ["1.16", "1.15", "1.14"] };
  } };
  const result = await runRuntimeManagerAction({ manager, action: "refreshCatalog",
    userDataDir: "/owned/launcher", payload: { userDataDir: "/untrusted", latestOnly: false },
    onStateChange: () => states.push(state) });
  assert.deepEqual(states, ["loading", "success"]);
  assert.deepEqual(result.versions, ["1.16", "1.15", "1.14"]);
});

test("runtime import uses a picked directory and persists the actual imported version", async () => {
  const calls = [];
  let settings = { defaultVersion: null };
  const manager = { id: "vendor",
    async importRuntime(options) { calls.push(options); return { version: "2026.1.2.3", ready: true }; },
    updateSettingsAfterInstall(current, record) { return { ...current, defaultVersion: current.defaultVersion || record.version }; }
  };
  await runRuntimeManagerAction({ manager, action: "import", userDataDir: "/owned/launcher",
    payload: { runtimeRoot: "/untrusted", version: "selected-version" }, chooseImportPath: () => "/picked/runtime",
    readSettings: () => settings, saveSettings: next => { settings = next; } });
  assert.equal(calls[0].runtimeRoot, "/picked/runtime");
  assert.equal(calls[0].runtimePath, "/picked/runtime");
  assert.equal(calls[0].version, "selected-version");
  assert.equal(settings.defaultVersion, "2026.1.2.3");
  calls.length = 0;
  const cancelled = await runRuntimeManagerAction({ manager, action: "import", chooseImportPath: () => null });
  assert.equal(cancelled, false);
  assert.equal(calls.length, 0);
});

test("independent installer setup does not change the selected runtime version", async () => {
  let setup;
  const manager = { async performSetupAction(options) { setup = options.setupActionId; return { version: "installer-build" }; },
    updateSettingsAfterInstall() { throw new Error("An installer is not a selected game runtime"); }
  };
  const result = await runRuntimeManagerAction({ manager, action: "setup", payload: { setupActionId: "installIgor" } });
  assert.equal(setup, "installIgor");
  assert.equal(result.version, "installer-build");
});

test("failed refresh broadcasts its final state and preserves the error", async () => {
  const states = [];
  let state = "idle";
  const failure = new Error("Provider unavailable");
  const manager = { async refreshCatalog() { state = "loading"; await Promise.resolve(); state = "error"; throw failure; } };
  await assert.rejects(runRuntimeManagerAction({ manager, action: "refreshCatalog", onStateChange: () => states.push(state) }), error => error === failure);
  assert.deepEqual(states, ["loading", "error"]);
});

test("installed library actions target exactly one installed section/version and use injected file input", async () => {
  let settings = { defaultVersion: "8.4.1" }, input, performed;
  const manager = {
    getState: () => ({ sections: [{ id: "v8", installed: [{ version: "8.5.3", actions: [
      { id: "importLive2D", available: true, inputKind: "file", extensions: ["zip"] }
    ] }] }] }),
    performInstalledAction: async options => { performed = options; return { ready: true }; },
    updateSettingsAfterInstall: () => assert.fail("library installation cannot change the SDK default")
  };
  const base = { manager, action: "installedAction", userDataDir: "/owned", readSettings: () => settings,
    saveSettings: next => { settings = next; }, payload: { sectionId: "v8", version: "8.5.3", installedActionId: "importLive2D" } };
  await runRuntimeManagerAction({ ...base, chooseInstalledActionInput: action => {
    input = action; return { archivePath: "/selected/live2d.zip" };
  } });
  assert.equal(input.extensions[0], "zip"); assert.equal(performed.userDataDir, "/owned");
  assert.equal(performed.version, "8.5.3"); assert.equal(performed.archivePath, "/selected/live2d.zip");
  assert.equal(settings.defaultVersion, "8.4.1");
  performed = null;
  assert.equal(await runRuntimeManagerAction({ ...base, chooseInstalledActionInput: () => null }), false);
  assert.equal(performed, null);
  await assert.rejects(runRuntimeManagerAction({ ...base, payload: { ...base.payload, version: "8.5.2" } }), /unavailable/);
  await assert.rejects(runRuntimeManagerAction({ ...base, payload: { ...base.payload, sectionId: "v7" } }), /unavailable/);
  await runRuntimeManagerAction({ ...base, payload: { ...base.payload, filePaths: ["/headless/cubism.zip"] } });
  assert.deepEqual(performed.filePaths, ["/headless/cubism.zip"]);
});

test("headless runtime imports accept an explicit directory without requiring Electron", async () => {
  let imported;
  await runRuntimeManagerAction({ manager: { importRuntime: options => { imported = options; return { version: "1.0" }; } },
    action: "import", userDataDir: "/owned", payload: { runtimePath: "/chosen/runtime" } });
  assert.equal(imported.runtimePath, "/chosen/runtime"); assert.equal(imported.runtimeRoot, "/chosen/runtime");
});

test("manager setup receives trusted prerequisite consent without changing runtime defaults", async () => {
  const calls = [];
  const confirmRuntimeInstall = () => { calls.push("consent"); return { approved: true, licenseAccepted: true }; };
  const rosetta = { ensure: async context => {
    assert.equal(context.userDataDir, "/owned");
    assert.equal(context.confirmRuntimeInstall, confirmRuntimeInstall);
    assert.deepEqual(await context.confirmRuntimeInstall({ label: "Rosetta" }), { approved: true, licenseAccepted: true });
    calls.push("prerequisite");
  } };
  await runRuntimeManagerAction({ action: "setup", userDataDir: "/owned", rosetta,
    payload: { confirmRuntimeInstall: "untrusted", setupActionId: "installTool" },
    prerequisiteContext: { confirmRuntimeInstall }, manager: {
      performSetupAction: async context => { await context.ensureRosetta(); calls.push("setup"); return true; },
      updateSettingsAfterInstall: () => assert.fail("tool prerequisites cannot change runtime defaults")
    } });
  assert.deepEqual(calls, ["consent", "prerequisite", "setup"]);
});

test("explicit Install and Download actions acquire their assets without a second confirmation", async () => {
  for (const action of ["install", "setup"]) {
    let acquisitions = 0, confirmations = 0;
    const acquire = async context => {
      assert.deepEqual(await context.confirmRuntimeInstall({requiresDownload:true,label:"Selected asset"}),{approved:true});
      acquisitions++;return true;
    };
    await runRuntimeManagerAction({action,userDataDir:"/owned",payload:{confirmRuntimeInstall:"untrusted"},
      prerequisiteContext:{confirmRuntimeInstall:()=>{confirmations++;return {approved:false};}},
      manager:{installRuntime:acquire,performSetupAction:acquire}});
    assert.equal(acquisitions,1);assert.equal(confirmations,0);
  }
});
test("without a consent adapter explicit actions authorize only their own download", async () => {
  for (const action of ["install", "setup"]) {
    const acquire = async context => {
      assert.deepEqual(await context.confirmRuntimeInstall({requiresDownload:true}),{approved:true});
      assert.equal(await context.confirmRuntimeInstall({label:"Other plan"}),false);return true;
    };
    assert.equal(await runRuntimeManagerAction({action,userDataDir:"/owned",manager:{installRuntime:acquire,performSetupAction:acquire}}),true);
  }
});
test("an incidental tool download still uses its existing consent route", async () => {
  let confirmations = 0;
  await runRuntimeManagerAction({action:"installedAction",userDataDir:"/owned",payload:{sectionId:"default",version:"1",installedActionId:"inspect"},
    prerequisiteContext:{confirmRuntimeInstall:()=>{confirmations++;return {approved:false};}},manager:{
      getState:()=>({sections:[{id:"default",installed:[{version:"1",actions:[{id:"inspect"}]}]}]}),
      performInstalledAction:async context=>assert.deepEqual(await context.confirmRuntimeInstall({requiresDownload:true}),{approved:false})}});
  assert.equal(confirmations,1);
});

test("Install sets a newer default only for runtimes and sections that declare it", async () => {
  const run = async (installSetsDefault, { sectionId = "default", current = null, version = "2.0.0" } = {}) => {
    let settings = { defaultVersion: current }, saved = false;
    const manager = { id: "compatible", installSetsDefault, installRuntime: async () => ({ version }),
      getState: ({ settings: value }) => ({ sections: [{ id: "default", defaultVersion: value?.defaultVersion || null }, { id: "addon", defaultVersion: null }] }),
      applySettingsUpdate: (action, payload, value) => action === "setDefault" && payload.sectionId === "default" ? { ...value, defaultVersion: payload.version } : value };
    await runRuntimeManagerAction({ manager, action: "install", userDataDir: "/owned", payload: { version, sectionId },
      readSettings: () => settings, saveSettings: next => { settings = next; saved = true; } });
    return saved ? settings.defaultVersion : null;
  };
  assert.equal(await run(true), "2.0.0", "A first install becomes the default");
  assert.equal(await run(true, { current: "1.9.0" }), "2.0.0", "A newer install replaces an older default");
  assert.equal(await run(true, { current: "2.1.0" }), null, "An older install leaves a newer default");
  assert.equal(await run(["default"], { current: "1.0.0" }), "2.0.0");
  assert.equal(await run(["default"], { sectionId: "addon" }), null, "Undeclared sections keep their default");
  assert.equal(await run(undefined), null, "Runtimes without the declaration keep the user's default");
});

test('registered-only runtimes provide a manager default while published and saved defaults retain priority', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registered-default-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const Custom = require('../src/modules/shared/runtime/custom-runtime');
  let published = null, catalogOnly = null;
  const manager = { id: 'registered-default-fixture', normalizeSettings: value => ({ ...value }),
    getState: ({ settings } = {}) => ({ defaultVersion: settings?.defaultVersion || published,
      defaultSource: settings?.defaultVersion ? 'saved' : 'manager', installed: [], catalog: { versions: catalogOnly ? [catalogOnly] : published ? [published] : [] } }),
    resolveSelection: (_entry, settings) => ({ version: settings?.runtimes?.['registered-default-fixture']?.defaultVersion || published }) };
  Custom.configure(manager, { defaultsPath: () => ['defaultVersion'], inspect: () => ({ ready: true }) });
  Custom.instrumentManagers([manager]);
  const runtimePath = path.join(userDataDir, 'local-runtime');
  await manager.registerCustomRuntime({ userDataDir, runtimePath });
  const automatic = manager.getState({ userDataDir });
  assert.equal(automatic.defaultVersion, runtimePath);assert.equal(automatic.defaultSource, 'manager');
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, runtimePath);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, true);
  const saved = manager.getState({ userDataDir, settings: { customDefaults: { default: runtimePath } } });
  assert.equal(saved.defaultVersion, runtimePath);assert.equal(saved.defaultSource, 'saved');
  published = '9.0';
  assert.equal(manager.getState({ userDataDir }).defaultVersion, '9.0');
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, '9.0');
  published = null;catalogOnly = 'sdk-abcdef';
  assert.equal(manager.getState({ userDataDir }).defaultVersion, catalogOnly, 'A catalog-only manager supplies its published default before a registered path');
  assert.equal(manager.getState({ userDataDir }).defaultSource, 'manager');
});
