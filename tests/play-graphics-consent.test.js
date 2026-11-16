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
