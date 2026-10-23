const test = require("node:test"), assert = require("node:assert/strict");
const Plan = require("../src/modules/shared/effects/plan");
test("render requests and processing sizes stay independent and downsample chains preserve their stages", () => {
  const plan = {schema: 1, mode: "advanced", renderResolution: {height: 480}, video: [
    {id: "small", kind: "spatial", enabled: true, method: "downsample", settings: {spatialMultiplier: .5}, outputSize: {width: 854, height: 480}},
    {id: "nr", kind: "neural", enabled: false, method: "mlx-dlss", settings: {modelPath: null, temporal: false, intensity: .5}},
    {id: "large", kind: "spatial", enabled: true, method: "metalfx", settings: {spatialMultiplier: 2}}
  ]};
  const result = Plan.validate(plan);
  assert.deepEqual(result.renderResolution, {height: 480}); assert.deepEqual(result.video[0].outputSize, {width: 854, height: 480});
  assert.equal(result.video[0].settings.spatialMultiplier, .5); assert.equal(result.video[0].settings.spatialMethod, "bilinear");
  assert.deepEqual(Plan.validate(result), result);
  for (const renderResolution of [{height: 0}, {height: NaN}, {height: 480, multiplier: 2}, {multiplier: .5}])
    assert.throws(() => Plan.validate({...plan, renderResolution}), /render height/);
  for (const outputSize of [{width: 0, height: 480}, {width: 854.5, height: 480}, {width: 854, height: 20000}, {width: 854, height: 480, extra: true}])
    assert.throws(() => Plan.validate({...plan, video: [{...plan.video[0], outputSize}]}), /output dimensions/);
});
test("legacy conversion preserves order, parameters and settings without activating or mutating a plan", async () => {
  const entry = { reshade: { enabled: true, preset: "shader:crt-royale:royale", parameters: { V__diffusion_weight: [.2] } },
    graphics: { temporalMethod: "fsr2", spatialMethod: "fsr1", effectPlacement: "after", frameGeneration: "lsfg", targetFps: 144 } };
  const before = structuredClone(entry), plan = Plan.fromLegacy(entry);
  assert.deepEqual(plan.video.map(row => row.id), ["legacy-temporal", "legacy-spatial", "legacy-shader", "legacy-frame-generation"]);
  assert.deepEqual(plan.video[2].shader.parameters, entry.reshade.parameters);
  assert.equal(plan.video[3].settings.targetFps, 144); assert.deepEqual(entry, before); assert.equal(entry.effects, undefined);
  entry.graphics.effectPlacement = "before"; assert.deepEqual(Plan.fromLegacy(entry).video.map(row => row.kind), ["temporal", "shader", "spatial", "frame-generation"]);
  assert.deepEqual(Plan.fromLegacy({}).video, []);
  const browser = await import("../src/modules/shared/effects/plan.mjs");
  assert.deepEqual(browser.fromLegacy(before).video.map(row => row.id), plan.video.map(row => row.id));
  const advanced = { ...plan, video: [...plan.video].reverse() }; entry.effects = advanced;
  assert.deepEqual(Plan.fromLegacy(entry), Plan.validate(advanced));
  const changed = Plan.fromLegacy(entry); changed.video[0].settings.targetFps = 30;
  assert.equal(entry.effects.video[0].settings.targetFps, 144);
});
test("ordered plans preserve independent shader controls, disabled nodes and stable identity", () => {
  const plan = { schema: 1, mode: "advanced", video: [
    { id: "shader-a", kind: "shader", enabled: true, shader: { preset: "crt", parameters: { V__Strength: [.2] } } },
    { id: "shader-b", kind: "shader", enabled: false, shader: { preset: "grayscale", parameters: { V__Strength: [.8] } } },
    { id: "scaler", kind: "spatial", enabled: true, method: "fsr1", settings: { spatialSharpness: .7 } }
  ] };
  const result = Plan.validate(plan);
  assert.deepEqual(result.video.map(row => row.id), ["shader-a", "shader-b", "scaler"]);
  assert.equal(result.video[1].enabled, false); assert.deepEqual(result.video[1].shader.parameters, { V__Strength: [.8] });
  assert.equal(result.video[2].settings.spatialMethod, "fsr1"); assert.equal(result.video[2].settings.spatialSharpness, .7);
  assert.deepEqual(Plan.validate(result), result);
  assert.throws(() => Plan.validate({ ...plan, video: [plan.video[0], plan.video[0]] }), /unique/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[2], settings: { depth: true } }] }), /graphics settings/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[0], graphicsInputs: { motionVectors: true } }] }), /unsupported fields/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[0], shader: { preset: "unknown" } }] }), /supported.*preset/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[0], shader: { parameters: { X: [Infinity] } } }] }), /finite/);
  assert.equal(Plan.normalize({ schema: 8, mode: "advanced", video: [] }), null);
});
test("advanced parameter maps retain 4096 independent values beyond the simple live packet", () => {
  const parameters = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => ["Parameter" + i, [i, .5]]));
  const plan = { schema: 1, mode: "advanced", video: [{ id: "large", kind: "shader", enabled: true, shader: { preset: "grayscale", parameters } }] };
  assert.deepEqual(Plan.validate(plan).video[0].shader.parameters, parameters);
  assert.equal(Object.keys(Plan.fromLegacy({ effects: plan }).video[0].shader.parameters).length, 4096);
  parameters.Extra = [0]; assert.throws(() => Plan.validate(plan), /4096/);
  const longName = "LongUniform".repeat(40);
  const row = { ...plan, video: [{ ...plan.video[0], shader: { preset: "grayscale", parameters: { [longName]: [3.4028234e38] } } }] };
  assert.equal(Plan.validate(row).video[0].shader.parameters[longName][0], 3.4028234e38);
  row.video[0].shader.parameters[longName] = [1e100];
  assert.throws(() => Plan.validate(row), /finite/);
});
test("ordering preserves original input coordinates and never enables unavailable or invented inputs", () => {
  const shader = { id: "colour", kind: "shader", enabled: true, shader: { preset: "grayscale" } };
  const temporal = { id: "temporal", kind: "temporal", enabled: true, method: "fsr2", settings: {} };
  const make = video => ({ schema: 1, mode: "advanced", video });
  assert.throws(() => Plan.validateOrdering(make([shader, temporal])), /unknown screen coordinates/);
  assert.doesNotThrow(() => Plan.validateOrdering(make([shader, temporal]), { nodes: { colour: { preservesCoordinates: true } } }));
  assert.doesNotThrow(() => Plan.validateOrdering(make([temporal, shader])));
  assert.throws(() => Plan.validateOrdering(make([shader]), { nodes: { colour: { available: false, reason: "Missing depth" } } }), /Missing depth/);
  assert.doesNotThrow(() => Plan.validateOrdering(make([{ ...shader, enabled: false }]), { nodes: { colour: { available: false } } }));
  assert.throws(() => Plan.validateOrdering(make([temporal, shader]), { nodes: { colour: { requirements: { depth: true } } } }), /Depth and motion/);
});
test("the shared catalog uses actual presentation and game inputs without manufacturing temporal or depth support", () => {
  const reshadeState = { available: true, presets: [{ id: "crt", label: "CRT" }, { id: "chain", label: "Combine effects" }, { id: "custom", label: "Custom effect…" },
    { id: "shader:quint:mxao", label: "MXAO", available: true, depthHosts: ["explicit"] }], models: [] };
  const graphicsCapabilities = { spatial: true, spatialMethods: ["bilinear", "fsr1"], temporal: true,
    temporalMethods: ["metalfx"], cameraTemporalMethods: ["fsr2"], frameGeneration: true, frameGenerationMethods: ["lsfg"] };
  const make = extra => Plan.catalog({ reshadeState, graphicsCapabilities, graphicsHost: "explicit", ...extra });
  const find = (rows, id) => rows.find(row => row.id === id);
  const none = make(); assert.equal(find(none, "shader:crt").available, true); assert.equal(find(none, "shader:chain").available, true);
  assert.deepEqual(find(none, "shader:custom").template.shader, { enabled: true, preset: "custom", effectPath: null });
  assert.equal(find(none, "spatial:fsr1").available, true); assert.equal(find(none, "temporal:metalfx").available, false);
  assert.equal(find(none, "shader:quint:mxao").available, false); assert.equal(find(none, "frame-generation:lsfg").available, false);
  const camera = make({ graphicsInputs: { cameraProjection: true, methods: ["fsr2"] } });
  assert.equal(find(camera, "temporal:fsr2").available, true); assert.equal(find(camera, "temporal:metalfx").available, false);
  assert.equal(find(camera, "shader:quint:mxao").available, false, "Camera capability is not a shader depth texture");
  const direct = make({ graphicsInputs: { depth: true, motionVectors: true, methods: ["metalfx"] } });
  assert.equal(find(direct, "temporal:metalfx").available, true); assert.equal(find(direct, "shader:quint:mxao").available, true);
  const withModel = make({ reshadeState: { ...reshadeState, models: [{ version: "sha256-" + "a".repeat(64), capabilities: ["lsfgFp16Quality"] }] } });
  const fg = find(withModel, "frame-generation:lsfg"); assert.equal(fg.available, true); assert.deepEqual(fg.requirements, ["models"]);
  assert.equal(fg.template.settings.modelVersion, "sha256-" + "a".repeat(64)); assert.equal(fg.template.settings.frameGeneration, "lsfg");
  assert.ok(none.every(row => row.template.kind === row.kind && typeof row.available === "boolean" && Array.isArray(row.requirements)));
});
test("new spatial rows do not inherit a Simple producer divisor as an extra processing upscale", () => {
  const rows = Plan.catalog({ graphicsSettings: { spatialMethod: "ls1", spatialMultiplier: 2, spatialSharpness: .7 },
    graphicsCapabilities: { spatial: true, spatialMethods: ["bilinear", "metalfx", "ls1", "libplacebo:ewa_lanczos"] } });
  for (const row of rows.filter(row => row.kind === "spatial")) {
    assert.equal(row.template.settings.spatialMultiplier, row.template.method === "downsample" ? .5 : null);
    assert.equal(row.template.settings.spatialSharpness, .7);
  }
});
