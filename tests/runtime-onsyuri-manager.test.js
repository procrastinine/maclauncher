const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/shared/onsyuri/runtime/onsyuri-manager");
const Runtime = require("../src/modules/shared/onsyuri/runtime/onsyuri-runtime");
// A MacLauncher Builds record as the hosted catalog lists it after Refresh.
const FIXTURE_NATIVE_VERSION = "0.7.7beta-MCLv1";
const HOSTED_ENTRY = Object.freeze({ version: FIXTURE_NATIVE_VERSION, upstreamRevision: "08f744b31cc1907b66a15f0402e62321a131ed81",
  minimumMacOS: "13.0", hostArchitectures: ["arm64"], projectPackage: { arch: "arm64" } });

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMacInstall(userDataDir, { version, variant }) {
  const installDir = path.join(
    userDataDir,
    "runtimes",
    "onsyuri",
    "mac",
    version,
    variant
  );
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "onsyuri"), "");
  return installDir;
}

function createWebInstall(userDataDir, { version }) {
  const installDir = path.join(userDataDir, "runtimes", "onsyuri", "web", version);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "onsyuri-web.7z"), "");
  return installDir;
}

test("Onsyuri installed selection preserves exact choices and the committed initial default", async t => {
  const current = {version: FIXTURE_NATIVE_VERSION, variant: "arm64", ready: true};
  const old = {version: "0.7.5", variant: "arm64", ready: true};
  const intel = { version: "0.7.6", variant: "x64", ready: true };
  t.mock.method(Runtime, "listInstalledMac", () => [current, old, intel]);
  t.mock.method(Runtime, "listInstalledWeb", () => [{version: "0.7.6"}, {version: "0.7.5"}]);
  const settings = {runtimes: {onsyuri: {mac: {defaultVersion: old.version, defaultVariant: "arm64"}, web: {defaultVersion: "0.7.5"}}}};
  assert.equal(Manager.resolveInstalledSelection({runtimeId: "onsyuri_mac"}, settings, "/unused").install, old);
  assert.equal(Manager.resolveInstalledSelection({runtimeId: "onsyuri_mac", runtimeData: {onsyuri: {version: old.version}}}, settings, "/unused").install, old);
  assert.equal((await Manager.resolveSelection({runtimeId: "onsyuri_web"}, settings, "/unused")).install.version, "0.7.5");
  assert.equal((await Manager.resolveSelection({runtimeId: "onsyuri_web", runtimeData: {onsyuri: {version: "0.7.5"}}}, settings, "/unused")).install.version, "0.7.5");
  const missing = await Manager.resolveSelection({runtimeId: "onsyuri_web", runtimeData: {onsyuri: {version: "0.7.4"}}}, settings, "/unused");
  assert.equal(missing.ready, false);assert.equal(missing.version, "0.7.4");
  const unselected = Manager.resolveInstalledSelection({ runtimeId: "onsyuri_mac" }, {}, "/unused");
  assert.equal(unselected.version, FIXTURE_NATIVE_VERSION); assert.equal(unselected.install, current);
  assert.equal(Manager.resolveInstalledSelection({ runtimeData: { onsyuri: { variant: "x64" } } }, {}, "/unused").install, intel, "the Apple Silicon initial default never replaces an Intel selection");
  assert.equal(Manager.updateSettingsAfterInstall({}, {version: "0.8.0"}, {sectionId: "web"}).web.defaultVersion, "0.8.0");
});

test("normalizeSettings sets default mac variant", () => {
  const normalized = Manager.normalizeSettings({});
  const expectedVariant = process.arch === "arm64" ? "arm64" : "x64";
  assert.equal(normalized.mac.defaultVersion, null);
  assert.equal(normalized.mac.defaultVariant, expectedVariant);
  assert.equal(normalized.web.defaultVersion, null);
});

test("Onsyuri preserves its committed Apple Silicon default and explicit global choices", () => {
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "arm64" } }).mac.defaultVersion, null);
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "arm64", defaultVersion: null } }).mac.defaultVersion, null, "a cleared preference stays cleared");
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "x64" } }).mac.defaultVersion, null);
  assert.equal(Manager.normalizeSettings({ mac: { defaultVersion: "0.7.7beta" } }).mac.defaultVersion, "0.7.7beta");
  assert.equal(Manager.normalizeSettings({ web: { defaultVersion: "0.7.5" } }).web.defaultVersion, "0.7.5");
});

