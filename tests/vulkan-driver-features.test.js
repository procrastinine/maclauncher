const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// A stand-in for the graphics payload's maclauncher-vulkan-features helper: it
// answers with the device features each fixture driver reports and counts its runs.
function helperFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-features-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "maclauncher-vulkan-features"), runs = path.join(root, "runs");
  fs.writeFileSync(file, `#!/bin/sh\necho "$1" >> "${runs}"\ncase "$1" in\n` +
    `  *MoltenVK*) echo '{"schema":1,"devices":[{"name":"Apple M2 Max","features":{"geometryShader":false,"tessellationShader":true}}]}' ;;\n` +
    `  *kosmickrisp*) echo '{"schema":1,"devices":[{"name":"Apple M2 Max","features":{"geometryShader":true,"tessellationShader":true}}]}' ;;\n` +
    `  *) echo "not a Vulkan driver" >&2; exit 3 ;;\nesac\n`, { mode: 0o755 });
  const driver = (name, library) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, library), require("./fixtures/macho-image").image());
    return directory;
  };
  return { tool: { file, key: `fixture:${root}` }, driver, runs: () => fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").length : 0 };
}
function withHelper(t, tool) {
  const VulkanFeatures = require("../src/modules/shared/runtime/vulkan-features"), original = VulkanFeatures.helper;
  VulkanFeatures.helper = () => tool;
  t.after(() => { VulkanFeatures.helper = original; });
}

test("an installed Vulkan driver's description records the device features its library reports, measured once", t => {
  const Description = require("../src/modules/shared/runtime/translator-description");
  const fixture = helperFixture(t);
  const moltenvk = fixture.driver("moltenvk", "libMoltenVK.dylib"), kosmic = fixture.driver("kosmickrisp", "libvulkan_kosmickrisp.dylib");
  // Without the helper the driver is described with nothing measured.
  withHelper(t, null);
  assert.equal(Object.hasOwn(Description.describeTranslator(moltenvk, { engine: "moltenvk", version: "1.4.2", source: "fixture" }), "vulkanFeatures"), false);
  // With it, the same driver is described again and measured, once per installed version.
  withHelper(t, fixture.tool);
  assert.equal(Description.describeTranslator(moltenvk, { engine: "moltenvk", version: "1.4.2", source: "fixture" }).vulkanFeatures.geometryShader, false);
  assert.equal(Description.describeTranslator(moltenvk, { engine: "moltenvk", version: "1.4.2", source: "fixture" }).vulkanFeatures.geometryShader, false);
  assert.equal(fixture.runs(), 1, "a described driver is not measured again");
  assert.equal(Description.describeTranslator(kosmic, { engine: "kosmickrisp", version: "27.0.0", source: "fixture" }).vulkanFeatures.geometryShader, true);
  // The install record keeps the measurement.
  assert.deepEqual(Description.installationDescription(Description.describeTranslator(moltenvk, { engine: "moltenvk", version: "1.4.2", source: "fixture" })).vulkanFeatures,
    { geometryShader: false, tessellationShader: true });
  // A library the helper cannot measure leaves the driver unmeasured.
  const other = fixture.driver("other", "libother.dylib");
  assert.equal(Object.hasOwn(Description.describeTranslator(other, { engine: "moltenvk", version: "9", source: "fixture" }), "vulkanFeatures"), false);
  // The helper is a graphics payload target.
  assert.match(read("src/modules/shared/reshade/native/CMakeLists.txt"), /add_executable\(maclauncher-vulkan-features src\/vulkan-features\.c\)/);
  assert.match(read("src/modules/shared/reshade/native/vulkan-features.c"), /dlsym\(driver, "vk_icdGetInstanceProcAddr"\)/);
  assert.equal(require("../src/modules/shared/reshade/features.json").graphics.vulkanFeatureQueryAPI, 1);
});

