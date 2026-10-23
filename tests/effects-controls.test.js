const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let EffectsControls, moveVideoEffect, effectChoice, effectChooserRows;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/EffectsControls.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "effects-controls.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ EffectsControls, moveVideoEffect, effectChoice, effectChooserRows } = compiled.exports);
});
const shader = { id: "film", kind: "shader", enabled: true, shader: { enabled: true, preset: "crt", parameters: { Scanlines: [100] } } };
const spatial = { id: "scale", kind: "spatial", enabled: true, method: "metalfx", settings: { spatialMultiplier: 2 } };
const temporal = { id: "motion", kind: "temporal", enabled: false, method: "metalfx", settings: {} };
const plan = { schema: 1, mode: "advanced", video: [shader, spatial, temporal] };
function render(game = {}) {
  return renderToStaticMarkup(React.createElement(EffectsControls, {
    game: { gamePath: "/Games/Example", runtimeId: "native", ...game }, running: false,
    status: { available: true, presets: [] }, children: React.createElement("div", { key: "simple" }, "Simple shader and scaling controls")
  }));
}
test("simple controls remain default and rendering starts no effects or catalog requests", () => {
  const markup = render({ reshade: { enabled: true, preset: "crt" } });
  assert.match(markup, /Simple shader and scaling controls/);assert.match(markup, /Advanced…/);
  assert.match(markup, /<section class="effectsControls" aria-label="Graphics">/);
  assert.match(markup, /<h3 class="detailSectionHeading">Graphics/);assert.doesNotMatch(markup, /Simple effects/);
  assert.doesNotMatch(markup, /Add effect|Video effects|Return to simple/);
});
test("Simple mode help uses current live capability without fetching an Advanced catalog", () => {
  const previous = global.window;
  global.window = {MacLauncher: {launcher: {getGameEffects: () => assert.fail("Simple help must not request a catalog")}}};
  try {
    for (const live of [false, true]) {
      const harness = componentHarness(EffectsControls, {game: {gamePath: "/Game"}, running: true, live, children: null});
      try {
        const markup = renderToStaticMarkup(harness.render());
        if (live) {assert.match(markup, /Supported changes can update during play\./);assert.doesNotMatch(markup, /Changes apply on the next launch\./);}
        else assert.match(markup, /Changes apply on the next launch\./);
      } finally {harness.close();}
    }
  } finally {global.window = previous;}
});
test("persisted advanced mode shows independent ordered nodes and explicit reset behavior", () => {
  const before = structuredClone(plan), markup = render({ effects: plan });
  assert.match(markup, /<h3 class="detailSectionHeading">Graphics/);assert.match(markup, /<span class="detailMeta">Advanced<\/span>/);assert.match(markup, /aria-label="Video effects"/);
  assert.match(markup, /Spatial scaling/);assert.match(markup, /Temporal upscaling/);
  assert.match(markup, /Return to simple/);assert.match(markup, /clears this chain and turns off this game/);
  assert.match(markup, /aria-label="About effects modes"/);
  assert.match(markup, /aria-label="About returning to simple"/);
  assert.doesNotMatch(markup, /<p class="detailMeta">Return to simple clears all effects\.<\/p>/);
  assert.doesNotMatch(markup, /<p class="detailMeta">Effects run from top to bottom/);
  assert.match(markup, /Move crt up[^>]*disabled/);assert.match(markup, /Move metalfx down[^>]*disabled/);
  assert.doesNotMatch(markup, /Simple shader and scaling controls/);assert.deepEqual(plan, before);
});
test("Return to simple can interrupt a pending save and ignores its late response", async t => {
  const previousWindow = global.window;
  t.after(() => {global.window = previousWindow;});
  for (const lateFailure of [false, true]) {
    const before = {...plan, video: [shader]};let finishSave, finishReset, resets = 0, reads = 0;
    global.window = {MacLauncher: {launcher: {
      getGameEffects: async () => {reads++;return {mode: "advanced", plan: before, catalog: []};},
      setGameEffects: () => new Promise((resolve, reject) => {finishSave = () => lateFailure ? reject(new Error("Superseded save")) : resolve(true);}),
      resetGameEffects: () => {resets++;return new Promise(resolve => {finishReset = resolve;});}
    }}};
    const harness = componentHarness(EffectsControls, {game: {gamePath: "/Games/Advanced", effects: before}, running: true,
      children: React.createElement("div", {key: "simple"}, "Simple controls")});
    try {
      harness.render();await harness.settle();
      const save = elements(harness.render()).find(node => node.type === "input" && node.props.type === "checkbox")
        .props.onChange({target: {checked: false}});
      const reset = elements(harness.render()).find(node => node.type === "button" && node.props.children === "Return to simple");
      assert.equal(Boolean(reset.props.disabled), false, "slow preparation must leave the full reset usable");
      const resetting = reset.props.onClick();assert.equal(resets, 1);
      finishSave();await save;
      assert.equal(elements(harness.render()).find(node => node.type === "fieldset").props.disabled, true,
        "a late predecessor cannot clear the reset's busy state");
      assert.doesNotMatch(renderToStaticMarkup(harness.render()), /role="alert"/);
      finishReset(true);await resetting;
      const markup = renderToStaticMarkup(harness.render());
      assert.match(markup, /Simple controls/);assert.doesNotMatch(markup, /Return to simple|role="alert"/);
      assert.equal(reads, 1, "the superseded save must not reload or resurrect its advanced chain");
    } finally {harness.close();}
  }
});
test("leaving an unedited Advanced preview preserves Simple settings without resetting a running game", async t => {
  const previousWindow = global.window;
  t.after(() => {global.window = previousWindow;});
  const game = {gamePath: "/Games/Simple", reshade: {enabled: true, preset: "crt"},
    graphics: {neuralMethod: "mlx-dlss", frameGeneration: "lsfg", frameMultiplier: 4}};
  const before = structuredClone(game);let resets = 0;
  global.window = {MacLauncher: {launcher: {
    getGameEffects: async () => ({mode: "simple", plan, catalog: []}),
    resetGameEffects: async () => {resets++;return true;}
  }}};
  const harness = componentHarness(EffectsControls, {game, running: true,
    children: React.createElement("div", {key: "simple"}, "Simple controls")});
  try {
    elements(harness.render()).find(node => node.type === "button" && node.props.children === "Advanced…").props.onClick();
    harness.render();await harness.settle();
    assert.match(renderToStaticMarkup(harness.render()), /Advanced preview/);
    await elements(harness.render()).find(node => node.type === "button" && node.props.children === "Return to simple").props.onClick();
    assert.match(renderToStaticMarkup(harness.render()), /Simple controls/);
    assert.equal(resets, 0);assert.deepEqual(game, before);
  } finally {harness.close();}
});
test("moving mixed backend nodes preserves each identity, settings, enabled state and parameter map", () => {
  const before = structuredClone(plan), moved = moveVideoEffect(plan, "scale", -1);
  assert.deepEqual(moved.video.map(node => node.id), ["scale", "film", "motion"]);
  assert.equal(moved.video[1], shader);assert.deepEqual(moved.video[1].shader.parameters, { Scanlines: [100] });
  assert.equal(moved.video[2].enabled, false);assert.deepEqual(plan, before);
  assert.equal(moveVideoEffect(plan, "missing", 1), plan);assert.equal(moveVideoEffect(plan, "film", -1), plan);
});
test("catalog matching keeps same-named temporal and spatial methods separate", () => {
  const catalog = [shader, spatial, temporal].map(node => ({ id: node.id, kind: node.kind, label: node.id, template: node }));
  assert.equal(effectChoice(shader, catalog).id, "film");assert.equal(effectChoice(spatial, catalog).id, "scale");
  assert.equal(effectChoice(temporal, catalog).id, "motion");
  assert.equal(effectChoice({ ...shader, shader: { enabled: true, preset: "filter:other" } }, catalog), undefined);
});
test("Advanced row model selection, removal and re-enable use the row's own mode and model", async () => {
  for (const kind of ["spatial", "frame-generation"]) {
    const method = kind === "spatial" ? "ls1" : "lsfg", good = "sha256-" + "a".repeat(64), missing = "sha256-" + "b".repeat(64);
    const required = kind === "spatial" ? "ls1Performance" : "lsfgFp32Performance";
    const settings = {modelVersion: good, ls1Mode: "performance", lsfgMode: "performance", lsfgFp16: false};
    const before = {schema: 1, mode: "advanced", video: [{id: "model", kind, method, enabled: false, settings}]};
    const catalog = [{id: `${kind}:${method}`, kind, label: method, group: "Scaling", available: false, availableWithoutModel: true,
      reason: "Compatible Lossless Scaling models are required.", template: {kind, method, enabled: true, settings: {}}}];
    const status = {available: true, presets: [], models: [{version: good, label: "Performance model", capabilities: [required]}], defaultModelVersion: missing};
    const changes = [], harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: before, graphics: {modelVersion: missing}},
      running: false, status, children: null, editor: {info: {mode: "advanced", plan: before, catalog}, onChange: next => changes.push(next)}});
    const enable = () => elements(harness.render()).find(node => node.type === "input" && node.props["aria-label"] === `Enable ${method}`);
    const modelSelect = () => {
      const component = elements(harness.render()).find(node => node.props.node?.id === "model" && node.props.onSpatialSizeChange);
      return elements(component.type(component.props)).find(node => node.props.id === "effect-model-models");
    };
    try {
      assert.equal(enable().props.disabled, false, "a compatible Performance row is usable even when the Add Quality default is unavailable");
      assert.doesNotMatch(renderToStaticMarkup(harness.render()), /Compatible Lossless Scaling models are required/);
      modelSelect().props.onChange({target: {value: missing}});await harness.settle();
      assert.equal(enable().props.disabled, true);assert.equal(modelSelect().props.value, missing);
      assert.match(renderToStaticMarkup(harness.render()), /Unavailable model/);
      modelSelect().props.onChange({target: {value: good}});await harness.settle();
      assert.equal(enable().props.disabled, false);
      status.models = [];harness.render();assert.equal(enable().props.disabled, true, "removing the row's model prevents re-enabling it");
      status.models = [{version: good, label: "Performance model", capabilities: [required]}];
      assert.equal(enable().props.disabled, false);
      enable().props.onChange({target: {checked: true}});await harness.settle();
      assert.equal(changes.at(-1).video[0].enabled, true);assert.equal(changes.at(-1).video[0].settings.modelVersion, good);
      catalog[0] = {...catalog[0], availableWithoutModel: false, reason: "This method is unavailable for the current graphics runtime."};
      const unavailable = effectChoice({...before.video[0]}, catalog, status);
      assert.equal(unavailable.available, false, "a compatible model cannot override missing runtime support");
    } finally {harness.close();}
  }
});
test("Advanced families stay compact while searches reveal specific filters", () => {
  const row = (method, category, group = "Upscaling") => ({ id: `spatial:${method}`, kind: "spatial", label: method, group, category,
    available: true, template: { kind: "spatial", enabled: true, method, settings: {} } });
  const catalog = [row("bilinear", "Standard filters"), row("bicubic", "Standard filters"), row("nearest", "Standard filters"),
    row("mako", "Standard filters"), row("metalfx", "MetalFX"), row("ls1", "Lossless Scaling"), row("downsample", "Standard filters", "Downscaling")];
  const compact = effectChooserRows(catalog, "");
  assert.deepEqual(compact.map(row => row.label), ["Standard filters", "metalfx", "ls1", "downsample"]);
  assert.equal(compact[0].template.method, "bilinear");
  assert.deepEqual(effectChooserRows(catalog, "bicubic").map(row => row.id), ["spatial:bicubic"]);
  assert.equal(effectChooserRows(catalog, "standard filters").length, 5);
  assert.equal(effectChooserRows(catalog, "unknown").length, 0);
});
test("Advanced retains canonical traditional filters and saved alias IDs without raw alias duplicates", () => {
  const methods = ["bilinear", "libplacebo:bilinear", "libplacebo:triangle", "libplacebo:ewa_hann", "libplacebo:ewa_hanning", "libplacebo:lanczos", "libplacebo:hermite"];
  const catalog = methods.map(method => ({id: "spatial:" + method, kind: "spatial", group: "Upscaling", category: "Standard filters",
    label: method.replace(/^libplacebo:/, ""), available: true, template: {kind: "spatial", method, enabled: true, settings: {}}}));
  const choices = effectChooserRows(catalog, "standard filters");
  assert.equal(choices.length, 5);
  assert.ok(choices.some(row => row.id === "spatial:bilinear") && choices.some(row => row.id === "spatial:libplacebo:bilinear"),
    "different implementation IDs are not merged");
  assert.ok(choices.some(row => row.label === "EWA Hann · libplacebo"));
  assert.ok(!choices.some(row => /triangle|ewa_hanning/.test(row.id)));
  const before = {schema: 1, mode: "advanced", video: [{id: "filter", kind: "spatial", enabled: true, method: "libplacebo:ewa_hanning", settings: {}}]};
  const harness = componentHarness(EffectsControls, {game: {gamePath: "/Game", effects: before}, running: false, children: null,
    editor: {info: {mode: "advanced", plan: before, catalog}, onChange: () => assert.fail("render does not save")}});
  try {
    const markup = renderToStaticMarkup(harness.render()), menu = markup.match(/<select id="effect-choice-filter"[\s\S]*?<\/select>/)[0];
    assert.match(menu, /optgroup label="Standard filters"/);
    assert.match(menu, /value="spatial:libplacebo:ewa_hanning" selected="">EWA Hann/);
    assert.doesNotMatch(menu, /value="spatial:libplacebo:ewa_hann"|value="spatial:libplacebo:triangle"/);
    assert.match(menu, /value="spatial:libplacebo:hermite">Hermite/);
    assert.match(menu, /value="spatial:libplacebo:bilinear">Bilinear · libplacebo/);
    assert.match(markup, /aria-label="Enable EWA Hann · libplacebo"/);
    assert.equal(before.video[0].method, "libplacebo:ewa_hanning");
  } finally {harness.close();}
});
test("Advanced spatial sizes are independent of game allocation capabilities", () => {
  const markup = render({ effects: { ...plan, renderResolution: { height: 480 }, video: [{ ...spatial,
    outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: null } }] } });
  assert.match(markup, /Game rendering /);assert.match(markup, /480p · Unavailable/);
  assert.match(markup, /Output size /);assert.match(markup, /Auto · Presentation size/);
  assert.match(markup, /÷4 · Previous stage/);assert.match(markup, /4× · Previous stage/);
  assert.match(markup, /optgroup label="Window size"/);assert.match(markup, /value="window:0.5">÷2 · Window size/);
  assert.match(markup, /value="window:4">4× · Window size/);
  assert.match(markup, /id="effect-scale-output-width"[^>]*value="854"/);
  assert.match(markup, /id="effect-scale-output-height"[^>]*value="480"/);
  assert.doesNotMatch(markup, /Render resolution/);
});
test("an unavailable saved Advanced source request can reset to Auto without removing effects", async () => {
  const before = {...plan, renderResolution: {height: 480, method: "metalfx"}}, changes = [];
  const harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: before}, running: false, children: null,
    editor: {info: {mode: "advanced", plan: before, catalog: [], sourceResolution: {heights: false, multipliers: []}}, onChange: next => changes.push(next)}});
  try {
    const selector = elements(harness.render()).find(node => node.props.id === "effects-game-rendering");
    assert.ok(selector);assert.match(renderToStaticMarkup(selector), /480p · Unavailable/);
    await selector.props.onChange({target: {value: "auto"}});
    assert.equal(changes[0].renderResolution, undefined);assert.deepEqual(changes[0].video, before.video);
  } finally {harness.close();}
});
test("Advanced neural intensity exposes the useful blend range with full model output selected by default", () => {
  const markup = render({ effects: { ...plan, video: [{ id: "neural", kind: "neural", enabled: true, method: "mlx-dlss",
    settings: { modelPath: "/Models/Test.dlssmodel", intensity: 1, temporal: false } }] } });
  assert.match(markup, /id="effect-neural-intensity"[^>]*max="1"[^>]*value="1"/);
  assert.match(markup, /uses full model output; lower values blend the reconstruction with the input/);
});
test("draft editor honors source-resolution capabilities and edits without per-game API calls", async () => {
  const before = { ...plan, video: [] }, changes = [], info = { mode: "advanced", plan: before, catalog: [],
    sourceResolution: { heights: false, multipliers: [] } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "preset", runtimeId: "native", effects: before },
    running: false, children: null, editor: { info, onChange: value => changes.push(value), pickFile: async () => null } });
  try {
    harness.render();await harness.settle();assert.doesNotMatch(renderToStaticMarkup(harness.render()), /Game rendering|Return to simple/);
    info.sourceResolution = { heights: false, multipliers: [1, 2] };
    const selector = elements(harness.render()).find(node => node.props.id === "effects-game-rendering");
    const markup = renderToStaticMarkup(selector);assert.match(markup, /÷2 · Each dimension/);assert.doesNotMatch(markup, /480p|720p|÷3|÷1.5/);
    await selector.props.onChange({ target: { value: "multiplier:2" } });
    assert.deepEqual(changes[0].renderResolution, { multiplier: 2 });assert.deepEqual(before.video, []);
  } finally { harness.close(); }
});
test("Advanced source filters follow declared methods, preserve sizing and keep the original method available with temporal stages", async () => {
  const before = { schema: 1, mode: "advanced", video: [] }, changes = [];
  const sourceResolution = { heights: true, multipliers: [1, 2], methods: ["bilinear", "metalfx", "fsr1"],
    methodLabels: { bilinear: "Bilinear", metalfx: "Native MetalFX", fsr1: "FSR 1" } };
  const props = { game: { gamePath: "preset", effects: before }, running: false, children: null,
    editor: { info: { mode: "advanced", plan: before, catalog: [], sourceResolution }, onChange: value => changes.push(value) } };
  const harness = componentHarness(EffectsControls, props);
  try {
    assert.doesNotMatch(renderToStaticMarkup(harness.render()), /effects-source-filter/);
    await elements(harness.render()).find(node => node.props.id === "effects-game-rendering").props.onChange({ target: { value: "multiplier:2" } });
    let selector = elements(harness.render()).find(node => node.props.id === "effects-source-filter");
    assert.match(renderToStaticMarkup(selector), /value="metalfx">Native MetalFX/);
    await selector.props.onChange({ target: { value: "metalfx" } });
    assert.deepEqual(changes.at(-1).renderResolution, { multiplier: 2, method: "metalfx" });
    await elements(harness.render()).find(node => node.props.id === "effects-game-rendering").props.onChange({ target: { value: "height:720" } });
    assert.deepEqual(changes.at(-1).renderResolution, { height: 720, method: "metalfx" });
    selector = elements(harness.render()).find(node => node.props.id === "effects-source-filter");
    await selector.props.onChange({ target: { value: "" } });
    assert.deepEqual(changes.at(-1).renderResolution, { height: 720 });
    await elements(harness.render()).find(node => node.props.id === "effects-game-rendering").props.onChange({ target: { value: "auto" } });
    assert.doesNotMatch(renderToStaticMarkup(harness.render()), /effects-source-filter/);
    assert.deepEqual(before.video, []);
  } finally { harness.close(); }
  const temporalPlan = { ...before, renderResolution: { multiplier: 2 }, video: [{ ...temporal, enabled: true }] };
  const conflicting = componentHarness(EffectsControls, { ...props, game: { gamePath: "preset", effects: temporalPlan },
    editor: { ...props.editor, info: { ...props.editor.info, plan: temporalPlan } } });
  try {
    const selector = elements(conflicting.render()).find(node => node.props.id === "effects-source-filter");
    const markup = renderToStaticMarkup(selector);
    assert.match(markup, /value="" selected="">Game original/);
    for (const method of sourceResolution.methods) assert.match(markup, new RegExp(`value="${method}" disabled=""`));
  } finally { conflicting.close(); }
});
test("video live controls distinguish native shader bindings from shared live settings", async () => {
  const previousWindow = global.window, before = { ...plan, video: [] };
  global.window = { MacLauncher: { launcher: { getGameEffects: async () => ({ mode: "advanced", plan: before, catalog: [], live: true,
    shaderBindingsNextLaunch: true, sourceResolution: { heights: false, multipliers: [] } }) } } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "/Video/clip.mp4", runtimeId: "mpv", effects: before }, running: true, children: null });
  try {
    harness.render();await harness.settle();
    assert.match(renderToStaticMarkup(harness.render()), /Video shader selections apply on the next launch; other supported changes update during play\./);
  } finally { harness.close();global.window = previousWindow; }
});
function elements(element) {
  return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements)] : [];
}
test("changing a Downsample filter keeps its dimensions and uses grouped method menus", async () => {
  const before = { ...plan, video: [{ ...spatial, method: "downsample", outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: 0.5 } }] };
  const catalog = [{ id: "spatial:downsample", kind: "spatial", label: "Downsample", group: "Downscaling", category: "Standard filters", available: true,
    template: { kind: "spatial", method: "downsample", enabled: true, settings: { spatialMultiplier: 0.5 } } },
  { id: "spatial:nearest", kind: "spatial", label: "Nearest neighbour", group: "Upscaling", category: "Standard filters", available: true,
    template: { kind: "spatial", method: "nearest", enabled: true, settings: { spatialMultiplier: null } } },
  { id: "spatial:metalfx", kind: "spatial", label: "MetalFX Spatial", group: "Upscaling", category: "MetalFX", available: true,
    template: { kind: "spatial", method: "metalfx", enabled: true, settings: {} } }];
  const previousWindow = global.window;let stored = before;
  global.window = { MacLauncher: { launcher: { getGameEffects: async () => ({ mode: "advanced", plan: stored, catalog }),
    setGameEffects: async (_path, value) => { stored = value;return true; } } } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "/Games/Advanced", effects: before }, running: false, children: null });
  try {
    harness.render();await harness.settle();
    const markup = renderToStaticMarkup(harness.render());assert.match(markup, /optgroup label="Standard filters"/);assert.match(markup, /optgroup label="MetalFX"/);
    const selector = elements(harness.render()).find(node => node.props.id === "effect-choice-scale");
    await selector.props.onChange({ target: { value: "spatial:nearest" } });
    assert.equal(stored.video[0].method, "nearest");assert.equal(stored.video[0].settings.spatialMultiplier, 0.5);
    assert.deepEqual(stored.video[0].outputSize, { width: 854, height: 480 });assert.equal(before.video[0].method, "downsample");
  } finally { harness.close();global.window = previousWindow; }
});
test("a migrated aspect-preserving cap keeps its height and requires both dimensions before changing filters", async () => {
  const before = { ...plan, video: [{ ...spatial, method: "downsample", outputSize: { height: 480 }, settings: { spatialMultiplier: null } }] };
  const catalog = [{ id: "spatial:downsample", kind: "spatial", label: "Downsample", group: "Downscaling", available: true,
    template: { kind: "spatial", method: "downsample", enabled: true, settings: {} } },
    { id: "spatial:bicubic", kind: "spatial", label: "Bicubic", group: "Upscaling", available: true,
      template: { kind: "spatial", method: "bicubic", enabled: true, settings: {} } }];
  const harness = componentHarness(EffectsControls, { game: { gamePath: "preset", runtimeId: "native", effects: before }, running: false, children: null,
    editor: { info: { mode: "advanced", plan: before, catalog }, onChange: () => assert.fail("Rendering must preserve the migrated cap") } });
  try {
    const markup = renderToStaticMarkup(harness.render());assert.match(markup, /value="spatial:bicubic" disabled="" title="Set both output dimensions to use another filter\."/);
    assert.match(markup, /id="effect-scale-output-height"[^>]*value="480"/);assert.match(markup, /single dimension limits size while preserving aspect ratio/);assert.doesNotMatch(markup, /value="undefined"/);assert.deepEqual(before.video[0].outputSize, { height: 480 });
  } finally { harness.close(); }
});
test("custom Downsample accepts either size limit while other filters require both dimensions", async () => {
  for (const [method, width, height, expected] of [
    ["downsample", "", "480", {height: 480}], ["downsample", "854", "", {width: 854}],
    ["downsample", "854", "480", {width: 854, height: 480}], ["downsample", "0", "480", null],
    ["downsample", "", "", null], ["bilinear", "", "480", null], ["bilinear", "854", "480", {width: 854, height: 480}]
  ]) {
    const before = {...plan, video: [{...spatial, method, settings: {spatialMultiplier: .5}}]}, changes = [];
    const harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: before}, running: false, children: null,
      editor: {info: {mode: "advanced", plan: before, catalog: []}, onChange: next => changes.push(next)}});
    let sizing;
    try {
      const graphics = elements(harness.render()).find(node => typeof node.props.onSpatialSizeChange === "function");
      const child = elements(graphics.type(graphics.props)).find(node => node.props.nodeId === "scale");
      sizing = componentHarness(child.type, child.props);
      elements(sizing.render()).find(node => node.props.id === "effect-scale-output-size").props.onChange({target: {value: "custom"}});
      for (const [axis, value] of [["width", width], ["height", height]])
        elements(sizing.render()).find(node => node.props.id === `effect-scale-output-${axis}`).props.onChange({target: {value}});
      elements(sizing.render()).find(node => node.props.id === "effect-scale-output-height").props.onBlur();
      await harness.settle();
      if (expected) {
        assert.deepEqual(changes.at(-1)?.video[0].outputSize, expected, `${method}: ${width}×${height}`);
        assert.equal(changes.at(-1).video[0].settings.spatialMultiplier, null);
      } else assert.equal(changes.length, 0, `${method}: invalid or incomplete size must not replace the saved factor`);
      assert.equal(before.video[0].outputSize, undefined);
    } finally {sizing?.close();harness.close();}
  }
});
test("window-relative sizing replaces fixed pixels and stage factors explicitly, and survives filter changes", async () => {
  const before = { ...plan, video: [{ ...spatial, outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: null } }] };
  const catalog = ["metalfx", "bicubic", "downsample"].map(method => ({ id: `spatial:${method}`, kind: "spatial", label: method, available: true,
    template: { kind: "spatial", method, enabled: true, settings: {} } }));
  const changes = [], harness = componentHarness(EffectsControls, { game: { gamePath: "preset", effects: before }, running: false, children: null,
    editor: { info: { mode: "advanced", plan: before, catalog }, onChange: value => changes.push(value) } });
  function sizeEditor() {
    const graphics = elements(harness.render()).find(node => typeof node.props.onSpatialSizeChange === "function");
    const child = elements(graphics.type(graphics.props)).find(node => node.props.nodeId === "scale");
    return componentHarness(child.type, child.props);
  }
  try {
    let sizing = sizeEditor();
    try { elements(sizing.render()).find(node => node.props.id === "effect-scale-output-size").props.onChange({ target: { value: "window:0.5" } }); }
    finally { sizing.close(); }
    assert.equal(changes.at(-1).video[0].presentationScale, 0.5);assert.equal(changes.at(-1).video[0].outputSize, undefined);
    assert.equal(changes.at(-1).video[0].settings.spatialMultiplier, null);
    await elements(harness.render()).find(node => node.props.id === "effect-choice-scale").props.onChange({ target: { value: "spatial:bicubic" } });
    assert.equal(changes.at(-1).video[0].method, "bicubic");assert.equal(changes.at(-1).video[0].presentationScale, 0.5);
    sizing = sizeEditor();
    try { elements(sizing.render()).find(node => node.props.id === "effect-scale-output-size").props.onChange({ target: { value: "2" } }); }
    finally { sizing.close(); }
    assert.equal(changes.at(-1).video[0].presentationScale, undefined);assert.equal(changes.at(-1).video[0].settings.spatialMultiplier, 2);
    sizing = sizeEditor();
    try { elements(sizing.render()).find(node => node.props.id === "effect-scale-output-size").props.onChange({ target: { value: "window:2" } }); }
    finally { sizing.close(); }
    assert.match(renderToStaticMarkup(harness.render()), /value="spatial:downsample" disabled="" title="Choose a window size of 100% or less to use Downsample\."/);
    assert.deepEqual(before.video[0].outputSize, { width: 854, height: 480 });
  } finally { harness.close(); }
});
test("Advanced Custom shader selection and replacement pick before a single atomic plan save", async () => {
  const before = { ...plan, video: [{ ...shader, enabled: false, shader: { enabled: true, preset: "filter:existing", parameters: { Strength: [0.4] } } }, spatial] };
  const original = structuredClone(before), saved = [], picked = [];
  const custom = { id: "shader:custom", kind: "shader", label: "Custom shader…", group: "Shaders", available: true,
    template: { kind: "shader", enabled: true, shader: { enabled: true, preset: "custom", effectPath: null } } };
  const catalog = [custom, { id: "shader:existing", kind: "shader", label: "Imported shader", available: true, template: before.video[0] }];
  const previousWindow = global.window;
  let stored = before, complete;
  global.window = { MacLauncher: { launcher: {
    getGameEffects: async () => ({ mode: "advanced", plan: stored, catalog }),
    setGameEffects: async (path, value) => { saved.push([path, value]);stored = value;return true; },
    pickGameEffectFile: path => { picked.push(path);return new Promise(resolve => { complete = resolve; }); },
    pickGameReShadeEffect: () => assert.fail("Advanced must not update Simple settings")
  } } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "/Games/Advanced", effects: before }, running: false, children: null });
  const selector = () => elements(harness.render()).find(node => node.props.id === "effect-choice-film");
  try {
    harness.render();await harness.settle();
    let pending = selector().props.onChange({ target: { value: custom.id } });
    assert.equal(elements(harness.render()).find(node => node.type === "fieldset").props.disabled, true);
    assert.equal(selector().props.value, "shader:existing");assert.deepEqual(saved, []);
    complete(null);await pending;assert.deepEqual(saved, []);assert.equal(selector().props.value, "shader:existing");
    pending = selector().props.onChange({ target: { value: custom.id } });
    complete("/Shaders/First.hook");await pending;
    assert.equal(saved.length, 1);assert.equal(saved[0][0], "/Games/Advanced");
    assert.deepEqual(saved[0][1].video.map(node => node.id), ["film", "scale"]);
    assert.equal(saved[0][1].video[0].enabled, false);
    assert.equal(saved[0][1].video[0].shader.preset, "custom");
    assert.equal(saved[0][1].video[0].shader.effectPath, "/Shaders/First.hook");
    assert.equal(saved[0][1].video[0].shader.parameters, null);assert.deepEqual(before, original);
    const choose = () => elements(harness.render()).find(node => node.type === "button" && node.props.children === "Choose shader…");
    pending = choose().props.onClick();complete("/Shaders/Replacement.fx");await pending;
    assert.equal(saved.length, 2);assert.equal(saved[1][1].video[0].shader.effectPath, "/Shaders/Replacement.fx");
    assert.equal(saved[1][1].video[0].shader.parameters, null);
    pending = choose().props.onClick();complete(null);await pending;assert.equal(saved.length, 2);
    global.window.MacLauncher.launcher.pickGameEffectFile = async () => { throw new Error("The preset cannot be opened."); };
    await choose().props.onClick();
    assert.match(renderToStaticMarkup(harness.render()), /role="alert">The preset cannot be opened\./);
    assert.equal(saved.length, 2);assert.equal(stored.video[0].shader.effectPath, "/Shaders/Replacement.fx");
    assert.deepEqual(picked, Array(4).fill("/Games/Advanced"));
  } finally { harness.close();global.window = previousWindow; }
});
