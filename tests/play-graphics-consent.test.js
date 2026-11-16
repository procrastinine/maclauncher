const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Effects = require("../src/modules/shared/effects/runtime");

const MODEL = { managerId: "graphics-neural-models", version: "m1", label: "Neural rendering model", bytes: 2 << 20,
  installOptions: { sectionId: "default", setupActionId: "downloadModel:m1" } };
const SHADERS = { managerId: "graphics-shader-library", version: "s1", label: "Shader collection", bytes: 1 << 20, installOptions: { sectionId: "pack" } };

function fixture(t, { primary = { managerId: "host", version: "1.0" }, graphics = [MODEL, SHADERS], consent = true } = {}) {
  const events = [], setup = [];
  const launchDownloads = Effects.launchDownloads;
  Effects.launchDownloads = async () => graphics.map(plan => structuredClone(plan));
  t.after(() => { Effects.launchDownloads = launchDownloads; });
  const state = () => ({ catalog: {}, installed: [] });
  const managers = [
    { id: "host", label: "Host", installRuntime: async () => {}, getState: state },
    { id: "graphics-neural-models", label: "Neural models", getState: state, performSetupAction: async context => setup.push(context.setupActionId) },
    { id: "graphics-shader-library", label: "Shader collections", installRuntime: async () => {}, getState: state }];
  const mod = { id: "fixture", runtimeManagers: managers, ensureRuntime: async () => primary };
  const context = { runtimeId: "native", userDataDir: "/test-launcher-data", settings: { runtimes: {} },
    confirmRuntimeInstall: async plan => { events.push(["consent", plan.label, ...(plan.companions || []).map(item => item.label)].join(":")); return consent; } };
  const prepare = () => prepareForLaunch({ entry: { effects: { schema: 1 } }, mod, context,
    info: { runtime: { entries: { native: { graphicsHost: "window" } } } },
    registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    runAction: () => assert.fail("No preparation action was declared"),
    install: async (manager, payload) => {
      events.push("start:" + manager.id);
      await new Promise(resolve => setTimeout(resolve, 20));
      await manager.installRuntime(payload);
      events.push("end:" + manager.id);
    } });
  return { events, setup, context, prepare };
}

test("graphics data the saved rows need is a line of the one Play dialog and downloads together with the runtime", async t => {
  const f = fixture(t);
  assert.equal(await f.prepare(), true);
  assert.deepEqual(f.events.filter(event => event.startsWith("consent")), ["consent:Host:Neural rendering model:Shader collection"], "one dialog lists the runtime and the graphics data");
  const starts = f.events.filter(event => event.startsWith("start:")), firstEnd = f.events.findIndex(event => event.startsWith("end:"));
  assert.deepEqual(starts, ["start:host", "start:graphics-neural-models", "start:graphics-shader-library"]);
  assert.ok(f.events.lastIndexOf(starts.at(-1)) < firstEnd, "every approved download starts before any finishes: " + f.events.join(", "));
  assert.deepEqual(f.setup, ["downloadModel:m1"], "a model downloads through its manager's setup action");
});

test("graphics downloads without a runtime download share one dialog, and declining it continues Play without asking again", async t => {
  const f = fixture(t, { primary: null, consent: false });
  assert.equal(await f.prepare(), true, "graphics data is optional for Play");
  assert.deepEqual(f.events, ["consent:Neural rendering model:Shader collection"]);
  assert.deepEqual([...f.context.declinedChoices].sort(), ["download:graphics-neural-models", "download:graphics-shader-library"],
    "the declined downloads are recorded for the graphics step of this Play");
});

test("a shader collection needed by several rows of one pack is offered once", () => {
  const Preparation = require("../src/modules/shared/reshade/shader-preparation");
  const asked = [];
  const shaders = { isId: id => id.startsWith("pack/"), missingEffectPlan: (_dir, id) => (asked.push(id), { managerId: "graphics-shader-library", version: "s1", label: "Pack", installOptions: { sectionId: "pack" } }) };
  const plan = { video: [{ enabled: true, kind: "shader", shader: { preset: "chain", effects: ["pack/a", "pack/b", "builtin"] } }, { enabled: false, kind: "shader", shader: { preset: "pack/c" } }] };
  assert.deepEqual(Preparation.downloads(plan, { userDataDir: "/test-launcher-data" }, { shaders }).map(item => item.installOptions.sectionId), ["pack"]);
  assert.deepEqual(asked, ["pack/a", "pack/b"], "a disabled row and a built-in effect download nothing");
});

test("a launch lists the FSR 4 model data of the row's profile and the XeSS runtime its rows need", async t => {
  const Plan = require("../src/modules/shared/effects/plan"), rows = Plan.catalog({}), template = id => structuredClone(rows.find(row => row.id === id).template);
  const fsr4 = { ...template("temporal:fsr4"), id: "upscale" }; fsr4.settings = { ...fsr4.settings, fsr4Profile: "int8-lite-lossy" };
  const xess = { ...template("temporal:xess"), id: "xess", enabled: true };
  const asked = [];
  const FSR4 = require("../src/modules/shared/reshade/runtime/fsr4-models-manager"), XeSS = require("../src/modules/shared/reshade/runtime/xess-manager");
  t.mock.method(FSR4, "launchPlan", (_options, profile) => (asked.push("fsr4:" + profile), { managerId: FSR4.id, version: "f1", installOptions: { sectionId: "default", fsr4Profile: profile } }));
  t.mock.method(XeSS, "launchPlan", () => (asked.push("xess"), null));
  const plans = await Effects.launchDownloads({ effects: { schema: 2, mode: "advanced", enabled: true, video: [fsr4, xess] } }, { userDataDir: "/test-launcher-data" });
  assert.deepEqual(asked, ["fsr4:int8-lite-lossy", "xess"]);
  assert.deepEqual(plans.map(plan => plan.managerId), [FSR4.id], "an installed XeSS runtime downloads nothing");
  assert.deepEqual(await Effects.launchDownloads({ effects: { schema: 2, mode: "advanced", enabled: false, video: [fsr4, xess] } }, { userDataDir: "/test-launcher-data" }), [],
    "a disabled graphics plan downloads nothing");
});

