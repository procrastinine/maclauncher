const test = require("node:test"), assert = require("node:assert/strict");
const Source = require("../src/modules/shared/reshade/source-resolution"), Plans = require("../src/modules/shared/effects/plan");
test("custom percentages prefer a supported native request, then virtual allocation, then GPU processing", () => {
  const request = {multiplier: 100 / 63}, options = {host:"window",processing:true,
    inputs:{sourceResolution:{control:"engine",heights:true,multipliers:[1,2]}},
    virtualWindow:{activationAPI:1,percentageAPI:1}};
  const plan = Plans.validate({schema:2,mode:"advanced",video:[],renderResolution:request});
  assert.deepEqual(plan.renderResolution,request);
  assert.equal(Source.resolve(request,options).strategy,"virtual");
  const fallback = Source.resolve(request,{...options,excludedControls:{virtual:"allocation rejected"}});
  assert.equal(fallback.strategy,"processing");assert.deepEqual(fallback.processing,{method:"downsample",presentationScale:.63});
  assert.equal(Source.resolve(request,{...options,virtualWindow:{activationAPI:1}}).strategy,"processing","older virtual parsers never receive unsupported percentages");
  const native = {multiplier:2};assert.equal(Source.resolve(native,options).strategy,"engine");
  assert.equal(Source.resolve(native,{...options,excludedControls:{engine:"native allocation rejected"}}).strategy,"virtual");
  const satisfied=Source.resolve(request,{...options,completedSource:{verified:true,dimensions:{width:630,height:630},outputSize:{width:1000,height:1000}}});
  assert.equal(satisfied.satisfied,true);assert.equal(satisfied.requiresSourceChange,false);assert.equal(satisfied.processing,null,"an already reduced source is not reduced twice");
});
test("Simple processing budgets share accepted request divisors without widening native allocation capabilities", () => {
  const Model = require("../src/modules/shared/effects/plan.mjs"), Graphics = require("../src/modules/shared/reshade/graphics-settings"), StoredPlan = require("../src/modules/shared/effects/stored-plan");
  assert.equal(Source.REQUEST_DIVISORS, Model.RENDER_DIVISORS);
  assert.deepEqual(Source.DIVISORS, [1, 1.5, 2, 3]);
  for (const divisor of Model.RENDER_DIVISORS) {
    const graphics = Graphics.updateSettings({}, {spatialMethod: "fsr1", spatialMultiplier: divisor});
    assert.equal(Graphics.normalizeSettings(graphics).spatialMultiplier, divisor);
    const plan = StoredPlan.upgradeLegacy({graphics}, {graphicsHost: "remote", graphicsInputs: {sourceResolution: false},
      graphicsCapabilities: {spatial: true, spatialMethods: ["bilinear", "fsr1"], resolutionMultipliers: []}}).effects;
    assert.deepEqual(plan.renderResolution, {multiplier: divisor});
    assert.equal(plan.video.find(node => node.method === "fsr1").settings.spatialMultiplier, null);
    const resolved = Source.resolve(plan.renderResolution, {host: "remote", inputs: {sourceResolution: false}, processing: true});
    assert.equal(resolved.strategy, divisor === 1 ? "original" : "processing");
    if (divisor !== 1) assert.deepEqual(resolved.processing, {method: "downsample", presentationScale: 1 / divisor});
  }
  assert.deepEqual(Source.capabilities("remote", {sourceResolution: false}, [1, 2, 4]), {heights: false, multipliers: []});
});
test("Auto divisor uses fitted content and rounded targets stay inside physical bounds", () => {
  const source = {width: 1920, height: 1080}, output = {width: 1000, height: 1400};
  assert.equal(Source.automaticDivisor(output, source), 1);
  assert.equal(Source.automaticDivisor(output), 2);
  assert.equal(Source.automaticDivisor({width: 2560, height: 1440}, source), 3);
  assert.equal(Source.automaticDivisor({width: 3840, height: 2160}, source), 4);
  const decision = Source.resolve({automatic: true}, {processing: true, outputSize: output,
    completedSource: {verified: true, dimensions: source}});
  assert.deepEqual(decision.target, {width: 1000, height: 563});
});
test("Simple adaptive source requests require an advertised source API and keep Advanced explicit", () => {
  const request = {automatic: true}, options = {host: "window", processing: true,
    inputs: {sourceResolution: {control: "engine", live: true, heights: true, multipliers: [2]}},
    virtualWindow: {activationAPI: 1, autoAPI: 1}};
  const virtual = Source.resolve(request, options);
  assert.equal(virtual.strategy, "virtual");assert.equal(virtual.support.automatic, true);
  assert.deepEqual(virtual.source, request);assert.equal(virtual.fallbackReasons[0].control, "engine");
  assert.equal(Source.resolve(request, {...options, inputs: {sourceResolution: {...options.inputs.sourceResolution, automatic: true}}}).strategy, "engine");
  for (const virtualWindow of [false, true, {activationAPI: 1}]) {
    const result = Source.resolve(request, {...options, virtualWindow});
    assert.equal(result.strategy, "processing");assert.deepEqual(result.processing, {method: "downsample", resolutionAuto: true});
  }
  assert.throws(() => Plans.validate({schema: 1, mode: "advanced", video: [], renderResolution: request}), /render height/);
  for (const source of [{automatic: false}, {automatic: 1}, {automatic: true, height: 540}, {automatic: true, multiplier: 2}, {automatic: true, method: "bilinear"}])
    assert.throws(() => Source.normalizeRequest(source), /Automatic/);
});
test("adaptive source targets follow physical output, letterboxing and resize without enlarging satisfied sources", () => {
  const observed = {verified: true, dimensions: {width: 1920, height: 1080}};
  const cases = [[1920, 1080, 960, 540], [2560, 1440, 854, 480], [3840, 2160, 960, 540],
    [3024, 1964, 1008, 567], [800, 600, 800, 450], [600, 400, 600, 338]];
  for (const [width, height, expectedWidth, expectedHeight] of cases) {
    const decision = Source.resolve({automatic: true}, {processing: true, outputSize: {width, height}, completedSource: observed});
    assert.deepEqual(decision.target, {width: expectedWidth, height: expectedHeight}, `${width}x${height}`);
  }
  const smaller = Source.resolve({automatic: true}, {processing: true, outputSize: {width: 3840, height: 2160},
    completedSource: {verified: true, dimensions: {width: 640, height: 360}}});
  assert.equal(smaller.satisfied, true);assert.equal(smaller.processing, null);assert.equal(smaller.requiresSourceChange, false);
  const guessed = Source.resolve({automatic: true}, {processing: true, outputSize: {width: 3840, height: 2160},
    completedSource: {dimensions: {width: 640, height: 360}}});
  assert.equal(guessed.satisfied, false);assert.deepEqual(guessed.processing, {method: "downsample", resolutionAuto: true});
});
test("source allocation requires a cooperating renderer and never follows generic window presentation", () => {
  for (const host of ["window", "catalyst", "remote", null]) for (const sourceResolution of [undefined, false, true, {}, {heights: true, multipliers: [2]}])
    assert.deepEqual(Source.capabilities(host, {sourceResolution}, [1, 2]), {heights: false, multipliers: []});
  const inputs = {sourceResolution: {control: "engine", heights: true, multipliers: [1, 2, 3, 7]}};
  assert.deepEqual(Source.capabilities("window", inputs), {heights: true, multipliers: [1, 2, 3], control: "engine"});
  assert.deepEqual(Source.environment(Source.capabilities("window", inputs)), {RESHADE_RENDER_SOURCE_CONTROL: "engine"});
  assert.deepEqual(Source.capabilities("explicit", inputs, [1, 1.5, 2]), {heights: false, multipliers: [1, 1.5, 2]});
  assert.deepEqual(Source.capabilities("window", {...inputs, nativeVideo: true}), {heights: false, multipliers: []});
});
test("virtual source sizing is an explicit included capability and retains renderer precedence", () => {
  assert.deepEqual(Source.capabilities("window", {}, [], true), {heights: true, multipliers: [1, 1.5, 2, 3], control: "virtual"});
  for (const host of ["remote", "catalyst"]) assert.deepEqual(Source.capabilities(host, {}, [], true), {heights: false, multipliers: []});
  for (const inputs of [{nativeVideo: true}, {sourceResolution: false}]) assert.deepEqual(Source.capabilities("window", inputs, [], true), {heights: false, multipliers: []});
  const inputs = {sourceResolution: {control: "engine", heights: true, multipliers: [2]}};
  assert.equal(Source.capabilities("window", inputs, [], true).control, "engine");
});
test("source filter names and labels come only from a cooperating renderer", () => {
  const sourceResolution = {control: "engine", heights: true, multipliers: [2], methods: ["fsr1", "fsr1", "bad method", null], methodLabels: {fsr1: "FSR 1", unknown: "Other"}};
  assert.deepEqual(Source.capabilities("window", {sourceResolution}), {control: "engine", heights: true, multipliers: [2], methods: ["fsr1"], methodLabels: {fsr1: "FSR 1"}});
  const plan = {schema: 1, mode: "advanced", video: [], renderResolution: {multiplier: 2, method: "fsr1"}};
  assert.equal(Plans.validate(plan).renderResolution.method, "fsr1");
  assert.throws(() => Plans.validate({...plan, renderResolution: {method: "fsr1"}}), /render height/);
  assert.throws(() => Plans.validate({...plan, renderResolution: {height: 480, method: "bad method"}}), /render height/);
});
test("presentation-relative stage dimensions are explicit, bounded and distinct from fixed pixel dimensions", () => {
  const row = {id: "small", kind: "spatial", method: "downsample", enabled: true, presentationScale: .5, settings: {spatialMultiplier: null}};
  const plan = {schema: 1, mode: "advanced", video: [row]};
  assert.equal(Plans.validate(plan).video[0].presentationScale, .5);
  for (const patch of [{presentationScale: 0}, {presentationScale: 2}, {presentationScale: NaN}, {outputSize: {height: 480}}])
    assert.throws(() => Plans.validate({...plan, video: [{...row, ...patch}]}), /output size|window scale/);
  assert.equal(Plans.validate({...plan, video: [{...row, method: "bicubic", presentationScale: 2}]}).video[0].presentationScale, 2);
});
test("image history may consume generated images while scene operations retain original guides", () => {
  const generation = {id: "frames", kind: "frame-generation", method: "lsfg", enabled: true, settings: {}},
    neural = {id: "neural", kind: "neural", method: "mlx-dlss", enabled: true, settings: {temporal: true}};
  const plan = {schema: 1, mode: "advanced", video: [generation, neural]};
  assert.equal(Plans.validateOrdering(plan).video[1].settings.temporal, true);
  assert.equal(Plans.validateOrdering({...plan, video: [neural, generation]}).video.length, 2);
  assert.equal(Plans.validateOrdering({...plan, video: [generation, {...neural, settings: {temporal: false}}]}).video.length, 2);
  const scene = {id: "scene", kind: "temporal", method: "mlx-sr-scene", enabled: true, settings: {}};
  assert.throws(() => Plans.validateOrdering({...plan, video: [generation, scene]}), /scene|motion|original/i);
});
test("source strategy uses the renderer API, then compatible virtual sizing, then completed-frame downsampling", () => {
  const request = {height: 480, maximum: true, method: "fsr1"};
  const inputs = {sourceResolution: {control: "engine", heights: true, multipliers: [2], methods: ["fsr1"]}};
  const common = {host: "window", inputs, virtualWindow: true, processing: true};
  const engine = Source.resolve(request, common);
  assert.equal(engine.strategy, "engine");assert.deepEqual(engine.source, request);assert.equal(engine.processing, null);
  const virtual = Source.resolve(request, {...common, excludedControls: {engine: "The game has no active 3D camera."}});
  assert.equal(virtual.strategy, "virtual");assert.deepEqual(virtual.source, {height: 480, maximum: true});
  assert.deepEqual(virtual.fallbackReasons, [{control: "engine", reason: "The game has no active 3D camera."}]);
  assert.match(virtual.reason, /preserves the renderer's filter/);
  const processing = Source.resolve(request, {...common, virtualWindow: false, excludedControls: {engine: "Renderer source control is inactive."},
    outputSize: {width: 3840, height: 2160}, completedSource: {verified: true, dimensions: {width: 1920, height: 1080}}});
  assert.equal(processing.strategy, "processing");assert.deepEqual(processing.processing, {method: "downsample", outputSize: {height: 480}});
  assert.equal(processing.requiresSourceChange, false);assert.deepEqual(processing.target, {width: 854, height: 480});
  assert.match(processing.reason, /without reducing game rendering work/);
  assert.deepEqual(request, {height: 480, maximum: true, method: "fsr1"}, "the saved request remains unchanged");
});
test("unsupported renderer dimensions can fall back to virtual control without widening its declared API", () => {
  const inputs = {sourceResolution: {control: "engine", heights: false, multipliers: [2]}};
  assert.equal(Source.capabilities("window", inputs, [], true).heights, false);
  assert.equal(Source.resolve({height: 480}, {host: "window", inputs, virtualWindow: true}).strategy, "virtual");
  assert.equal(Source.resolve({multiplier: 3}, {host: "window", inputs, virtualWindow: true}).strategy, "virtual");
  assert.equal(Source.resolve({multiplier: 2}, {host: "explicit", producerDivisors: [2]}).strategy, "producer");
  for (const host of ["remote", "catalyst", "explicit"]) {
    const result = Source.resolve({multiplier: 2}, {host, inputs: {}, virtualWindow: true, processing: true});
    assert.equal(result.strategy, "processing");assert.deepEqual(result.processing, {method: "downsample", presentationScale: .5});
  }
});
test("quarter-resolution requests use processing without advertising unsupported native divisors", async () => {
  const request = {multiplier: 4}, inputs = {sourceResolution: {control: "engine", heights: true, multipliers: [1, 2, 3, 4]}};
  const plan = {schema: 1, mode: "advanced", video: [], renderResolution: request};
  assert.deepEqual(Plans.validate(plan).renderResolution, request);
  assert.deepEqual((await import("../src/modules/shared/effects/plan.mjs")).validate(plan).renderResolution, request);
  assert.deepEqual(Source.DIVISORS, [1, 1.5, 2, 3]);
  for (const options of [
    {host: "window", inputs, virtualWindow: true},
    {host: "explicit", producerDivisors: [1, 2, 3, 4]},
    {host: "remote"}
  ]) {
    assert.equal(Source.capabilities(options.host, options.inputs, options.producerDivisors, options.virtualWindow).multipliers.includes(4), false);
    const decision = Source.resolve(request, {...options, processing: true, outputSize: {width: 3840, height: 2160}});
    assert.equal(decision.strategy, "processing");assert.equal(decision.source, null);
    assert.deepEqual(decision.processing, {method: "downsample", presentationScale: .25});
    assert.deepEqual(decision.target, {width: 960, height: 540});
    const unavailable = Source.resolve(request, options);
    assert.equal(unavailable.strategy, "original");assert.equal(unavailable.source, null);assert.equal(unavailable.processing, null);
  }
});
test("processing fallback is explicit and maximum heights use the executor's down-only clamp", () => {
  assert.deepEqual(Source.resolve({height: 480}, {processing: true}).processing, {method: "downsample", outputSize: {height: 480}});
  assert.deepEqual(Source.resolve({height: 480, maximum: true}, {processing: true}).processing, {method: "downsample", outputSize: {height: 480}});
  assert.equal(Source.resolve({multiplier: 2}, {processing: {}}).strategy, "original");
  const none = Source.resolve(null, {host: "window", virtualWindow: true, processing: true});
  assert.equal(none.strategy, "original");assert.equal(none.source, null);assert.equal(none.processing, null);assert.equal(none.requiresSourceChange, false);
  const original = Source.resolve({multiplier: 1}, {host: "window", virtualWindow: true, processing: true});
  assert.equal(original.strategy, "original");assert.equal(original.source, null);assert.equal(original.processing, null);
  for (const source of [{height: 0}, {height: 480, multiplier: 2}, {multiplier: .5}, {multiplier: 2, maximum: false}, {height: 480, method: "bad method"}])
    assert.throws(() => Source.resolve(source, {processing: true}));
});
test("already-satisfied low-DPI source uses verified producer pixels, independently of backing dimensions", () => {
  const options = {host: "window", virtualWindow: true, processing: true, outputSize: {width: 3840, height: 2160}};
  const actual = Source.resolve({multiplier: 2}, {...options, completedSource: {verified: true, dimensions: {width: 1920, height: 1080}}});
  assert.equal(actual.strategy, "virtual");assert.equal(actual.satisfied, true);assert.equal(actual.requiresSourceChange, false);
  assert.deepEqual(actual.source, {multiplier: 2}, "retain the source request for later output resizes");
  assert.equal(actual.processing, null);assert.match(actual.reason, /no source-window reduction/);
  const guessed = Source.resolve({multiplier: 2}, {...options, completedSource: {dimensions: {width: 1920, height: 1080}}});
  assert.equal(guessed.satisfied, false);assert.equal(guessed.observed, null);
});
test("processing ratios survive output resize and fixed heights preserve the current frame aspect", () => {
  const first = Source.resolve({multiplier: 2}, {processing: true, outputSize: {width: 1920, height: 1080}});
  const resized = Source.resolve({multiplier: 2}, {processing: true, outputSize: {width: 2560, height: 1600}});
  assert.deepEqual(first.processing, {method: "downsample", presentationScale: .5});
  assert.deepEqual(resized.processing, first.processing);assert.notDeepEqual(resized.target, first.target);
  assert.deepEqual(first.target, {width: 960, height: 540});assert.deepEqual(resized.target, {width: 1280, height: 800});
  for (const outputSize of [{width: 1920, height: 1080}, {width: 2560, height: 1600}])
    assert.deepEqual(Source.resolve({height: 480}, {processing: true, outputSize}).processing, {method: "downsample", outputSize: {height: 480}});
  const capped = Source.resolve({height: 480, maximum: true}, {processing: true, completedSource: {verified: true, dimensions: {width: 640, height: 360}}});
  assert.equal(capped.satisfied, true);assert.equal(capped.processing, null);assert.deepEqual(capped.target, {width: 640, height: 360});
});
test("convenience ownership survives the plan but is absent from producer size commands", () => {
  const request={multiplier:2,managedBy:"upscale-default"};
  const plan=Plans.validate({schema:2,mode:"advanced",video:[],renderResolution:request});
  assert.deepEqual(plan.renderResolution,request);
  const decision=Source.resolve(request,{host:"window",virtualWindow:true,processing:true});
  assert.equal(decision.strategy,"virtual");assert.deepEqual(decision.source,{multiplier:2});
  assert.throws(()=>Plans.validate({...plan,renderResolution:{...request,managedBy:"../other"}}));
});
