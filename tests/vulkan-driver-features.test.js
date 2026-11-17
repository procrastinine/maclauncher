const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// Only the helper's process I/O is injected. Driver inspection, selection,
// content identity and persisted description caches remain production code.
function helperFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-features-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "maclauncher-vulkan-features"), queries = [], answers = new Map();
  fs.writeFileSync(file, "feature helper fixture A", { mode: 0o755 });
  const Reshade = require("../src/modules/shared/reshade"), Vulkan = require("../src/modules/shared/runtime/vulkan-features");
  let runtimeRoot = root;
  t.mock.method(Reshade, "runtimeRoot", () => runtimeRoot);
  const measure = Vulkan.measure;
  t.mock.method(Vulkan, "measure", (files, options) => measure(files, { ...options, run: (command, args) => {
    const library = args.at(-1); queries.push({ command, library });
    const features = answers.get(library) || (library.includes("MoltenVK") ? { geometryShader: false, tessellationShader: true }
      : library.includes("kosmickrisp") ? { geometryShader: true, tessellationShader: true } : null);
    return features ? { status: 0, stdout: JSON.stringify({ schema: 1, devices: [{ features }] }) } : { status: 3, stdout: "" };
  } }));
  const driver = (name, library, options) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, library), require("./fixtures/macho-image").image(options));
    return directory;
  };
  return { root, file, driver, measure, queries, answers, runs: () => queries.length, moveHelper: value => { runtimeRoot = value; } };
}
function withHelper(t, tool) {
  const VulkanFeatures = require("../src/modules/shared/runtime/vulkan-features"), original = VulkanFeatures.helper;
  VulkanFeatures.helper = () => tool;
  t.after(() => { VulkanFeatures.helper = original; });
}

