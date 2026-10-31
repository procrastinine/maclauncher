const assert = require("node:assert/strict");
const test = require("node:test");
const Host = require("../src/modules/shared/runtime/host-capabilities");

function host(options = {}) {
  return Host.getHostCapabilities({platform: "darwin", launcherArch: "arm64", hardwareArch: "arm64",
    macOSVersion: "26.0", rosettaAvailable: false, ...options});
}

test("runtime defaults follow the launcher process even when a build environment names another CPU", () => {
  const original = process.env.MACLAUNCHER_APP_ARCH;
  try {
    process.env.MACLAUNCHER_APP_ARCH = process.arch === "arm64" ? "x64" : "arm64";
    assert.equal(Host.defaultArchitecture(), process.arch);
    assert.equal(Host.getHostCapabilities().launcherArch, process.arch);
  } finally {
    if (original === undefined) delete process.env.MACLAUNCHER_APP_ARCH;
    else process.env.MACLAUNCHER_APP_ARCH = original;
  }
});

test("Intel launcher under Rosetta keeps Intel downloads while retaining physical hardware capabilities", () => {
  const result = Host.getHostCapabilities({platform: "darwin", launcherArch: "x64", macOSVersion: "26.0",
    execFileSync(command, args) {
      assert.equal(command, "/usr/sbin/sysctl");
      assert.deepEqual(args, ["-n", "hw.optional.arm64"]);
      return "1\n";
    }, fileSystem: {statSync: () => assert.fail("A running translated process already proves Rosetta is present")}});
  assert.equal(result.launcherArch, "x64");
  assert.equal(result.hardwareArch, "arm64");
  assert.equal(result.translated, true);
  assert.equal(result.rosettaAvailable, true);
  assert.equal(result.metal.metal4Supported, null, "Hardware and macOS alone do not prove GPU support");
});

test("architecture support distinguishes runnable, Rosetta prerequisite and impossible builds", () => {
  assert.deepEqual(Host.architectureSupport("x64", host()), {supported: true, installRosetta: true, reason: null});
  assert.deepEqual(Host.architectureSupport("x86_64", host({rosettaAvailable: true})), {supported: true, installRosetta: false, reason: null});
  assert.equal(Host.architectureSupport("arm64", host({launcherArch: "x64", hardwareArch: "x64"})).supported, false);
  assert.match(Host.architectureSupport("arm64", host({launcherArch: "x64", hardwareArch: "x64"})).reason, /Apple Silicon/);
  for (const arch of ["arm64", "aarch64", "universal", "any"]) assert.equal(Host.architectureSupport(arch, host()).supported, true);
  assert.equal(Host.architectureSupport("mips", host()).supported, false);
});

test("Metal 4 uses measured device support and excludes Intel and older macOS", () => {
  const metal = {state: "ready", devices: [{metalfx: {spatial: {metal4Supported: true}}}]};
  assert.equal(host({metal}).metal.metal4Supported, true);
  assert.equal(host({metal, hardwareArch: "x64", launcherArch: "x64"}).metal.metal4Supported, false);
  assert.equal(host({metal, macOSVersion: "15.7"}).metal.metal4Supported, false);
  assert.equal(host({metal: {state: "ready", devices: []}}).metal.metal4Supported, false);
});

test("host status reads Rosetta and macOS locally without starting an installer or GPU process", () => {
  const reads = [];
  const result = Host.getHostCapabilities({platform: "darwin", launcherArch: "arm64", hardwareArch: "arm64",
    execFileSync: () => assert.fail("Local status needs no process when system files are available"),
    fileSystem: {
      readFileSync(file) { reads.push(file); return Buffer.from('<key>ProductVersion</key><string>14.6.1</string>'); },
      statSync(file) { reads.push(file); return {isFile: () => true}; }
    }});
  assert.equal(result.macOSVersion, "14.6.1");
  assert.equal(result.rosettaAvailable, true);
  assert.equal(reads.length, 2);
});

test("runtime build choices list only the CPUs this Mac can run", () => {
  const { withRunnableBuilds } = require("../src/modules/shared/runtime/host-settings");
  const catalog = () => ({ versions: ["1"], architectureCatalogs: { arm64: { versions: ["1"] }, x64: { versions: ["1"] } } });
  const state = { catalog: catalog(), sections: [{ id: "main", catalog: catalog() }, { id: "plain", catalog: { versions: ["2"] } }] };
  const intel = withRunnableBuilds(state, architecture => Host.architectureSupport(architecture, host({ launcherArch: "x64", hardwareArch: "x64" })));
  assert.deepEqual(Object.keys(intel.catalog.architectureCatalogs), ["x64"]);
  assert.deepEqual(Object.keys(intel.sections[0].catalog.architectureCatalogs), ["x64"]);
  assert.deepEqual(intel.sections[1], state.sections[1]);
  const appleSilicon = withRunnableBuilds(state, architecture => Host.architectureSupport(architecture, host()));
  assert.deepEqual(appleSilicon.sections[0].catalog, state.sections[0].catalog);
});

test("Apple-Silicon-only runtimes leave an Intel Mac's game types with their requirement", () => {
  const { withHostSettings, unavailableReason } = require("../src/modules/shared/runtime/host-settings");
  const registry = require("../src/modules/registry");
  const intel = { platform: "darwin", hardwareArch: "x64", macOSVersion: "13.6" };
  const restricted = registry.listModules().filter(mod => Object.values(mod.runtime?.entries || {}).some(entry => entry?.hostFeature));
  assert.ok(restricted.some(mod => mod.id === "android") && restricted.some(mod => mod.id === "ios"));
  for (const mod of restricted) {
    const listed = withHostSettings(mod, intel);
    for (const id of mod.runtime.supported) {
      const reason = unavailableReason(mod.runtime.entries?.[id]?.hostFeature, intel);
      assert.equal(listed.runtime.supported.includes(id), !reason, `${mod.id}: ${id}`);
      if (reason) assert.equal(listed.runtime.unavailableHere[id], "Requires a Mac with Apple Silicon.");
    }
    assert.deepEqual(withHostSettings(mod, host()).runtime.supported, mod.runtime.supported, `${mod.id} keeps every runtime on Apple Silicon`);
  }
  for (const id of ["android", "android-art", "macapk", "android-aim", "playcover"])
    assert.ok(unavailableReason(registry.getRuntimeManagerUi(id)?.hostFeature, intel), `${id} is not offered on Intel`);
});
