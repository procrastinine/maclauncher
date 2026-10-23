const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Graphics = require("../src/modules/android/graphics-selection");
const molten = { id: "moltenvk:1.4.2", backend: "moltenvk" };
const kosmic = { id: "kosmickrisp:included", backend: "kosmickrisp" };
const payload = { profile: { angleVulkanVersion: 1 } };
const required = { requiredGlEsVersion: 0x30001,
  applicationMetadata: { "com.epicgames.ue4.GameActivity.bSupportsVulkan": { value: false } } };
const select = (context = {}, metadata = required, selection = { renderer: "metal", vulkan: molten }, dependencies = {}, entry = {}) =>
  Graphics.resolveGraphics(entry, context, payload, metadata, selection, dependencies);

test("Android implicit Metal selection follows required GLES without changing native Vulkan metadata", async () => {
  assert.deepEqual(await select(), { renderer: "vulkan", vulkan: molten });
  assert.deepEqual(await select({}, {}), { renderer: "metal", vulkan: molten });
  assert.deepEqual(await select({}, { requiredGlEsVersion: 0x30000 }), { renderer: "metal", vulkan: molten });
  assert.equal(required.applicationMetadata["com.epicgames.ue4.GameActivity.bSupportsVulkan"].value, false);
  assert.deepEqual(await select({}, required, { renderer: "vulkan", vulkan: kosmic }), { renderer: "vulkan", vulkan: kosmic });
  assert.deepEqual(await Graphics.resolveGraphics({}, {}, { profile: {} }, required,
    { renderer: "metal", vulkan: molten }), { renderer: "metal", vulkan: molten });
});

test("Android explicit Metal selections survive game, module, shared defaults and normalized callers", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-gles-choice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = { renderer: "metal", vulkan: molten };
  const entry = { runtimeSettings: { klepton: { angleBackend: "metal" } } };
  assert.deepEqual(await select({}, required, undefined, {}, entry), expected);
  assert.deepEqual(await select({ settings: { modules: { android: { runtimeSettings: { klepton: { angleBackend: "metal" } } } } } }), expected);
  const settings = path.join(root, "runtimes", "klepton"); fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, "settings.json"), JSON.stringify({ angleBackend: "metal" }));
  assert.deepEqual(await select({ userDataDir: root }), expected);
  assert.deepEqual(await select({ runtimeSettingsOverrides: { angleBackend: "metal" } }), expected);
  assert.deepEqual(await select({ runtimeSettings: { angleBackend: "metal" }, runtimeSettingsOverrides: {} }, required, undefined, {}, entry),
    { renderer: "vulkan", vulkan: molten }, "Normalized defaults do not become explicit game overrides");
});

test("Android native GLES fallback resolves MoltenVK without reusing incompatible shared-image providers", async () => {
  let selected;
  const context = { runtimeSettings: { execution: "art", vulkanRuntime: "auto" } };
  const result = await select(context, required, { renderer: "metal", vulkan: kosmic }, {
    installedVulkan: () => [kosmic, molten], resolveVulkan: request => { selected = request; return molten; }
  });
  assert.deepEqual(result, { renderer: "vulkan", vulkan: molten });
  assert.equal(selected.runtimeSettings.vulkanRuntime, molten.id);
  assert.equal(context.runtimeSettings.vulkanRuntime, "auto", "Launch selection does not overwrite preferences");
  await assert.rejects(select({ runtimeSettings: { execution: "art", vulkanRuntime: kosmic.id } }, required,
    { renderer: "metal", vulkan: kosmic }), /requires MoltenVK/);
});

test("Android required GLES downloads only its existing compatible supplier after consent", async () => {
  const calls = [];
  const manager = { id: "vulkan-moltenvk", backend: "moltenvk", resolveSelection: () => ({ version: "1.4.2" }),
    installRuntime: async request => calls.push(["install", request.version]) };
  const dependencies = { installedVulkan: () => [], moltenVkManager: manager,
    confirmGraphicsInstall: async (_context, request) => calls.push(["consent", request.manager.id, request.version]),
    resolveVulkan: context => { calls.push(["resolve", context.runtimeSettings.vulkanRuntime]); return molten; } };
  const context = { runtimeSettings: { execution: "art" }, onRuntimeStateChange: () => calls.push(["changed"]) };
  assert.deepEqual(await select(context, required, { renderer: "metal", vulkan: null }, dependencies),
    { renderer: "vulkan", vulkan: molten });
  assert.deepEqual(calls, [["consent", "vulkan-moltenvk", "1.4.2"], ["install", "1.4.2"], ["changed"], ["resolve", molten.id]]);
  calls.length = 0;
  await assert.rejects(select(context, required, { renderer: "metal", vulkan: null }, { ...dependencies,
    confirmGraphicsInstall: async () => { throw Error("declined"); } }), /declined/);
  assert.deepEqual(calls, [], "Declining a required download does not install or launch a provider");
  await select({}, { requiredGlEsVersion: 0x30000 }, { renderer: "metal", vulkan: null }, dependencies);
  assert.deepEqual(calls, [], "Ordinary Metal applications do not acquire Vulkan");
});