test("offline descriptions never measure drivers; selected preparation retains only measured facts", async t => {
  const Description = require("../src/modules/shared/runtime/translator-description");
  const fixture = helperFixture(t);
  const moltenvk = fixture.driver("moltenvk", "libMoltenVK.dylib"), kosmic = fixture.driver("kosmickrisp", "libvulkan_kosmickrisp.dylib");
  fs.writeFileSync(path.join(moltenvk, "libSPIRV-Tools.dylib"), require("./fixtures/macho-image").image());
  fs.writeFileSync(path.join(moltenvk, "libzstd.dylib"), require("./fixtures/macho-image").image());
  const options = { engine: "moltenvk", version: "1.4.2", source: "fixture", component: "vulkan-driver", userDataDir: path.join(fixture.root, "profile") };
  const offline = Description.describeTranslator(moltenvk, options);
  assert.equal(Object.hasOwn(offline, "vulkanFeatures"), false);
  await Description.prepareTranslator(moltenvk, options);
  Description.describeTranslator(kosmic, { engine: "kosmickrisp", version: "27.0.0", source: "fixture" });
  assert.equal(fixture.runs(), 0, "custom inspection and local inventory do not load either driver");
  const selected = { ...offline, entryPoint: path.join(moltenvk, "libMoltenVK.dylib") };
  const prepared = await Description.prepareVulkanFeatures(selected, ["geometryShader"], options);
  assert.equal(prepared.vulkanFeatures.geometryShader, false);
  assert.equal((await Description.prepareVulkanFeatures(selected, ["geometryShader"], options)).vulkanFeatures.geometryShader, false);
  assert.equal(fixture.runs(), 1, "a described driver is not measured again");
  assert.equal(fixture.queries[0].library, selected.entryPoint, "dependencies are not probe candidates");
  assert.deepEqual(Description.installationDescription(Description.cachedTranslator(moltenvk, options)).vulkanFeatures,
    { geometryShader: false, tessellationShader: true });
  const filename = require.resolve('../src/modules/shared/runtime/translator-description');
  delete require.cache[filename];
  assert.deepEqual(require(filename).cachedTranslator(moltenvk, options).vulkanFeatures,
    { geometryShader: false, tessellationShader: true }, 'a cold offline reader restores the successful facts');
  assert.equal(fixture.runs(), 1);
  // Failure stays unknown and may be retried by a later actual Play.
  const other = fixture.driver("other", "libother.dylib");
  const unknown = Description.describeTranslator(other, { engine: "moltenvk", version: "9", source: "fixture" });
  assert.equal(Object.hasOwn(await Description.prepareVulkanFeatures(unknown, ["geometryShader"], options), "vulkanFeatures"), false);
  fixture.answers.set(path.join(other, "libother.dylib"), { geometryShader: true });
  assert.equal((await Description.prepareVulkanFeatures(unknown, ["geometryShader"], options)).vulkanFeatures.geometryShader, true);
  const before = fixture.runs(), moved = path.join(fixture.root, "new-envelope"); fs.mkdirSync(moved);
  fs.copyFileSync(fixture.file, path.join(moved, path.basename(fixture.file))); fixture.moveHelper(moved);
  assert.equal((await Description.prepareVulkanFeatures(prepared, ["geometryShader"], options)).vulkanFeatures.geometryShader, false);
  assert.equal(fixture.runs(), before, "identical helper contents in a new envelope reuse the measurement");
  fs.appendFileSync(path.join(moved, path.basename(fixture.file)), " changed");
  await Description.prepareVulkanFeatures(prepared, ["geometryShader"], options);
  assert.equal(fixture.runs(), before + 1, "changed actual helper contents invalidate the measurement");
  fixture.moveHelper(path.join(fixture.root, "absent"));
  const absent = await Description.prepareVulkanFeatures(unknown, ["unresolvedFeature"], options);
  assert.equal(absent.vulkanFeatures, undefined); assert.equal(fixture.runs(), before + 1);
  // The helper is a graphics payload target.
  assert.match(read("src/modules/shared/reshade/native/CMakeLists.txt"), /add_executable\(maclauncher-vulkan-features src\/vulkan-features\.c\)/);
  assert.match(read("src/modules/shared/reshade/native/vulkan-features.c"), /dlsym\(driver, "vk_icdGetInstanceProcAddr"\)/);
  assert.equal(require("../src/modules/shared/reshade/features.json").graphics.vulkanFeatureQueryAPI, 1);
});

test('the exact selected ICD resolves one driver and a denied query stays unknown', t => {
  const fixture = helperFixture(t), Description = require('../src/modules/shared/runtime/translator-description');
  const directory = fixture.driver('icds', 'libMoltenVK.dylib');
  fs.writeFileSync(path.join(directory, 'libSPIRV-Tools.dylib'), require('./fixtures/macho-image').image());
  const icd = path.join(directory, 'driver.json');
  fs.writeFileSync(icd, JSON.stringify({ ICD: { library_path: 'libMoltenVK.dylib' } }));
  const description = Description.describeTranslator(directory, { engine: 'moltenvk', version: '1.4.2' });
  const Vulkan = require('../src/modules/shared/runtime/vulkan-features');
  const features = Vulkan.measure(description.files, { entryPoint: icd });
  assert.equal(features.geometryShader, false);
  assert.deepEqual(fixture.queries.map(row => row.library), [path.join(directory, 'libMoltenVK.dylib')]);
  assert.equal(fixture.measure(description.files, { entryPoint: icd, run() { throw new Error('execution denied'); } }), undefined);
  assert.deepEqual(Vulkan.driverLibraries(description.files.filter(file => file.format !== 'json')), [], 'no arbitrary dependency is a fallback driver');
});

