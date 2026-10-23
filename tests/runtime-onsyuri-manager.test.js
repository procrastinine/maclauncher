const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/shared/onsyuri/runtime/onsyuri-manager");
const Runtime = require("../src/modules/shared/onsyuri/runtime/onsyuri-runtime");

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

test("Onsyuri installed selection shares Auto and exact overrides between preparation and launch", async t => {
  const current = {version: Runtime.recommendedVersion, variant: "arm64", ready: true};
  const old = {version: "0.7.5", variant: "arm64", ready: true};
  t.mock.method(Runtime, "listInstalledMac", () => [current, old]);
  t.mock.method(Runtime, "listInstalledWeb", () => [{version: "0.7.6"}, {version: "0.7.5"}]);
  const settings = {runtimes: {onsyuri: {mac: {defaultVersion: old.version, defaultVariant: "arm64"}, web: {defaultVersion: "0.7.5"}}}};
  assert.equal(Manager.resolveInstalledSelection({runtimeId: "onsyuri_mac"}, settings, "/unused").install, current);
  assert.equal(Manager.resolveInstalledSelection({runtimeId: "onsyuri_mac", runtimeData: {onsyuri: {version: old.version}}}, settings, "/unused").install, old);
  assert.equal((await Manager.resolveSelection({runtimeId: "onsyuri_web"}, settings, "/unused")).install.version, "0.7.6");
  assert.equal((await Manager.resolveSelection({runtimeId: "onsyuri_web", runtimeData: {onsyuri: {version: "0.7.5"}}}, settings, "/unused")).install.version, "0.7.5");
  const missing = await Manager.resolveSelection({runtimeId: "onsyuri_web", runtimeData: {onsyuri: {version: "0.7.4"}}}, settings, "/unused");
  assert.equal(missing.ready, false);assert.equal(missing.version, "0.7.4");
  assert.equal(Manager.updateSettingsAfterInstall(settings, {version: "new"}, {sectionId: "web"}), undefined);
});

test("normalizeSettings sets default mac variant", () => {
  const normalized = Manager.normalizeSettings({});
  const expectedVariant = process.arch === "arm64" ? "arm64" : "x64";
  assert.equal(normalized.mac.defaultVersion, process.arch === "arm64" ? Runtime.recommendedVersion : null);
  assert.equal(normalized.mac.defaultVariant, expectedVariant);
  assert.equal(normalized.web.defaultVersion, null);
});

test("native Auto retains the portable ARM adaptation and ignores retired global version pins", () => {
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "arm64" } }).mac.defaultVersion, Runtime.recommendedVersion);
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "x64" } }).mac.defaultVersion, null);
  assert.equal(Manager.normalizeSettings({ mac: { defaultVersion: "0.7.7beta" } }).mac.defaultVersion, process.arch === "arm64" ? Runtime.recommendedVersion : null);
  assert.equal(Manager.normalizeSettings({ web: { defaultVersion: "0.7.5" } }).web.defaultVersion, null);
});

test("retired Onsyuri global default actions do not create pins", () => {
  const mac = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "mac", version: "0.7.5", variant: "arm64" },
    {}
  );
  assert.deepEqual(mac, {});

  const web = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "web", version: "0.7.4" },
    {}
  );
  assert.deepEqual(web, {});
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
  const version = Runtime.catalog[0].version;
  t.mock.method(Runtime, "listInstalledMac", () => [{ version, variant: "arm64", ready: true,
    source: "MacLauncher Builds", minimumMacOS: "13.0" }]);
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

test("native options keep the portable and stock versions distinct with exact floor and labels", t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-version-options-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  t.mock.method(Runtime, "listInstalledMac", () => []);
  const state = Manager.getState({ settings: { mac: { defaultVariant: "arm64" } }, userDataDir });
  const versions = state.mac.catalog.versions;
  assert.equal(versions.filter(version => version === Runtime.recommendedVersion).length, 1);
  assert.equal(versions.filter(version => version === "0.7.7beta").length, 1);
  assert.equal(state.mac.catalog.recommendedVersion, Runtime.recommendedVersion);
  assert.match(state.mac.versionLabels[Runtime.recommendedVersion], /Mac v3/);
  assert.equal(state.mac.catalog.versionRequirements[Runtime.recommendedVersion].variants.arm64.minimumMacOS, "13.0");
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
  await Manager.installRuntime({userDataDir,version:Runtime.recommendedVersion,variant:"arm64",sectionId:"mac"});
  await Manager.installRuntime({userDataDir,version:"0.7.6",sectionId:"web"});
  assert.deepEqual(seen,[undefined,undefined]);
  const controller = new AbortController();
  await Manager.installRuntime({userDataDir,version:Runtime.recommendedVersion,variant:"arm64",sectionId:"mac",signal:controller.signal});
  assert.equal(seen[2],controller.signal);
});

test("explicit Onsyuri Refresh retains existing stock Mac download variants alongside Builds profiles", async t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-stock-catalog-");
  t.after(() => fs.rmSync(userDataDir,{recursive:true,force:true}));
  const version = "0.7.6";
  t.mock.method(Runtime,"fetchAvailableVersions",async () => ({macVersions:[version],webVersions:[],releases:[{
    tag_name:"v"+version,assets:[{name:"onsyuri_aarch64_darwin",browser_download_url:"https://example.invalid/native-arm"},
      {name:"onsyuri_x86-64_darwin",browser_download_url:"https://example.invalid/native-intel"}]}]}));
  await Manager.refreshCatalog({userDataDir,sectionId:"mac",force:true});
  const state = Manager.getState({userDataDir,settings:{}});
  const variants = state.mac.catalog.versionRequirements[version].variants;
  assert.equal(variants.arm64.installable,true);
  assert.equal(variants.x64.installable,true);
  assert.deepEqual(state.mac.catalog.includedVersions,[]);
  assert.equal(state.mac.catalog.recommendedVersion,Runtime.recommendedVersion);
  assert.ok(state.mac.catalog.installableVersions.includes(Runtime.recommendedVersion));
});