// Installed choices as managedTranslators reads them from install records.
// Each release has files of its own.
const record = (component, engine, version, source, extra = {}) => ({ component, engine, version, source, form: component === "vulkan-driver" ? "icd" : "builtin", apis: [],
  files: component === "vulkan-driver" ? [{ path: `/fixture/${engine}-${version}/libdriver.dylib`, relative: "libdriver.dylib", format: "macho", cpuSlices: ["arm64", "x86_64"] }]
    : [{ path: `/fixture/${engine}-${version}-${source.id || source.kind}/x64/d3d11.dll`, relative: "x64/d3d11.dll", format: "pe" }], ...extra });
function manager(id, engine, sourceIds, installs) {
  const declarations = require("../src/runtime-sources").loadSources();
  return { id, translatorEngine: engine, sources: sourceIds.map(source => declarations.find(item => item.id === source)),
    getState: () => ({ installed: installs.map(([version]) => ({ version })) }),
    resolveSelection: (_entry, _settings, _userDataDir, { version }) => ({ install: { version, installDir: "/fixture", translator: installs.find(row => row[0] === version)[1] } }) };
}
function installedChoices(t, measured = { "1.4.2": false, "27.0.0": true }) {
  const Wine = require("../src/modules/shared/runtime/wine-translators");
  withHelper(t, { file: "/fixture/maclauncher-vulkan-features", key: "fixture" });
  const managers = [
    manager("translator-dxvk", "dxvk", ["dxvk-upstream", "dxvk-macos"], [
      ["macos-dxvk-v1.10.3", record("d3d-renderer", "dxvk", "1.10.3", { kind: "upstream", id: "macos", label: "DXVK-macOS" })],
      ["upstream-dxvk-3.1.1", record("d3d-renderer", "dxvk", "3.1.1", { kind: "upstream", id: "upstream", label: "DXVK" })]]),
    manager("dxvk", "dxvk", ["maclauncher-dxvk"], [["3.1.1-MCLv1", record("d3d-renderer", "dxvk", "3.1.1", { kind: "builds", label: "MacLauncher Builds" })]]),
    // MoltenVK was installed before the helper existed; KosmicKrisp's install record holds its measurement.
    manager("vulkan-moltenvk", "moltenvk", ["khronos-moltenvk"], [["1.4.2", record("vulkan-driver", "moltenvk", "1.4.2", "upstream")]]),
    manager("maclauncher-kosmickrisp", "kosmickrisp", ["maclauncher-kosmickrisp"], [["27.0.0", record("vulkan-driver", "kosmickrisp", "27.0.0", "upstream",
      { vulkanFeatures: { geometryShader: measured["27.0.0"] } })]]),
    manager("vulkan-kosmickrisp", "kosmickrisp", [], [["3.4.3", record("vulkan-driver", "kosmickrisp", "26.2.0", "upstream")]])];
  const described = [];
  const describe = (root, selection) => { described.push(selection.version); return selection.version === "1.4.2" ? { vulkanFeatures: { geometryShader: measured["1.4.2"] } } : null; };
  const choices = Wine.managedTranslators({ userDataDir: "/state", settings: {} }, "crossover", managers, "x86_64", describe);
  return { choices, described, byId: id => choices.find(item => item.id === id) };
}

test("translator releases carry the Vulkan features their source declaration requires; drivers carry what was measured", t => {
  const { byId, described } = installedChoices(t);
  for (const id of ["dxvk-upstream", "maclauncher-dxvk"])
    assert.deepEqual(require("../src/runtime-sources").loadSources().find(item => item.id === id).vulkanFeatures, [{ from: "2", features: ["geometryShader"] }]);
  assert.deepEqual(byId("dxvk:3.1.1-MCLv1").vulkanRequires, ["geometryShader"], "MacLauncher DXVK 3.1.1");
  assert.deepEqual(byId("translator-dxvk:upstream-dxvk-3.1.1").vulkanRequires, ["geometryShader"], "DXVK 3.1.1");
  assert.equal(Object.hasOwn(byId("translator-dxvk:macos-dxvk-v1.10.3"), "vulkanRequires"), false, "DXVK-macOS 1.10.3 is not DXVK 2 or later");
  assert.equal(byId("vulkan-moltenvk:1.4.2").vulkanFeatures.geometryShader, false, "a driver recorded before the helper is measured through its description");
  assert.equal(byId("maclauncher-kosmickrisp:27.0.0").vulkanFeatures.geometryShader, true);
  assert.deepEqual(described.filter(version => version !== "3.4.3"), ["1.4.2"], "a driver whose record holds a measurement is not described again");
  assert.equal(Object.hasOwn(byId("vulkan-kosmickrisp:3.4.3"), "vulkanFeatures"), false, "a driver that could not be measured stays unmeasured");
});