test("clearing a companion's checkbox installs the download the dialog names in its place without another question", async t => {
  const fallback = { managerId: "scene", version: "2.0", label: "Scene driver" };
  const companion = { managerId: "driver", version: "1.0", label: "Driver", optional: true, companion: true, companionCheckbox: "Use the driver", fallback };
  const f = fixture(t, { graphics: [] });
  const state = () => ({ catalog: {}, installed: [] });
  const mod = { id: "fixture", runtimeManagers: ["host", "driver", "scene"].map(id => ({ id, label: id, installRuntime: async () => {}, getState: state })),
    ensureRuntime: async () => ({ managerId: "host", version: "1.0", label: "Host" }), getRuntimeRequirements: async () => [companion] };
  const shown = [], installed = [];
  f.context.confirmRuntimeInstall = async plan => { shown.push(plan); return { approved: true, companionsDeclined: true }; };
  assert.equal(await prepareForLaunch({ entry: {}, mod, context: f.context, info: { runtime: {} },
    registry: { listModuleIds: () => [mod.id], getModule: () => mod }, runAction: () => assert.fail("No preparation action was declared"),
    install: async (manager, payload) => installed.push(`${manager.id}:${payload.version}`) }), true);
  assert.equal(shown.length, 1, "one question: " + shown.map(plan => plan.label).join(", "));
  assert.deepEqual(shown[0].companions, [{ label: "Driver", versionLabel: "1.0", checkboxLabel: "Use the driver", fallbackLabel: "Scene driver 2.0" }]);
  assert.deepEqual(installed.sort(), ["host:1.0", "scene:2.0"]);
});

test("skipping an optional download that is the only one of a Play installs the download the dialog names for skipping, without another question", async t => {
  const fallback = { managerId: "scene", version: "2.0", label: "Scene driver" };
  const offer = { managerId: "driver", version: "1.0", label: "Driver", optional: true, companion: true, companionCheckbox: "Use the driver", cancelLabel: "Use the scene driver", fallback };
  const f = fixture(t, { graphics: [] });
  const state = () => ({ catalog: {}, installed: [] });
  const mod = { id: "fixture", runtimeManagers: ["driver", "scene"].map(id => ({ id, label: id, installRuntime: async () => {}, getState: state })),
    ensureRuntime: async () => null, getRuntimeRequirements: async () => [offer] };
  const shown = [], installed = [];
  f.context.confirmRuntimeInstall = async plan => { shown.push(plan); return false; };
  assert.equal(await prepareForLaunch({ entry: {}, mod, context: f.context, info: { runtime: {} },
    registry: { listModuleIds: () => [mod.id], getModule: () => mod }, runAction: () => assert.fail("No preparation action was declared"),
    install: async (manager, payload) => installed.push(`${manager.id}:${payload.version}`) }), true);
  assert.equal(shown.length, 1, "one question: " + shown.map(plan => plan.label).join(", "));
  assert.equal(shown[0].fallbackLabel, "Scene driver 2.0", "the question names the download skipping uses");
  assert.deepEqual(installed, ["scene:2.0"]);
});

test("a runtime whose versions are found after the Play dialog downloads without a second dialog", async t => {
  const launchDownloads = Effects.launchDownloads;
  Effects.launchDownloads = async () => [];
  t.after(() => { Effects.launchDownloads = launchDownloads; });
  const asked = [], installed = [];
  let listed = false;
  const state = () => ({ catalog: {}, installed: [] });
  const host = { id: "host", label: "Host", getState: state, refreshCatalog: async () => { listed = true; }, installRuntime: async payload => installed.push(payload.version) };
  // Before the catalog is read the plan names no section; the versioned plan names the default section.
  const mod = { id: "fixture", runtimeManagers: [host], ensureRuntime: async () => listed
    ? { managerId: "host", version: "1.0", installOptions: { sectionId: "default" } }
    : { managerId: "host", version: null, discoveryRequired: true, installOptions: {} } };
  const context = { runtimeId: "native", userDataDir: "/test-launcher-data", settings: { runtimes: {} },
    confirmRuntimeInstall: async plan => { asked.push(plan.version ?? null); return true; } };
  assert.equal(await prepareForLaunch({ entry: { effects: { schema: 1 } }, mod, context,
    info: { runtime: { entries: { native: {} } } }, registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    runAction: () => assert.fail("No preparation action was declared"),
    install: async (manager, payload) => manager.installRuntime(payload) }), true);
  assert.deepEqual(asked, [null], "one dialog, before the versions are known");
  assert.deepEqual(installed, ["1.0"]);
});