test("Onsyuri explicit global choice actions persist native and Web versions", () => {
  const mac = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "mac", version: "0.7.5", variant: "arm64" },
    {}
  );
  assert.equal(mac.mac.defaultVersion, "0.7.5");
  assert.equal(mac.mac.defaultVariant, "arm64");

  const web = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "web", version: "0.7.4" },
    {}
  );
  assert.equal(web.web.defaultVersion, "0.7.4");
});

test("getState exposes mac and web sections", () => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "mac");
    assert.equal(state.sections[0].label, "Native");
    assert.equal(state.sections[1].id, "web");
    assert.equal(state.sections[1].label, "Web");
    assert.ok(Array.isArray(state.sections[0].variants));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Onsyuri Mac uninstall does not write global defaults", () => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-");
  try {
    createMacInstall(userDataDir, { version: "0.7.4", variant: "x64" });
    createMacInstall(userDataDir, { version: "0.7.5", variant: "arm64" });

    const settings = { mac: { defaultVersion: "0.7.6", defaultVariant: "x64" } };
    const available = Runtime.listInstalledMac(userDataDir).find(row => row.ready !== false);
    const next = Manager.updateSettingsAfterUninstall(
      settings,
      { sectionId: "mac" },
      { userDataDir }
    );
    assert.equal(next, undefined);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("native architecture availability is explicit and catalog inspection performs no installation", t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-variants-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const version = FIXTURE_NATIVE_VERSION;
  t.mock.method(Runtime, "listInstalledMac", () => [{ version, variant: "arm64", ready: true,
    source: "MacLauncher Builds", minimumMacOS: "13.0" }]);
  t.mock.method(Runtime.hosted, "getState", () => ({ catalog: { versions: [version], installableVersions: [] } }));
  t.mock.method(Runtime.hosted.core, "listCatalog", () => [HOSTED_ENTRY]);
  const state = Manager.getState({ settings: {}, userDataDir });
  const requirement = state.mac.catalog.versionRequirements[version];
  assert.equal(requirement.variants.arm64.included, false);
  assert.equal(requirement.variants.arm64.installable, false);
  assert.equal(requirement.variants.arm64.minimumMacOS, "13.0");
  assert.equal(requirement.variants.x64.included, false);
  assert.equal(requirement.variants.x64.installable, false);
  assert.match(requirement.variants.x64.installReason, /Apple Silicon/);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});

test("refreshed native options separate hosted and stock versions with exact floor and labels", async t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-version-options-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  t.mock.method(Runtime, "listInstalledMac", () => []);
  t.mock.method(Runtime.hosted, "getState", () => ({ catalog: { versions: [FIXTURE_NATIVE_VERSION], installableVersions: [FIXTURE_NATIVE_VERSION] } }));
  t.mock.method(Runtime.hosted.core, "listCatalog", () => [HOSTED_ENTRY]);
  t.mock.method(Runtime, "fetchAvailableVersions", async () => ({ macVersions: ["0.7.7beta"], webVersions: [], releases: [], source: "https://github.com/YuriSizuku/OnscripterYuri/releases" }));
  await Manager.refreshCatalog({ userDataDir, sourceId: "upstream", force: true });
  const state = Manager.getState({ settings: { mac: { defaultVariant: "arm64" } }, userDataDir });
  const versions = state.mac.catalog.versions;
  assert.equal(versions.filter(version => version === FIXTURE_NATIVE_VERSION).length, 1);
  assert.equal(versions.filter(version => version === "0.7.7beta").length, 1);
  assert.equal(state.mac.catalog.recommendedVersion, undefined);
  assert.equal(state.mac.defaultVersion, FIXTURE_NATIVE_VERSION);
  assert.equal(state.mac.defaultSource, "manager");
  assert.equal(state.mac.versionLabels[FIXTURE_NATIVE_VERSION], FIXTURE_NATIVE_VERSION);
  assert.equal(state.mac.catalog.versionRequirements[FIXTURE_NATIVE_VERSION].variants.arm64.minimumMacOS, "13.0");
  assert.deepEqual(state.mac.catalog.sources[0].versions, [FIXTURE_NATIVE_VERSION]);
  assert.equal(state.mac.catalog.sources[0].installable, true);
  assert.deepEqual(state.mac.catalog.sources[1].versions, ["0.7.7beta"]);
  for (const source of state.mac.catalog.sources) assert.doesNotThrow(() => new URL(source.source));
  assert.equal(state.web.defaultVersion, null);
});