test("ordinary Wine inventory is offline and Play measures only the finally selected driver's required features", async t => {
  const Description = require("../src/modules/shared/runtime/translator-description"), Wine = require("../src/modules/shared/runtime/wine-translators");
  const fixture = helperFixture(t), { image, X64 } = require("./fixtures/macho-image"), { peFixture } = require("./helpers/pe-fixture");
  const put = (relative, bytes) => { const file = path.join(fixture.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const executablePath = put("wine/bin/wine", image({ cpu: X64, fileType: 2 }));
  put("wine/lib/wine/x86_64-unix/ntdll.so", image({ cpu: X64 }));
  fs.mkdirSync(path.join(fixture.root, "support/Frameworks/renderer"), { recursive: true });
  const install = { engineRoot: path.join(fixture.root, "wine"), crossoverRoot: path.join(fixture.root, "wine"),
    templateRoot: path.join(fixture.root, "support"), executablePath, architecture: "x64", version: "fixture-wine" };
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write("Wine builtin DLL\0", 64);
  for (const file of ["d3d11.dll", "dxgi.dll"]) put("dxvk/" + file, pe.bytes);
  const dxvk = { ...Description.describeTranslator(path.join(fixture.root, "dxvk"), { id: "fixture-dxvk", engine: "dxvk", version: "3.1.1", source: "fixture" }),
    vulkanRequires: ["geometryShader"] };
  const selectedRoot = fixture.driver("selected", "libMoltenVK.dylib", { cpu: X64 });
  const unselectedRoot = fixture.driver("unselected", "libvulkan_kosmickrisp.dylib", { cpu: X64 });
  const selected = { ...Description.describeTranslator(selectedRoot, { id: "selected", engine: "moltenvk", version: "1.4.2", source: "fixture" }),
    entryPoint: path.join(selectedRoot, "libMoltenVK.dylib") };
  const unselected = { ...Description.describeTranslator(unselectedRoot, { id: "unselected", engine: "kosmickrisp", version: "27.0", source: "fixture" }),
    entryPoint: path.join(unselectedRoot, "libvulkan_kosmickrisp.dylib") };
  const choices = [dxvk, selected, unselected], context = { runtimeId: "sikarugir", userDataDir: path.join(fixture.root, "profile"), settings: {},
    runtimeSettings: { translatorRenderer: dxvk.id, translatorD3D11: dxvk.id, translatorVulkan: selected.id }, logger: { warn() {} } };
  const options = { managers: [], choices, executableArchitecture: "x86_64", host: { macOSVersion: "26.0", physicalAppleGPU: false } };
  const inventory = await Wine.optionsInventory(install, "sikarugir", context, options);
  assert.ok(inventory.choices.some(item => item.id === selected.id)); assert.ok(inventory.choices.some(item => item.id === unselected.id));
  assert.equal(fixture.runs(), 0);
  const plan = await Wine.resolve(install, "sikarugir", context, options);
  assert.equal(plan.components["vulkan-driver"].used.id, selected.id);
  assert.equal(plan.components["vulkan-driver"].used.vulkanFeatures.geometryShader, false);
  assert.deepEqual(fixture.queries.map(row => row.library), [selected.entryPoint]);
  await Wine.resolve(install, "sikarugir", context, options);
  assert.equal(fixture.runs(), 1, "a second selected resolve reuses successful cached facts");
  const next = await Wine.optionsInventory(install, "sikarugir", context, options);
  assert.equal(next.choices.find(item => item.id === selected.id).vulkanFeatures.geometryShader, false);
  assert.equal(next.choices.find(item => item.id === unselected.id).vulkanFeatures, undefined);
  assert.equal(fixture.runs(), 1);
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
    manager("vulkan-moltenvk", "moltenvk", ["khronos-moltenvk"], [["1.4.2", record("vulkan-driver", "moltenvk", "1.4.2", "upstream",
      measured["1.4.2"] === undefined ? {} : { vulkanFeatures: { geometryShader: measured["1.4.2"] } })]]),
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
  assert.equal(byId("vulkan-moltenvk:1.4.2").vulkanFeatures.geometryShader, false, "a previously measured fact is retained without probing");
  assert.equal(byId("maclauncher-kosmickrisp:27.0.0").vulkanFeatures.geometryShader, true);
  assert.deepEqual(described, [], "installed inventories never backfill native measurements");
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
