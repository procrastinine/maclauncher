const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Architecture = require("../src/modules/shared/runtime/architecture");
const Wine = require("../src/modules/shared/runtime/wine-translators");
const Plan = require("../src/modules/shared/runtime/translator-plan");
const Vulkan = require("../src/modules/shared/vulkan");

const apple = { platform: "darwin", hardwareArch: "arm64", macOSVersion: "26.0" };
const intel = { platform: "darwin", hardwareArch: "x64", macOSVersion: "15.0" };

test("CPU build labels name the build and how its consumer runs it", () => {
  assert.equal(Architecture.cpuBuildLabel("x86_64", { consumer: "wine", host: apple }), "x64 (Wine under Rosetta)");
  assert.equal(Architecture.cpuBuildLabel("x64", { consumer: "wine", host: intel }), "x64");
  assert.equal(Architecture.cpuBuildLabel("arm64", { consumer: "wine", host: apple }), "arm64 (ARM64 Wine)");
  assert.equal(Architecture.cpuBuildLabel("x64", { host: apple }), "x64 (under Rosetta)");
  assert.equal(Architecture.cpuBuildLabel("x64", { host: intel }), "x64");
  assert.equal(Architecture.cpuBuildLabel("aarch64", { host: apple }), "arm64");
  assert.equal(Architecture.cpuBuildLabel("universal", { host: apple }), "universal");
  assert.equal(Architecture.cpuBuildLabel(null, { host: apple }), "");
});

// Wine consumers: the plan's layout is the Wine process CPU that Play prepares
// translator files for (translatorPlan.layout), so the inspector names that build.
const files = format => [{ path: "/fixture/lib", format, cpuSlices: format === "macho" ? ["x86_64", "arm64"] : undefined }];
const kosmic = { id: "maclauncher-kosmickrisp:27", component: "vulkan-driver", engine: "kosmickrisp", version: "27.0.0", source: { kind: "upstream", label: "MacLauncher Builds" }, files: files("macho") };
const dxvk = { id: "translator-dxvk:2.7", component: "d3d-renderer", engine: "dxvk", version: "2.7", source: { kind: "upstream", label: "DXVK" }, files: files("pe") };
function winePlan(runtime, architecture) {
  const input = { runtime, choices: [kosmic, dxvk], included: [], environment: null,
    selections: { "vulkan-driver": kosmic.id, "d3d-renderer": dxvk.id }, layout: { architecture } };
  return { input, plan: { ...Plan.resolvePlan(input), layout: input.layout } };
}
for (const [consumer, runtime, architecture, host, expected] of [
  ["CrossOver Intel Wine on Apple Silicon", "crossover", "x86_64", apple, "x64 (Wine under Rosetta)"],
  ["CrossOver Intel Wine on an Intel Mac", "crossover", "x86_64", intel, "x64"],
  ["CrossOver ARM64 Wine (FEX)", "crossover", "arm64", apple, "arm64 (ARM64 Wine)"],
  ["Sikarugir", "sikarugir", "x86_64", apple, "x64 (Wine under Rosetta)"]]) {
  test(`${consumer}: the inspector and settings name the Vulkan driver build Wine loads`, () => {
    const { input, plan } = winePlan(runtime, architecture);
    const rows = Object.fromEntries(Wine.inspectorRows(plan, { host }).map(row => [row.component, row]));
    assert.equal(rows["vulkan-driver"].used, `KosmicKrisp 27.0.0 · MacLauncher Builds · ${expected}`);
    assert.doesNotMatch(rows["d3d-renderer"].used, /x64|arm64/, "Windows libraries carry no Mac CPU label");
    const options = Wine.optionLists(null, runtime, { runtimeSettings: {} }, { inventory: structuredClone(input), plan, host });
    const vulkan = options.translatorVulkanOptions.find(row => row.label.startsWith("KosmicKrisp"));
    assert.ok(vulkan.label.endsWith(` · ${expected}`), vulkan.label);
    assert.ok(options.translatorRendererOptions.every(row => !/ · (?:x64|arm64)/.test(row.label)));
  });
}
test("Play's translator plan carries the layout the inspector labels; options plans keep it too", () => {
  const { input } = winePlan("crossover", "arm64");
  assert.deepEqual(Wine.optionsPlan(input, { runtimeSettings: {} }).layout, { architecture: "arm64" });
});

// Non-Wine consumers state their CPU when they list Vulkan drivers; the choice
// names the slice installed() checked for that CPU, the one resolve() loads.
function machO(file, architecture) {
  const data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(6, 12);
  fs.writeFileSync(file, data); return file;
}
function vulkanFixture(t, host = apple, backend = "kosmickrisp") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-cpu-label-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = { arm64: machO(path.join(root, "arm64.dylib"), "arm64"), x64: machO(path.join(root, "x64.dylib"), "x86_64") };
  const requested = [];
  const adapted = { installed: context => {
    const cpu = Object.values(context.settings?.runtimes || {}).find(value => value?.defaultArchitecture)?.defaultArchitecture || "arm64";
    requested.push(cpu);
    return [{ id: `${backend}-fixture:27`, backend, projectId: "maclauncher-kosmickrisp", version: "27", label: backend === "kosmickrisp" ? "MacLauncher KosmicKrisp 27" : "MoltenVK 27",
      library: library[cpu], driver: library[cpu], readable: [library[cpu]] }];
  } };
  const original = Vulkan.choices;
  t.mock.method(Vulkan, "choices", (context, options) => original(context, { ...options, managers: [], adapted, hostCapabilities: host }));
  return { context: { userDataDir: root, settings: {}, runtimeSettings: {} }, requested };
}
for (const [consumer, list, expected] of [
  ["AnyPS5", context => require("../src/modules/anyps5/main").settingsActions.listVulkanRuntimes({}, context), "x64 (under Rosetta)"],
  ["Prosper", context => require("../src/modules/prosper/provider").createProvider({ vulkan: Vulkan }).settingsActions.listVulkanRuntimes({}, context), "x64 (under Rosetta)"],
  ["Android", context => require("../src/modules/android/custom-main").settingsActions.listVulkanRuntimes({}, context), "arm64"]]) {
  test(`${consumer}: Vulkan choices name the build its host process loads`, t => {
    const { context, requested } = vulkanFixture(t);
    const rows = list(context).vulkanRuntimes;
    assert.deepEqual(rows[0], { value: "auto", label: "Automatic" });
    assert.deepEqual(rows.slice(1).map(row => row.label), [`MacLauncher KosmicKrisp 27 · ${expected}`]);
    assert.deepEqual([...new Set(requested)], [expected.split(" ")[0]]);
  });
}
test("an Intel Mac names an x64 host's build without Rosetta", t => {
  const { context } = vulkanFixture(t, intel, "moltenvk");
  const rows = require("../src/modules/anyps5/main").settingsActions.listVulkanRuntimes({}, context).vulkanRuntimes;
  assert.deepEqual(rows.slice(1).map(row => row.label), ["MoltenVK 27 · x64"]);
});
