const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let GraphicsControls;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/GraphicsControls.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "graphics-controls.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ GraphicsControls } = compiled.exports);
});
const unavailable = { spatial: false, frameGeneration: false, spatialMethods: ["metalfx"], frameGenerationMethods: ["lsfg"] };
const status = { available: true, presets: [], graphics: { ...unavailable,
  hosts: { window: { ...unavailable, spatial: true }, remote: unavailable, explicit: unavailable } } };
const render = (graphicsHost, graphics, capabilities = status, graphicsInputs) => renderToStaticMarkup(React.createElement(GraphicsControls, {
  game: { gamePath: "/Games/Example.app", graphics }, status: capabilities, graphicsHost, graphicsInputs, running: false,
  onChange: () => assert.fail("rendering must not save options")
}));
function elements(value) { return React.isValidElement(value) ? [value, ...React.Children.toArray(value.props.children).flatMap(elements)] : []; }
test("Simple graphics forwards current live capability to neural help", () => {
  const props = {game: {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss"}}, running: true, graphicsHost: "window",
    status: {...status, neuralAvailable: true}, onChange: () => assert.fail("help must not save")};
  for (const live of [false, true]) {
    const harness = componentHarness(GraphicsControls, {...props, live});
    try { assert.equal(elements(harness.render()).find(node => node.type?.name === "SimpleNeuralControls").props.live, live); }
    finally { harness.close(); }
    const markup = renderToStaticMarkup(React.createElement(GraphicsControls, {...props, live}));
    if (live) assert.match(markup, /Supported processing changes can update during play/);
    else assert.doesNotMatch(markup, /settings and managed model selections update during play|Supported processing changes can update during play/);
  }
});
test("model-dependent Simple choices prepare once, preserve cancel and save only the requested controls", async () => {
  const previous = global.window, saved = [], requests = [];let complete;
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: (...args) => {
    requests.push(args);return new Promise(resolve => {complete = resolve;});
  }}}};
  const graphics = {spatialMethod: "metalfx", neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"};
  const supported = {...status, neuralAvailable: true, graphics: {...unavailable, spatial: true, spatialMethods: ["metalfx", "fsr1", "ls1"], frameGeneration: true}};
  const harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics}, status: supported, graphicsHost: "window", running: false,
    onChange: async (...args) => saved.push(args)});
  const find = id => elements(harness.render()).find(node => node.props.id === id);
  try {
    assert.match(renderToStaticMarkup(harness.render()), /DLSS 5 · Experimental/);
    assert.ok(find("game-spatial-method"));assert.ok(find("game-frame-generation"));
    find("game-frame-generation").props.onChange({target: {value: "4"}});
    find("game-frame-generation").props.onChange({target: {value: "3"}});
    assert.equal(requests.length, 1);assert.equal(harness.render().props.disabled, false);assert.equal(harness.render().props["aria-busy"], true);assert.deepEqual(saved, []);
    assert.deepEqual(requests[0], ["/Game", "lossless", {frameGeneration: "lsfg", frameMultiplier: 4}]);
    complete(null);await harness.settle();assert.equal(harness.render().props.disabled, false);assert.deepEqual(saved, []);
    find("game-frame-generation").props.onChange({target: {value: "4"}});complete({modelVersion: "prepared"});await harness.settle();
    assert.deepEqual(saved, [["/Game", {frameGeneration: "lsfg", frameMultiplier: 4, modelVersion: "prepared"}]]);
    find("game-spatial-method").props.onChange({target: {value: "fsr1"}});await harness.settle();
    assert.deepEqual(saved[1], ["/Game", {spatialMethod: "fsr1"}]);assert.equal(requests.length, 2);
    find("game-spatial-method").props.onChange({target: {value: "ls1"}});
    assert.deepEqual(requests[2], ["/Game", "lossless", {spatialMethod: "ls1"}]);
    complete({modelVersion: "ls1-model"});await harness.settle();
    assert.deepEqual(saved[2], ["/Game", {spatialMethod: "ls1", modelVersion: "ls1-model"}]);
    global.window.MacLauncher.launcher.ensureGameGraphicsModel = async () => {throw new Error("Compatible models could not be prepared.");};
    find("game-frame-generation").props.onChange({target: {value: "4"}});await harness.settle();
    assert.equal(saved.length, 3);assert.match(renderToStaticMarkup(harness.render()), /role="alert">Compatible models could not be prepared\./);
    assert.deepEqual(graphics, {spatialMethod: "metalfx", neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"});
  } finally {harness.close();global.window = previous;}
});
test("an unrelated scaler change does not prepare missing saved frame-generation models", async () => {
  const saved = [], harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics: {frameGeneration: "lsfg", spatialMethod: "metalfx"}},
    status: {...status, graphics: {...unavailable, spatial: true, spatialMethods: ["metalfx", "fsr1"], frameGeneration: true}}, running: false,
    onChange: async (...args) => saved.push(args)});
  try {
    elements(harness.render()).find(node => node.props.id === "game-spatial-method").props.onChange({target: {value: "fsr1"}});await harness.settle();
    assert.deepEqual(saved, [["/Game", {spatialMethod: "fsr1"}]]);
  } finally {harness.close();}
});
test("automatic model status selects a model compatible with every active choice and preserves explicit bad selections", () => {
  const models = [{version: "ls1", label: "LS1 only", capabilities: ["ls1Quality"]},
    {version: "fg", label: "FG only", capabilities: ["lsfgFp16Quality"]},
    {version: "both", label: "Combined models", capabilities: ["ls1Quality", "lsfgFp16Quality"]}];
  const capabilities = {...status, models, defaultModelVersion: "ls1", graphics: {...unavailable, spatial: true, spatialMethods: ["ls1"], frameGeneration: true}};
  const selected = {spatialMethod: "ls1", frameGeneration: "lsfg"};
  const automatic = render(undefined, selected, capabilities);
  assert.doesNotMatch(automatic, /Compatible Lossless Scaling models are required|The selected models do not support/);
  assert.match(automatic, /Automatic · Combined models/);
  const explicit = render(undefined, {...selected, modelVersion: "ls1"}, capabilities);
  assert.match(explicit, /The selected models do not support/);assert.match(explicit, /value="ls1" disabled="" selected=""/);
});
test("Simple scaling reports live changes only for a currently bound process", () => {
  const capabilities = {...status, graphics: {...status.graphics, hosts: {...status.graphics.hosts,
    window: {...status.graphics.hosts.window, liveSwitching: true}}}};
  const props = {game: {gamePath: "/Games/Current", graphics: {spatialMethod: "metalfx"}}, status: capabilities,
    graphicsHost: "window", running: true, onChange: () => assert.fail("render does not save")};
  const pending = renderToStaticMarkup(React.createElement(GraphicsControls, {...props, live: false}));
  assert.match(pending, /Applies on the next launch\./);assert.doesNotMatch(pending, /Supported controls update during play/);
  assert.match(pending, /aria-label="About graphics changes"/);assert.doesNotMatch(pending, /<div class="detailMeta">Applies on the next launch/);
  assert.match(renderToStaticMarkup(React.createElement(GraphicsControls, {...props, live: true})), /Supported controls update during play/);
});
test("scaling controls show only methods supported by the selected runtime's presentation host", () => {
  assert.match(render("window"), /value="metalfx">MetalFX Spatial/);
  assert.match(render("window"), /<section class="graphicsGroup" aria-label="Scaling and frame generation">/);
  assert.match(render("window"), /<h4 class="detailSectionHeading">Scaling and frame generation/);
  assert.doesNotMatch(render("window"), /<legend>|Graphics processing/);
  assert.doesNotMatch(render("window"), /id="game-frame-generation"/);
  for (const host of [undefined, "remote", "explicit"]) assert.equal(render(host), "");
});
test("original renderer filters augment shared controls, display the saved native default and hide source allocation", () => {
  const inputs = { source: "native-video", nativeVideo: true, sourceResolution: false, nativeSpatialMethods: ["nearest", "bilinear", "bicubic", "libplacebo:ewa_lanczossharp", "libplacebo:ewa_hanning"],
    nativeSpatialMethodLabels: { "libplacebo:ewa_lanczossharp": "Lanczos · Sharp" }, cameraProjection: false, methods: [] };
  const capabilities = { ...status, graphics: { ...status.graphics, hosts: { ...status.graphics.hosts, window: { ...status.graphics.hosts.window,
    spatialMethods: ["metalfx", "libplacebo:ewa_jinc"], resolutionMultipliers: [1, 2] } } } };
  const markup = render("window", { spatialMethod: "libplacebo:ewa_lanczossharp" }, capabilities, inputs);
  assert.match(markup, /value="libplacebo:ewa_lanczossharp" selected="">Lanczos · Sharp/);
  assert.match(markup, /value="nearest">Nearest neighbor/);assert.doesNotMatch(markup, /value="libplacebo:ewa_hanning"/);
  assert.match(markup, /value="metalfx">MetalFX Spatial/);assert.doesNotMatch(markup, /ewa_jinc|game-resolution-multiplier/);
  assert.match(markup, /Off uses the player&#x27;s basic bilinear resize/);
});
test("Simple keeps common scalers compact while preserving exact saved traditional methods", async () => {
  const methods = ["nearest", "bilinear", "bicubic", "metalfx", "fsr1", "mako", "ls1", "libplacebo:nearest", "libplacebo:bilinear",
    "libplacebo:bicubic", "libplacebo:triangle", "libplacebo:ewa_hann", "libplacebo:ewa_hanning", "libplacebo:lanczos"];
  const capabilities = {...status, graphics: {...unavailable, spatial: true, spatialMethods: methods}};
  const normal = render(undefined, {}, capabilities);
  const menu = normal.match(/<select id="game-spatial-method"[\s\S]*?<\/select>/)[0];
  assert.equal((menu.match(/<option /g) || []).length, 9, "Off, seven common methods and the custom shader route");
  assert.doesNotMatch(menu, /libplacebo:|triangle|ewa_/);
  const saved = {spatialMethod: "libplacebo:ewa_hanning"}, changes = [];
  const harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics: saved}, status: capabilities,
    running: false, onChange: async (...args) => changes.push(args)});
  try {
    const markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /optgroup label="Selected filter"/);
    assert.match(markup, /value="libplacebo:ewa_hanning" selected="">EWA Hann/);
    assert.doesNotMatch(markup, /value="libplacebo:ewa_hann"|ewa_hanning<|Unavailable/);
    elements(harness.render()).find(node => node.props.id === "game-spatial-method").props.onChange({target: {value: "fsr1"}});
    await harness.settle();assert.deepEqual(changes, [["/Game", {spatialMethod: "fsr1"}]]);
    assert.equal(saved.spatialMethod, "libplacebo:ewa_hanning", "presentation does not migrate saved IDs");
  } finally {harness.close();}
  const missing = render("remote", {spatialMethod: "libplacebo:triangle"});
  assert.match(missing, /value="libplacebo:triangle" disabled="" selected="">Bilinear · Unavailable/);
});
test("temporal controls name actual implementations and expose only compatible host methods", () => {
  const capabilities = { ...status, graphics: { ...status.graphics, hosts: {
    ...status.graphics.hosts, window: { ...unavailable, temporal: true, temporalMethods: ["metalfx", "fsr4"] }
  } } };
  const markup = render("window", { temporalMethod: "fsr4", temporalSharpness: 0.25 }, capabilities);
  assert.match(markup, /value="off">Game default/);
  assert.match(markup, /value="metalfx">MetalFX Temporal/);
  assert.match(markup, /value="fsr4" selected="">FSR 4.1/);
  assert.match(markup, /<optgroup label="Apple MetalFX">/);
  assert.match(markup, /<optgroup label="AMD FidelityFX">/);
  assert.match(markup, /id="game-temporal-sharpness"[^>]*value="0.25"/);
  assert.match(markup, /motion vectors, depth and jitter/);
  assert.doesNotMatch(markup, /value="fsr2"|value="fsr3"|DLSS|game-spatial-method/);
  assert.equal(render("remote", {}, capabilities), "");
  const unsupported = render("remote", { temporalMethod: "fsr4" }, capabilities);
  assert.match(unsupported, /value="fsr4" disabled="" selected="">FSR 4.1 · Unavailable/);
  assert.match(unsupported, /value="off">Game default/);
});
test("declared scene methods constrain temporal choices and preserve unavailable saved selections", () => {
  const capabilities = {...status, graphics: {...status.graphics, hosts: {
    window: {...unavailable, spatial: true, temporal: true, temporalMethods: ["metalfx", "fsr4"], cameraTemporalMethods: ["fsr3"]}
  }}};
  // The contract is authoritative independently of the runtime's name/type.
  const noScene = {source: "completed-color", cameraProjection: false, depth: false, motionVectors: false, methods: []};
  assert.doesNotMatch(render("window", {}, capabilities, noScene), /game-temporal-method|value="fsr4"/);
  const nativeVideo = {...noScene, nativeVideo: true};
  assert.doesNotMatch(render("window", {}, capabilities, nativeVideo), /game-temporal-method/);
  const saved = render("window", {temporalMethod: "fsr4"}, capabilities, nativeVideo);
  assert.match(saved, /value="fsr4" disabled="" selected="">FSR 4.1 · Unavailable/);
  assert.match(saved, /value="off">Game default/);
  assert.match(saved, /compatible scene inputs/);
  const declared = render("window", {temporalMethod: "fsr3"}, capabilities, {...noScene, cameraProjection: true, methods: ["fsr3"]});
  assert.match(declared, /value="fsr3" selected="">FSR 3.1/);
  assert.doesNotMatch(declared.match(/<select id="game-temporal-method"[\s\S]*?<\/select>/)[0], /value="metalfx"|value="fsr4"/);
  // Unknown metadata keeps the existing native callback capability available.
  assert.match(render("window", {}, capabilities), /value="metalfx">MetalFX Temporal/);
});
test("the cubic shader is named for its processing method rather than the reference project", () => {
  const markup = render(undefined, { spatialMethod: "mako" }, { ...status,
    graphics: { ...unavailable, spatial: true, spatialMethods: ["mako"] } });
  assert.match(markup, /value="mako" selected="">Sharpened cubic/);
  assert.doesNotMatch(markup, />MAKO</);
  assert.match(markup, /id="game-spatial-sharpness"/);
});
test("camera-dependent methods use the selected game's integration and installed providers", () => {
  const capabilities = { ...status, graphics: { ...status.graphics, hosts: {
    window: { ...unavailable, temporal: true, temporalMethods: ["metalfx"], cameraTemporalMethods: ["fsr2", "fsr3"] }
  } } };
  const inputs = { cameraProjection: true, source: "godot", methods: ["fsr3"] };
  const markup = render("window", { temporalMethod: "fsr3" }, capabilities, inputs);
  assert.match(markup, /value="fsr3" selected="">FSR 3.1/);
  assert.match(markup, /Camera projection comes from/);
  assert.doesNotMatch(markup, /value="fsr2"/);
  assert.doesNotMatch(render("window", {}, capabilities), /value="fsr2"|value="fsr3"/);
  assert.equal(render("remote", {}, capabilities, inputs), "");
});
test("an unsupported saved graphics selection stays visible and can be turned off", () => {
  const markup = render("remote", { spatialMethod: "metalfx" });
  assert.match(markup, /value="off"/);
  assert.match(markup, /value="metalfx" disabled="" selected=""/);
  assert.match(markup, /Unavailable/);
});
test("remote presentation enables the same spatial controls without enabling frame generation", () => {
  const capabilities = { ...status, graphics: { ...status.graphics,
    hosts: { ...status.graphics.hosts, remote: { ...unavailable, spatial: true } } } };
  const markup = render("remote", { spatialMethod: "metalfx" }, capabilities);
  assert.match(markup, /value="metalfx" selected=""/);
  assert.doesNotMatch(markup, /Unavailable|id="game-frame-generation"/);
  assert.equal(render("explicit", {}, capabilities), "");
});
test("FSR1 exposes sharpening only with installed presentation support and needs no model picker", () => {
  const capabilities = { ...status, graphics: { ...status.graphics,
    hosts: { ...status.graphics.hosts, window: { ...unavailable, spatial: true, spatialMethods: ["fsr1"] } } } };
  const markup = render("window", { spatialMethod: "fsr1", spatialSharpness: 0.25 }, capabilities);
  assert.match(markup, /value="fsr1" selected="">FSR 1 · Spatial/);
  assert.match(markup, /<optgroup label="AMD FidelityFX">/);
  assert.match(markup, /id="game-spatial-sharpness"/);
  assert.doesNotMatch(markup, /id="game-graphics-model"|id="game-frame-generation"/);
  assert.doesNotMatch(render("window"), /value="fsr1"/);
});
test("shared LSFG controls expose existing multiplier, precision and flow settings on all supported hosts", () => {
  const graphics = require("../src/modules/shared/reshade/features.json").graphics;
  const hosts = Object.fromEntries(Object.entries(graphics.presentation.hosts).map(([host, support]) => [host, {
    ...support, spatialMethods: graphics.spatialMethods, frameGenerationMethods: graphics.frameGenerationMethods
  }]));
  const capabilities = { ...status, graphics: { ...unavailable, hosts } };
  for (const host of ["window", "remote", "explicit"]) {
    const markup = render(host, { frameGeneration: "lsfg", frameMultiplier: 3, lsfgFp16: false, lsfgFlowScale: 0.5 }, capabilities);
    assert.match(markup, /value="3" selected="">3× frame rate · LSFG/);
    assert.doesNotMatch(markup, /id="game-frame-multiplier"/);
    assert.match(markup, /requests 2 generated frames per completed real frame/);
    assert.match(markup, /30 fps processed source targets 90 fps/);
    assert.match(markup, /id="game-lsfg-precision"/); assert.match(markup, /value="fp32" selected=""/);
    assert.match(markup, /id="game-lsfg-flow-scale"/); assert.match(markup, /id="game-graphics-model"/);
    assert.match(markup, /does not guarantee/); assert.doesNotMatch(markup, /LSFG · Unavailable/);
  }
});
test("one frame-generation choice saves method and multiplier together, while Off preserves the saved multiplier", async () => {
  const Settings = require("../src/modules/shared/reshade/graphics-settings");
  let saved = Settings.normalizeSettings({ spatialMethod: "metalfx", frameMultiplier: 5, lsfgMode: "performance" });
  const supported = { ...status, models: [{version: "local", label: "Local", capabilities: ["lsfgFp16Performance"]}], defaultModelVersion: "local",
    graphics: { ...unavailable, spatial: true, frameGeneration: true } };
  function select() {
    const harness = componentHarness(GraphicsControls, { game: { gamePath: "/Game.app", graphics: saved }, status: supported, running: false,
      onChange: async (gamePath, patch) => { assert.equal(gamePath, "/Game.app"); saved = Settings.updateSettings(saved, patch); } });
    const tree = harness.render();harness.close();
    const visit = value => {
      if (value?.props?.id === "game-frame-generation") return value;
      for (const child of React.Children.toArray(value?.props?.children)) { const result = visit(child); if (result) return result; }
    };
    return visit(tree);
  }
  assert.equal(select().props.value, "off");
  for (const factor of [2, 3, 4, 5]) {
    await select().props.onChange({ target: { value: String(factor) } });
    assert.equal(saved.frameGeneration, "lsfg"); assert.equal(saved.frameMultiplier, factor);
    assert.equal(select().props.value, String(factor));
  }
  await select().props.onChange({ target: { value: "off" } });
  assert.equal(saved.frameGeneration, "off"); assert.equal(saved.frameMultiplier, 5);
  assert.equal(saved.spatialMethod, "metalfx"); assert.equal(saved.lsfgMode, "performance");
});
test("resolution choices describe real source reduction and retain unavailable saved settings", () => {
  const supported = { ...status, graphics: { ...unavailable, spatial: true, resolutionMultipliers: [1, 1.5, 2] } };
  const markup = render("explicit", { spatialMethod: "metalfx", spatialMultiplier: 2 }, supported);
  assert.match(markup, /for="game-resolution-multiplier">Render resolution /);
  assert.match(markup, /aria-label="About render resolution"/);
  assert.match(markup, /value="2" selected="">50% · 2× upscale/);
  assert.match(markup, /value="1.5">66.7% · 1.5× upscale/);
  assert.match(markup, /value="1">100% · Original/);
  assert.match(markup, /1920 × 1080 uses 960 × 540/);
  assert.match(markup, /unchanged window or fullscreen size/);
  assert.match(markup, /Auto · Game resolution/);
  assert.doesNotMatch(markup, /value="3"/);
  assert.doesNotMatch(render("window", { spatialMethod: "metalfx" }), /game-resolution-multiplier/);
  assert.match(render("window", { spatialMethod: "metalfx", spatialMultiplier: 2 }), /value="2" disabled="" selected="">50% · 2× upscale · Unavailable/);
  assert.match(render("window", { spatialMethod: "metalfx" }), /physical pixels, including Retina scaling/);
});
test("completed-frame spatial processors offer the shared resolution budget without native source allocation", () => {
  const capabilities = {...status, graphics: {...status.graphics, hosts: {...status.graphics.hosts,
    remote: {...unavailable, spatial: true, spatialMethods: ["bilinear", "fsr1", "metalfx"]}}}};
  const markup = render("remote", {spatialMethod: "fsr1", spatialMultiplier: 2}, capabilities, {sourceResolution: false});
  assert.match(markup, /for="game-resolution-multiplier">Processing resolution /);
  assert.match(markup, /value="2" selected="">50% · 2× upscale/);
  assert.match(markup, /value="4">25% · 4× upscale/);
  assert.match(markup, /downsamples completed frames/);
  assert.match(markup, /does not reduce the game&#x27;s rendering work/);
  assert.match(render("remote", {spatialMethod: "fsr1"}, capabilities), /value="auto" selected="">Auto · Game resolution/);
  assert.doesNotMatch(render("remote", {spatialMethod: "off"}, capabilities), /game-resolution-multiplier/);
  assert.doesNotMatch(render("remote", {spatialMethod: "fsr1", temporalMethod: "metalfx"}, capabilities), /game-resolution-multiplier/);
  assert.doesNotMatch(render("remote", {spatialMethod: "fsr1"}, capabilities, {nativeVideo: true, sourceResolution: false}), /game-resolution-multiplier/);
});
test("native source controls require a declared renderer adapter and unavailable saved divisors can reset to Auto", () => {
  const supported = { ...status, graphics: { ...unavailable, spatial: true, resolutionMultipliers: [1, 1.5, 2, 3] } };
  for (const host of ["window", "catalyst"]) {
    assert.doesNotMatch(render(host, { spatialMethod: "metalfx" }, supported), /game-resolution-multiplier/);
    const saved = render(host, { spatialMethod: "metalfx", spatialMultiplier: 2 }, supported);
    assert.match(saved, /value="auto">Auto · Game resolution/);
    assert.match(saved, /value="2" disabled="" selected=""/);
    assert.doesNotMatch(saved, /value="1.5"|value="3"/);
  }
  const inputs = { source: "engine", cameraProjection: false, methods: [], sourceResolution: { heights: true, multipliers: [1, 2], control: "engine" } };
  const engine = render("window", { spatialMethod: "metalfx", spatialMultiplier: 2 }, supported, inputs);
  assert.match(engine, /value="2" selected="">50% · 2× upscale/);
  assert.match(engine, /3D render scale/);
  assert.doesNotMatch(engine, /value="1.5"|value="3"/);
});
test("included virtual presentation exposes generic source factors only on eligible window hosts", () => {
  const capabilities = { ...status, graphics: { ...unavailable, spatial: true, virtualWindow: true, resolutionMultipliers: [1, 1.5, 2, 3] } };
  const selected = { spatialMethod: "ls1", spatialMultiplier: 2 };
  assert.match(render("window", selected, capabilities), /value="2" selected="">50% · 2× upscale/);
  for (const inputs of [{ sourceResolution: false }, { nativeVideo: true }])
    assert.match(render("window", selected, capabilities, inputs), /value="2" disabled="" selected=""/);
  assert.match(render("remote", selected, capabilities), /value="2" disabled="" selected=""/);
  assert.match(render("window", selected, capabilities, { sourceResolution: { heights: true, multipliers: [1, 3], control: "engine" } }), /value="2" disabled="" selected=""/);
});
test("a registered resizing shader exposes source sizing without enabling an additional spatial filter", () => {
  const props = { game: { gamePath: "/Game", graphics: { spatialMethod: "off" }, reshade: { enabled: true, preset: "filter:resize" } },
    status: { available: true, presets: [{ id: "filter:resize", traits: { outputScale: { x: 2, y: 2 } } }],
      graphics: { ...unavailable, spatial: true, virtualWindow: true, resolutionMultipliers: [1, 2] } }, graphicsHost: "window", running: false,
    onChange: () => assert.fail("Rendering must not change settings") };
  assert.match(renderToStaticMarkup(React.createElement(GraphicsControls, props)), /game-resolution-multiplier/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(GraphicsControls, { ...props, game: { ...props.game, reshade: { enabled: true, preset: "crt" } } })), /game-resolution-multiplier/);
});
test("Simple neural uses an automatic final-fit label without changing the saved Off value", () => {
  const markup = render("window", { spatialMethod: "off", neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Test.dlssmodel", neuralInputScale: 0.5 });
  assert.match(markup, /value="off" selected="">Automatic fit/);
  assert.match(markup, /Automatic fit selects an available spatial filter after neural reconstruction/);
  const inputs = { cameraProjection: false, source: "engine", methods: [], sourceResolution: { heights: true, multipliers: [1, 2], control: "engine" } };
  const selected = { spatialMethod: "metalfx", spatialMultiplier: 2, neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Test.dlssmodel" };
  assert.doesNotMatch(render("window", selected, status, inputs), /game-resolution-multiplier/);
  assert.match(render("window", { ...selected, neuralMethod: "off" }, status, inputs), /value="2" selected="">50% · 2× upscale/);
});

test("adaptive controls expose target and cadence only for supported presentation hosts", () => {
  const capabilities = { ...status, graphics: { ...unavailable, spatial: true, frameGeneration: true, adaptive: true } };
  const markup = render(undefined, { frameGeneration: "lsfg", framePacing: "adaptive", targetFps: 90, frameMultiplier: 4, smoothCadence: true }, capabilities);
  assert.match(markup, /id="game-frame-target"[^>]*value="90"/);
  assert.match(markup, /id="game-smooth-cadence"[^>]*checked=""/);
  assert.match(markup, /selected 4× ceiling/);
  assert.match(markup, /Game rendering is not capped/);
  assert.doesNotMatch(render(undefined, { frameGeneration: "lsfg" }, { ...status, graphics: { ...unavailable, frameGeneration: true } }), /id="game-frame-pacing"/);
});
test("spatial shader choices separate actual upscalers from restoration and preserve independent CRT", async () => {
  const previous = global.window, saved = [], shader = {enabled: true, preset: "custom", effectPath: "/Shaders/resize.hook", parameters: {Strength: [.4]}},
    game = {gamePath: "/Game", graphics: {spatialShader: shader, spatialMethod: "off", spatialMultiplier: 2}, reshade: {enabled: true, preset: "crt"}};
  const support = {...status, shaderParameters: true, presets: [
    {id: "filter:resize", label: "Declared x2", traits: {category: "upscaling", neural: true, outputScale: {x: 2, y: 2}}},
    {id: "filter:restore", label: "Neural restore", traits: {category: "restoration", neural: true}}],
    graphics: {...unavailable, spatial: true, spatialMethods: ["bilinear", "metalfx", "fsr1"], resolutionMultipliers: [1, 2]}};
  global.window = {MacLauncher: {launcher: {pickGameEffectFile: async () => "/Shaders/new.glsl"}}};
  const harness = componentHarness(GraphicsControls, {game, status: support, graphicsHost: "window", running: true, live: true,
    onChange: async (...args) => saved.push(args)});
  try {
    const markup = renderToStaticMarkup(harness.render()), picker = markup.match(/<select id="game-spatial-method"[\s\S]*?<\/select>/)[0];
    assert.match(picker, /Neural upscaling shaders/);assert.match(picker, /Declared x2/);assert.doesNotMatch(picker, /Neural restore/);
    assert.match(picker, /Custom shader…/);assert.match(markup, /game-resolution-multiplier/);
    const parameters = elements(harness.render()).find(row => row.props.idPrefix === "spatial-shader");
    await parameters.props.onChange("/Game", {parameters: {Strength: [.7]}});await harness.settle();
    assert.deepEqual(saved[0], ["/Game", {spatialShader: {...shader, parameters: {Strength: [.7]}}}, {preset: "custom", effectPath: shader.effectPath, effects: undefined}]);
    elements(harness.render()).find(row => row.props.id === "game-spatial-method").props.onChange({target: {value: "shader:custom"}});await harness.settle();
    assert.equal(saved[1][1].spatialShader.effectPath, "/Shaders/new.glsl");assert.equal(game.reshade.preset, "crt");assert.equal(shader.parameters.Strength[0], .4);
  } finally {harness.close();global.window = previous;}
});
test("pending model choices coalesce to the latest multiplier and Off reaches the backend immediately", async () => {
  const previous = global.window, saved = [];let complete;
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: () => new Promise(resolve => {complete = resolve;})}}};
  const harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics: {spatialMethod: "fsr1"}},
    status: {...status, graphics: {...unavailable, spatial: true, spatialMethods: ["fsr1"], frameGeneration: true}}, running: true,
    onChange: async (...args) => saved.push(args)});
  const picker = () => elements(harness.render()).find(row => row.props.id === "game-frame-generation");
  try {
    picker().props.onChange({target: {value: "4"}});picker().props.onChange({target: {value: "3"}});
    assert.equal(picker().props.value, "3");assert.equal(harness.render().props.disabled, false);
    complete({modelVersion: "prepared"});await harness.settle();assert.equal(saved[0][1].frameMultiplier, 3);
    picker().props.onChange({target: {value: "4"}});picker().props.onChange({target: {value: "off"}});await harness.settle();
    assert.equal(saved[1][1].frameGeneration, "off");assert.equal(picker().props.value, "off");
    complete({modelVersion: "prepared"});await harness.settle();assert.ok(saved.slice(1).every(row => row[1].frameGeneration === "off"));
  } finally {harness.close();global.window = previous;}
});
test("late LS1 setup preserves newer custom and native spatial selections", async () => {
  const previous = global.window, saved = [];let complete;
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: () => new Promise(resolve => {complete = resolve;})}}};
  const harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics: {spatialMethod: "off"}},
    status: {...status, presets: [{id: "filter:resize", label: "Resize", traits: {category: "upscaling", outputScale: {x: 2, y: 2}}}],
      graphics: {...unavailable, spatial: true, spatialMethods: ["ls1", "fsr1"]}}, running: true,
    onChange: async (...args) => saved.push(args)});
  const picker = () => elements(harness.render()).find(row => row.props.id === "game-spatial-method");
  try {
    picker().props.onChange({target: {value: "ls1"}});picker().props.onChange({target: {value: "shader:filter:resize"}});await harness.settle();
    assert.equal(saved[0][1].spatialShader.preset, "filter:resize");
    complete({modelVersion: "prepared"});await harness.settle();
    assert.equal(saved.at(-1)[1].spatialMethod, "off");assert.equal(saved.at(-1)[1].spatialShader.preset, "filter:resize");
    assert.equal(picker().props.value, "shader:filter:resize");
    picker().props.onChange({target: {value: "ls1"}});picker().props.onChange({target: {value: "fsr1"}});await harness.settle();
    complete({modelVersion: "prepared"});await harness.settle();
    assert.equal(saved.at(-1)[1].spatialMethod, "fsr1");assert.equal(saved.at(-1)[1].spatialShader, null);assert.equal(picker().props.value, "fsr1");
  } finally {harness.close();global.window = previous;}
});
test("declined optional frame models preserve a usable first neural enable and independent scaler", async () => {
  const previous = global.window, saved = [];
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: async () => null}}};
  const harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics: {spatialMethod: "fsr1"}},
    graphicsHost: "window", status: {...status, neuralAvailable: true, graphics: {...unavailable, spatial: true, spatialMethods: ["fsr1"], frameGeneration: true}}, running: true,
    onChange: async (...args) => saved.push(args)});
  try {
    const neural = elements(harness.render()).find(row => row.type?.name === "SimpleNeuralControls");
    await neural.props.onChange("/Game", {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Ready.dlssmodel", frameGeneration: "lsfg", frameMultiplier: 4});
    assert.deepEqual(saved, [["/Game", {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Ready.dlssmodel", frameGeneration: "off"}]]);
    assert.equal(elements(harness.render()).find(row => row.props.id === "game-spatial-method").props.value, "fsr1");
  } finally {harness.close();global.window = previous;}
});
test("awaited neural writes reject failed publication while ordinary spatial events stay handled", async () => {
  const failure = new Error("The graphics update was rejected."), calls = [],
    shader = {enabled: true, preset: "custom", effectPath: "/Shaders/resize.hook"};
  const harness = componentHarness(GraphicsControls, {game: {gamePath: "/Game", graphics: {spatialMethod: "off", spatialShader: shader}},
    graphicsHost: "window", status: {...status, neuralAvailable: true, graphics: {...unavailable, spatial: true, spatialMethods: ["fsr1"]}}, running: true,
    onChange: async (_path, patch) => {calls.push(patch);throw failure;}});
  try {
    const neural = elements(harness.render()).find(row => row.type?.name === "SimpleNeuralControls");
    await assert.rejects(neural.props.onChange("/Game", {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Ready.dlssmodel"}), error => error === failure);
    assert.equal(calls.length, 1);assert.notEqual(elements(harness.render()).find(row => row.type?.name === "SimpleNeuralControls").props.game.graphics.neuralMethod, "mlx-dlss");
    elements(harness.render()).find(row => row.props.id === "game-spatial-method").props.onChange({target: {value: "fsr1"}});await harness.settle();
    assert.equal(elements(harness.render()).find(row => row.props.id === "game-spatial-method").props.value, "shader:custom");
    assert.match(renderToStaticMarkup(harness.render()), /role="alert">The graphics update was rejected\./);
  } finally {harness.close();}
});