test("Onsyuri Web uninstall does not write global defaults", () => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-");
  try {
    createWebInstall(userDataDir, { version: "0.7.4" });
    createWebInstall(userDataDir, { version: "0.7.5" });

    const settings = { web: { defaultVersion: "0.7.6" } };
    const next = Manager.updateSettingsAfterUninstall(
      settings,
      { sectionId: "web" },
      { userDataDir }
    );
    assert.equal(next, undefined);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Onsyuri optional task signals reach Mac and Web downloads as valid options", async t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-signals-");
  t.after(() => fs.rmSync(userDataDir, {recursive:true,force:true}));
  const seen = [];
  t.mock.method(Runtime, "installMacVersion", async options => { seen.push(options.signal); return {version:options.version}; });
  t.mock.method(Runtime, "installWebVersion", async options => { seen.push(options.signal); return {version:options.version}; });
  await Manager.installRuntime({userDataDir,version:FIXTURE_NATIVE_VERSION,variant:"arm64",sectionId:"mac"});
  await Manager.installRuntime({userDataDir,version:"0.7.6",sectionId:"web"});
  assert.deepEqual(seen,[undefined,undefined]);
  const controller = new AbortController();
  await Manager.installRuntime({userDataDir,version:FIXTURE_NATIVE_VERSION,variant:"arm64",sectionId:"mac",signal:controller.signal});
  assert.equal(seen[2],controller.signal);
});

test("explicit Onsyuri Refresh retains existing stock Mac download variants alongside Builds profiles", async t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-stock-catalog-");
  t.after(() => fs.rmSync(userDataDir,{recursive:true,force:true}));
  const version = "0.7.6";
  t.mock.method(Runtime,"fetchAvailableVersions",async () => ({macVersions:[version],webVersions:[],releases:[{
    tag_name:"v"+version,assets:[{name:"onsyuri_aarch64_darwin",browser_download_url:"https://example.invalid/native-arm"},
      {name:"onsyuri_x86-64_darwin",browser_download_url:"https://example.invalid/native-intel"}]}]}));
  await Manager.refreshCatalog({userDataDir,sectionId:"mac",sourceId:"upstream",force:true});
  const state = Manager.getState({userDataDir,settings:{}});
  const variants = state.mac.catalog.versionRequirements[version].variants;
  assert.equal(variants.arm64.installable,true);
  assert.equal(variants.x64.installable,true);
  assert.deepEqual(state.mac.catalog.includedVersions,[]);
  assert.equal(state.mac.catalog.recommendedVersion,undefined);
  assert.equal(state.mac.catalog.installableVersions.includes(FIXTURE_NATIVE_VERSION),false);
  assert.deepEqual(state.mac.catalog.sources[0].versions,[]);
  assert.deepEqual(state.mac.catalog.sources[1].versions,[version]);
});

test('Onsyuri default reuses ready installed versions when nothing is listed', async t => {
  const userDataDir = makeTempDir('onsyuri-default-');t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
  const previous = '0.7.7beta-macos-v3';
  t.mock.method(Runtime,'listInstalledMac',()=>[{version:previous,variant:'arm64',ready:true}]);
  t.mock.method(Runtime.hosted,'getState',()=>({catalog:{versions:[],installableVersions:[]}}));
  t.mock.method(Runtime.hosted.core,'listCatalog',()=>[]);
  t.mock.method(Runtime,'fetchAvailableVersions',async()=>({releases:[],macVersions:[],webVersions:[]}));
  await Manager.refreshCatalog({userDataDir:userDataDir,sourceId:'upstream',force:true});
  const unset=Manager.resolveInstalledSelection({}, {}, userDataDir);
  assert.equal(unset.ready,true);assert.equal(unset.version,previous);
  const cleared=Manager.resolveInstalledSelection({}, {runtimes:{onsyuri:{mac:{defaultVersion:null,defaultVariant:"arm64"}}}}, userDataDir);
  assert.equal(cleared.version,unset.version);assert.equal(cleared.ready,unset.ready);
  const settings={runtimes:{onsyuri:{mac:{defaultVersion:previous,defaultVariant:'arm64'}}}};
  const selected=Manager.resolveInstalledSelection({}, settings, userDataDir);
  assert.equal(selected.ready,true);assert.equal(selected.version,previous);
  const exact=Manager.resolveInstalledSelection({runtimeData:{onsyuri:{version:FIXTURE_NATIVE_VERSION}}},{},userDataDir);
  assert.equal(exact.ready,false);assert.equal(exact.version,FIXTURE_NATIVE_VERSION);
});
