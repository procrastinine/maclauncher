const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Registry = require("../src/modules/registry");
const Preparation = require("../src/core/runtime-preparation");
const Vulkan = require("../src/modules/shared/vulkan");
function profile(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "helper-delivery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));return directory;
}

test("every registered managed runtime supports a fresh-profile Play plan before any network request", async t => {
  const userDataDir = profile(t), managers = Preparation.listRuntimeManagers(Registry);
  const external = new Set(["crossover", "graphics-models"]);
  const before = Harness.network.requests.length;
  for (const manager of managers.filter(manager => !external.has(manager.id))) await t.test(manager.id, async () => {
    const state = manager.getState({ userDataDir, settings: {}, runtimeSettings: {} }), section = state.sections?.[0]?.id || "default";
    if (typeof manager.installRuntime !== "function") {
      // Neural models use the graphics preparation/setup contract rather than
      // the runtime installer; verify its real acquisition plan as well.
      assert.equal(manager.id, "graphics-neural-models");
      assert.ok(state.setupActions.length && typeof manager.performSetupAction === "function");
      const prompts = [];
      assert.equal(await require("../src/modules/shared/reshade/neural/setup").downloadModel({userDataDir,
        confirmRuntimeInstall: async plan => {prompts.push(plan);return false;}}), null);
      assert.equal(prompts.length, 1);assert.equal(prompts[0].managerId, manager.id);assert.ok(prompts[0].version);
      return;
    }
    const runtimeId = Registry.listModules().flatMap(mod => Object.entries(mod.runtime?.manager || {}))
      .find(([, id]) => id === manager.id)?.[0] || manager.id;
    const info = { runtime: { manager: { [runtimeId]: manager.id }, managerSectionBy: { [runtimeId]: "runtimeId" },
      managerSectionMap: { [runtimeId]: { [runtimeId]: section } } } };
    const prompts = [], mod = { id: "delivery", runtimeManagers: [manager] };
    const entry = { runtimeId, ...(manager.id === "unity" ? {moduleData:{detectedVersion:"2022.3.62f1"}} : {}) };
    const result = await Preparation.prepareForLaunch({ entry, mod, info,
      context: { runtimeId, userDataDir, settings: { runtimes: {} }, confirmRuntimeInstall: async plan => {prompts.push(plan);return false;} },
      registry: { listModuleIds: () => [mod.id], getModule: () => mod },
      install: () => assert.fail("No install before consent") });
    if (result) {
      assert.ok((state.sections || [state]).some(section => section.installed?.some(row => row.included || row.bundled)), "Only an included runtime can already be ready");
    } else {
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].managerId, manager.id);
      assert.ok(prompts[0].version || prompts[0].discoveryRequired);
    }
  });
  assert.equal(Harness.network.requests.length, before, "Planning never discovers catalogs");
});

test("optional plans may be declined once across discovery replans while required preparation completes", async () => {
  const events = [], managers = ["host", "optional"].map(id => ({ id, label: id, getState: () => ({ catalog: {} }),
    installRuntime() {}, refreshCatalog: async () => events.push("refresh:" + id) }));
  const optional = { managerId: "optional", version: null, discoveryRequired: true, optional: true, installOptions: { sectionId: "plugin" } };
  const mod = { id: "fixture", runtimeManagers: managers,
    ensureRuntime: () => events.includes("refresh:host") ? { managerId: "host", version: "1", installOptions: {} }
      : { managerId: "host", version: null, discoveryRequired: true, installOptions: {} },
    getRuntimeRequirements: () => [optional], prepareLaunch: () => events.push("prepare") };
  assert.equal(await Preparation.prepareForLaunch({ entry: {}, mod, info: {},
    context: { userDataDir: "/unused", settings: {}, confirmRuntimeInstall: async plan => { events.push("consent:" + plan.managerId);return !plan.optional; } },
    registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    install: async manager => events.push("install:" + manager.id) }), true);
  assert.deepEqual(events, ["consent:host", "consent:optional", "refresh:host", "install:host", "prepare"]);
});

test("fresh video Play offers both default-on plugins and preserves disabled plugin settings", async t => {
  const mod = Registry.getModule("video"), context = { runtimeId: "mpv", userDataDir: profile(t), settings: {}, runtimeSettings: {} };
  const plans = await mod.getRuntimeRequirements({}, context);
  assert.deepEqual(plans.map(plan => plan.installOptions.sectionId).sort(), ["thumbfast", "uosc"]);
  assert.ok(plans.every(plan => plan.optional && plan.discoveryRequired && plan.requiresDownload));
  assert.deepEqual(await mod.getRuntimeRequirements({}, { ...context, runtimeSettings: { uosc: false, timelinePreviews: false } }), []);
});