test("settings leave out a pairing only when the driver measured the required feature absent", t => {
  const Wine = require("../src/modules/shared/runtime/wine-translators"), Plan = require("../src/core/runtime-resolution/translator-plan");
  const { choices } = installedChoices(t);
  const moltenvk = "vulkan-moltenvk:1.4.2", kosmic = "maclauncher-kosmickrisp:27.0.0", unmeasured = "vulkan-kosmickrisp:3.4.3";
  const dxvk3 = "dxvk:3.1.1-MCLv1", upstream3 = "translator-dxvk:upstream-dxvk-3.1.1", dxvkMac = "translator-dxvk:macos-dxvk-v1.10.3";
  const lists = ({ vulkan, d3d11, included = [] }) => {
    const input = { runtime: "crossover", choices: structuredClone(choices), included, environment: null, layout: { architecture: "x86_64" },
      selections: { ...(vulkan ? { "vulkan-driver": vulkan } : {}), ...(d3d11 ? { "d3d-renderer": d3d11 } : {}) } };
    const result = Wine.optionLists(null, "crossover", { runtimeSettings: { ...(vulkan ? { translatorVulkan: vulkan } : {}), ...(d3d11 ? { translatorD3D11: d3d11, translatorRenderer: d3d11 } : {}) } },
      { inventory: input, plan: Plan.resolvePlan(input) });
    return { d3d11: result.translatorD3D11Options.map(row => row.value), vulkan: result.translatorVulkanOptions.map(row => row.value) };
  };
  // DXVK 3.1.1 is left out with MoltenVK 1.4.2, whose measurement lacks geometryShader.
  let rows = lists({ vulkan: moltenvk });
  assert.ok(!rows.d3d11.includes(dxvk3) && !rows.d3d11.includes(upstream3), rows.d3d11.join(" | "));
  assert.ok(rows.d3d11.includes(dxvkMac), "DXVK-macOS 1.10.3 stays with MoltenVK");
  // It is shown with KosmicKrisp, which reports geometryShader, and with an unmeasured driver.
  for (const vulkan of [kosmic, unmeasured]) {
    rows = lists({ vulkan });
    assert.ok(rows.d3d11.includes(dxvk3) && rows.d3d11.includes(upstream3) && rows.d3d11.includes(dxvkMac), `${vulkan}: ${rows.d3d11.join(" | ")}`);
  }
  // The automatic choice pairs DXVK from Runtimes with MacLauncher KosmicKrisp, so the runtime's own MoltenVK hides nothing.
  const own = { ...structuredClone(choices.find(item => item.id === moltenvk)), id: "wine:moltenvk", included: true };
  rows = lists({ included: [own] });
  assert.ok(rows.d3d11.includes(dxvk3) && rows.d3d11.includes(dxvkMac), rows.d3d11.join(" | "));
  // A used DXVK 3.1.1 leaves MoltenVK 1.4.2 out of the Vulkan drivers; the measured and unmeasured others stay.
  rows = lists({ d3d11: dxvk3 });
  assert.ok(!rows.vulkan.includes(moltenvk) && rows.vulkan.includes(kosmic) && rows.vulkan.includes(unmeasured), rows.vulkan.join(" | "));
  rows = lists({ d3d11: dxvkMac });
  assert.ok(rows.vulkan.includes(moltenvk), "DXVK-macOS 1.10.3 keeps MoltenVK");
  // A saved pairing stays listed so it can be changed.
  rows = lists({ vulkan: moltenvk, d3d11: dxvk3 });
  assert.ok(rows.d3d11.includes(dxvk3) && rows.vulkan.includes(moltenvk), `${rows.d3d11.join(" | ")} / ${rows.vulkan.join(" | ")}`);
});
