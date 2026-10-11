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

test("normalizeSettings sets default mac variant", () => {
  const normalized = Manager.normalizeSettings({});
  const expectedVariant = process.arch === "arm64" ? "arm64" : "x64";
  assert.equal(normalized.mac.defaultVersion, process.arch === "arm64" ? Runtime.recommendedVersion : null);
  assert.equal(normalized.mac.defaultVariant, expectedVariant);
  assert.equal(normalized.web.defaultVersion, null);
});

test("native defaults select the portable ARM version and preserve explicit old versions and Web defaults", () => {
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "arm64" } }).mac.defaultVersion, Runtime.recommendedVersion);
  assert.equal(Manager.normalizeSettings({ mac: { defaultVariant: "x64" } }).mac.defaultVersion, null);
  assert.equal(Manager.normalizeSettings({ mac: { defaultVersion: "0.7.7beta" } }).mac.defaultVersion, "0.7.7beta");
  assert.equal(Manager.normalizeSettings({ web: { defaultVersion: "0.7.5" } }).web.defaultVersion, "0.7.5");
});

test("applySettingsUpdate handles mac and web defaults", () => {
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
    assert.equal(state.sections[0].label, "ONScripter-Yuri (Included)");
    assert.equal(state.sections[1].id, "web");
    assert.equal(state.sections[1].label, "ONScripter-Yuri Web");
    assert.ok(Array.isArray(state.sections[0].variants));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("updateSettingsAfterUninstall rolls mac defaults to the latest ready installed or included runtime", () => {
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
    assert.equal(next.mac.defaultVersion, available.version);
    assert.equal(next.mac.defaultVariant, available.variant);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("native architecture availability is explicit and catalog inspection performs no installation", t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-variants-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const version = Runtime.catalog[0].version;
  t.mock.method(Runtime, "listInstalledMac", () => [{ version, variant: "arm64", ready: true,
    source: "bundled", bundledExecution: "direct", readOnly: true, removable: false }]);
  t.mock.method(Runtime.bundled, "available", ({ variant }) => variant === "arm64" ? { minimumMacOS: "14.0" } : null);
  const state = Manager.getState({ settings: {}, userDataDir });
  const requirement = state.mac.catalog.versionRequirements[version];
  assert.equal(requirement.variants.arm64.included, true);
  assert.equal(requirement.variants.arm64.installable, false);
  assert.equal(requirement.variants.arm64.minimumMacOS, "14.0");
  assert.equal(requirement.variants.x64.included, false);
  assert.equal(requirement.variants.x64.installable, false);
  assert.match(requirement.variants.x64.installReason, /Apple Silicon/);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});

test("native options keep the portable and stock versions distinct with exact floor and labels", t => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-version-options-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  t.mock.method(Runtime, "listInstalledMac", () => []);
  t.mock.method(Runtime.bundled, "available", () => null);
  const state = Manager.getState({ settings: { mac: { defaultVariant: "arm64" } }, userDataDir });
  const versions = state.mac.catalog.versions;
  assert.equal(versions.filter(version => version === Runtime.recommendedVersion).length, 1);
  assert.equal(versions.filter(version => version === "0.7.7beta").length, 1);
  assert.equal(state.mac.catalog.recommendedVersion, Runtime.recommendedVersion);
  assert.match(state.mac.versionLabels[Runtime.recommendedVersion], /Mac v3/);
  assert.equal(state.mac.catalog.versionRequirements[Runtime.recommendedVersion].variants.arm64.minimumMacOS, "13.0");
  assert.equal(state.web.defaultVersion, null);
});

test("updateSettingsAfterUninstall rolls web defaults to latest install", () => {
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
    assert.equal(next.web.defaultVersion, "0.7.5");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
