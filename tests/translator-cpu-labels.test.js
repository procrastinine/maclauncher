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

test("one CPU vocabulary: Mac code by Mac name, Intel on Apple Silicon with Rosetta, Windows code by Windows name", async () => {
  const { cpuLabel, cpuId } = await import("../src/core/cpu-labels.mjs");
  assert.equal(cpuLabel("arm64"), "Apple Silicon"); assert.equal(cpuLabel("x86_64"), "Intel"); assert.equal(cpuLabel("universal"), "Universal");
  assert.equal(cpuLabel("x64", { hostArchitecture: "arm64" }), "Intel (Rosetta)");
  assert.equal(cpuLabel("x64", { hostArchitecture: "x64" }), "Intel");
  assert.equal(cpuLabel("arm64", { hostArchitecture: "arm64" }), "Apple Silicon");
  assert.equal(cpuLabel("x86_64", { windows: true }), "x64"); assert.equal(cpuLabel("i386", { windows: true }), "x86");
  assert.equal(cpuLabel("aarch64", { windows: true }), "ARM64");
  assert.equal(cpuLabel(null), ""); assert.equal(cpuId("amd64"), "x64");
  assert.equal(Architecture.cpuBuildLabel("x86_64", { host: apple }), "Intel (Rosetta)");
  assert.equal(Architecture.cpuBuildLabel("x64", { host: intel }), "Intel");
  assert.equal(Architecture.cpuBuildLabel("arm64", { host: apple }), "Apple Silicon");
  assert.equal(Architecture.architectureLabel("x64"), "Intel"); assert.equal(Architecture.architectureLabel("arm64"), "Apple Silicon");
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
  ["CrossOver Intel Wine on Apple Silicon", "crossover", "x86_64", apple, "Intel (Rosetta)"],
  ["CrossOver Intel Wine on an Intel Mac", "crossover", "x86_64", intel, "Intel"],
  ["CrossOver ARM64 Wine (FEX)", "crossover", "arm64", apple, "Apple Silicon"],
  ["Sikarugir", "sikarugir", "x86_64", apple, "Intel (Rosetta)"]]) {
  test(`${consumer}: the inspector names the Vulkan driver build Wine loads; settings entries share it and do not repeat it`, () => {
    const { input, plan } = winePlan(runtime, architecture);
    const rows = Object.fromEntries(Wine.inspectorRows(plan, { host }).map(row => [row.component, row]));
    assert.equal(rows["vulkan-driver"].used, `KosmicKrisp 27.0.0 · MacLauncher Builds · ${expected}`);
    assert.doesNotMatch(rows["d3d-renderer"].used, /Intel|Apple Silicon/, "Windows libraries carry no Mac CPU label");
    const options = Wine.optionLists(null, runtime, { runtimeSettings: {} }, { inventory: structuredClone(input), plan, host });
    const labels = [...options.translatorVulkanOptions, ...options.translatorRendererOptions].map(row => row.label);
    assert.ok(labels.some(label => label.startsWith("KosmicKrisp")));
    assert.ok(labels.every(label => !/Intel|Apple Silicon/.test(label)), labels.join(" | "));
  });
}

// Non-Wine consumers state their CPU when they list Vulkan drivers; the choices
// are the slices installed() checked for that CPU, the one resolve() loads.
// Every entry shares that CPU, so the entries do not repeat it.
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
for (const [consumer, list, cpu] of [
  ["AnyPS5", context => require("../src/modules/anyps5/main").settingsActions.listVulkanRuntimes({}, context), "x64"],
  ["Prosper", context => require("../src/modules/prosper/provider").createProvider({ vulkan: Vulkan }).settingsActions.listVulkanRuntimes({}, context), "x64"],
  ["Android", context => require("../src/modules/android/custom-main").settingsActions.listVulkanRuntimes({}, context), "arm64"]]) {
  test(`${consumer}: Vulkan choices list the build its host process loads without repeating its CPU`, t => {
    const { context, requested } = vulkanFixture(t);
    const rows = list(context).vulkanRuntimes;
    assert.deepEqual(rows[0], { value: "auto", label: "Automatic" });
    assert.deepEqual(rows.slice(1).map(row => row.label), ["MacLauncher KosmicKrisp 27"]);
    assert.deepEqual([...new Set(requested)], [cpu]);
  });
}
test("an Intel Mac lists an x64 host's MoltenVK build", t => {
  const { context, requested } = vulkanFixture(t, intel, "moltenvk");
  const rows = require("../src/modules/anyps5/main").settingsActions.listVulkanRuntimes({}, context).vulkanRuntimes;
  assert.deepEqual(rows.slice(1).map(row => row.label), ["MoltenVK 27"]);
  assert.deepEqual([...new Set(requested)], ["x64"]);
});
