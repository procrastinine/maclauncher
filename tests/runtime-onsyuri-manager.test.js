const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/shared/onsyuri/runtime/onsyuri-manager");

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
  assert.equal(normalized.mac.defaultVersion, null);
  assert.equal(normalized.mac.defaultVariant, expectedVariant);
  assert.equal(normalized.web.defaultVersion, null);
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
    assert.equal(state.sections[1].id, "web");
    assert.ok(Array.isArray(state.sections[0].variants));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("updateSettingsAfterUninstall rolls mac defaults to latest install", () => {
  const userDataDir = makeTempDir("maclauncher-onsyuri-");
  try {
    createMacInstall(userDataDir, { version: "0.7.4", variant: "x64" });
    createMacInstall(userDataDir, { version: "0.7.5", variant: "arm64" });

    const settings = { mac: { defaultVersion: "0.7.6", defaultVariant: "x64" } };
    const next = Manager.updateSettingsAfterUninstall(
      settings,
      { sectionId: "mac" },
      { userDataDir }
    );
    assert.equal(next.mac.defaultVersion, "0.7.5");
    assert.equal(next.mac.defaultVariant, "arm64");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
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
