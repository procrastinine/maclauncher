// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Manager = require("../src/modules/shared/web/runtime/nwjs-manager");
const Architecture = require("../src/modules/shared/runtime/architecture");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nwjs-architecture-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
function installation(root, architecture) {
  const platformKey = architecture === "x64" ? "osx-x64" : "osx-arm64";
  const installDir = path.join(root, "runtimes/nwjs/0.107.0", platformKey, "sdk");
  const contents = path.join(installDir, "nwjs.app/Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), {recursive: true});
  fs.writeFileSync(path.join(contents, "MacOS/nwjs"), "#!/bin/sh\nexit 0\n", {mode: 0o755});
  fs.writeFileSync(path.join(contents, "Info.plist"), '<plist><dict><key>CFBundleExecutable</key><string>nwjs</string></dict></plist>');
  return installDir;
}

test("one NW.js version index supplies both CPU lists and retains automatic Rosetta fallback", async t => {
  t.after(() => { Harness.network.routes = null; });
  Harness.network.routes = {"https://nwjs.io/versions.json": [
    {version: "v0.119.0", files: ["osx-arm64", "osx-x64"], flavors: ["sdk"]},
    {version: "v0.80.0", files: ["osx-x64"], flavors: ["sdk"]}
  ]};
  const result = await Manager.core.fetchAvailableVersions({arch: "arm64"});
  assert.deepEqual(result.architectureCatalogs.arm64.versions, ["0.119.0"]);
  assert.deepEqual(result.architectureCatalogs.x64.versions, ["0.119.0", "0.80.0"]);
  assert.deepEqual(result.installableVersions, ["0.119.0", "0.80.0"]);
  assert.equal(result.availabilityByVersion["0.80.0"].rosettaFallback, true);
});

test("both NW.js builds coexist and explicit selection reaches the matching ordinary and patched launch config", async t => {
  const userDataDir = fixture(t), dirs = {arm64: installation(userDataDir, "arm64"), x64: installation(userDataDir, "x64")};
  const settings = {runtimes: {nwjs: {defaultVersion: "0.107.0", defaultArchitecture: "x64"}}};
  t.mock.method(global, "fetch", () => assert.fail("Installed architecture selection stays offline"));
  for (const architecture of ["arm64", "x64"]) {
    const entry = {runtimeId: "nwjs", gamePath: userDataDir, runtimeData: {nwjs: {version: "0.107.0", architecture}}};
    const selected = await Manager.resolveSelection(entry, settings, userDataDir);
    assert.equal(selected.install.installDir, dirs[architecture]);
    assert.equal(selected.installOptions.architecture, architecture);
  }
  const Ordinary = require("../src/modules/shared/web/runtime/nwjs-launcher");
  const Patched = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");
  assert.equal(Ordinary.resolveRuntimeConfig(settings.runtimes.nwjs, {}, {userDataDir}).architecture, "x64");
  assert.equal(Patched.resolveRuntimeConfig({managerSettings: settings.runtimes.nwjs, userDataDir}).architecture, "x64");
  const state = Manager.getState({settings: settings.runtimes.nwjs, userDataDir});
  assert.deepEqual(new Set(state.installed.map(row => row.architecture)), new Set(["arm64", "x64"]));
  assert.equal(state.launcherArchitecture, process.arch);
  Manager.uninstallRuntime({userDataDir, version: "0.107.0", platformKey: "osx-x64", variant: "sdk"});
  assert.equal(fs.existsSync(dirs.arm64), true);
  assert.equal(fs.existsSync(dirs.x64), false);
});

test("manual NW.js install passes target CPU without changing its SDK flavor", async t => {
  const userDataDir = fixture(t), target = process.arch === "arm64" ? "x64" : "arm64";
  t.mock.method(Manager.core, "installVersion", async options => {
    assert.equal(options.arch, target);
    assert.equal(options.variant, "sdk");
    return {version: options.version, platformKey: target === "x64" ? "osx-x64" : "osx-arm64"};
  });
  const installed = await Manager.installRuntime({userDataDir, version: "0.119.0", architecture: target, variant: "sdk"});
  assert.equal(installed.architecture, target);
  assert.equal(Architecture.selectedArchitecture(), process.arch);
});