test("Sikarugir provider returns its fresh-profile discovery plan without refreshing", async t => {
  const userDataDir = profile(t), provider = require("./helpers/wine-source.cjs").provider("sikarugir");
  const entry = { gamePath: userDataDir, runtimeData: { crossover: {
    windowsExecutablePath: path.join(userDataDir, "game.exe"), sourceRoot: userDataDir, executableArchitecture: "x86_64" } } };
  const before = Harness.network.requests.length;
  const plan = await provider.ensureRuntime(entry, {userDataDir, settings:{}, runtimeId:"sikarugir"});
  assert.equal(plan.managerId, "sikarugir");assert.equal(plan.discoveryRequired, true);assert.equal(plan.version, null);
  assert.equal(Harness.network.requests.length, before);
});

test("a game's FidelityFX library offers the FidelityFX API adapter on a carrier driver", t => {
  const root = profile(t), Profile = require("../src/modules/crossover/temporal/catalog").FIDELITYFX_PROFILE;
  const PE = require("../src/modules/crossover/temporal/streamline/pe-exports"), Temporal = require("../src/modules/crossover/temporal");
  fs.writeFileSync(path.join(root, Profile.libraries.vk), "FidelityFX API fixture");
  t.mock.method(PE, "inspect", () => Profile.exports.map((name, index) => ({ name, ordinal: index + 1 })));
  const entry = {gamePath:root, runtimeData:{crossover:{sourceRoot:root, windowsExecutablePath:path.join(root,"game.exe"),executableArchitecture:"x86_64"}},
    effects:{schema:2,mode:"advanced",enabled:true,video:[{id:"scene",kind:"temporal",method:"metalfx",enabled:true,settings:{}}]}};
  const support = {apiManagers:{"fidelityfx-api":{resolvePayload:() => ({ready:false, version:null, discoveryRequired:true})}}};
  const translatorPlan = {components:{"vulkan-driver":{used:{engine:"kosmickrisp", files:[{format:"macho", path:path.join(root,"driver.dylib")}]}}}};
  const plan = Temporal.resolveScenePlan(entry, {}, {support, translatorPlan, hasCarrier: () => true});
  assert.equal(plan.driver, "kosmickrisp");
  assert.deepEqual(plan.libraries.map(row => [row.backend, row.relativePath]), [["vk", Profile.libraries.vk]]);
  assert.deepEqual(plan.requirements.map(row => [row.managerId, row.version, row.discoveryRequired]), [["fidelityfx-api", null, true]]);
  const context = {};
  assert.equal(Temporal.resolveScenePlan(entry, context, {support, translatorPlan, hasCarrier: () => false}), null);
  assert.match(context.graphicsBridgeFailure.reason, /forwards temporal frames/);
  t.mock.method(PE, "inspect", () => Profile.exports.slice(1).map((name, index) => ({ name, ordinal: index + 1 })));
  assert.equal(Temporal.resolveScenePlan(entry, {}, {support, translatorPlan, hasCarrier: () => true}), null);
});

test("preferred Vulkan and explicit MacLauncher KosmicKrisp are downloadable from an empty profile", t => {
  const context = { userDataDir: profile(t), settings: {}, runtimeSettings: {} }, dependencies = { required: true, preferredBackend: "kosmickrisp" };
  assert.equal(Vulkan.requirements(context, dependencies)[0].managerId, "vulkan-kosmickrisp");
  // Settings list installed drivers only; Play downloads what a choice needs.
  assert.deepEqual(Vulkan.choices(context).vulkanRuntimes.map(row => row.value), ["auto"]);
  for (const choice of ["kosmickrisp:auto", "kosmickrisp:maclauncher"]) {
    context.runtimeSettings.vulkanRuntime = choice;
    assert.ok(Vulkan.choices(context).vulkanRuntimes.some(row => row.value === choice && /not installed/.test(row.label)), choice);
    assert.equal(Vulkan.requirements(context)[0].discoveryRequired, true, choice);
  }
  context.runtimeSettings = { angleBackend: "vulkan" };
  assert.equal(Registry.getModule("android").getRuntimeRequirements({}, { ...context, runtimeId: "klepton" })[0].managerId, "vulkan-moltenvk");
});

test("missing managed shaders acquire one collection during preparation and do not acquire while browsing", async () => {
  const events = [], shaders = { ID: "graphics-shader-library", isId: id => id.startsWith("shader:managed-"),
    missingEffectPlan: () => ({ installOptions: { sectionId: "quint" }, version: null }),
    installRuntime: async options => {events.push(options.sectionId);return {version:"1"};} };
  const plan = {video: ["a", "b"].map(id => ({id, kind:"shader", enabled:true, shader:{preset:"shader:managed-quint:" + id.repeat(16)}}))};
  const prepare = require("../src/modules/shared/reshade/shader-preparation").prepare;
  await prepare(plan, {}, {shaders});assert.deepEqual(events, []);
  await prepare(plan, {launchPreparation:true, confirmRuntimeInstall:async()=>true, onRuntimeStateChange:()=>events.push("changed")}, {shaders});
  assert.deepEqual(events, ["quint", "changed"]);
});
