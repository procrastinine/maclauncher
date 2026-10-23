const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite"), { react, componentHarness } = require("./helpers/renderer-component");
let SimpleNeuralControls;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: { ssr: path.join(__dirname, "../src/renderer/src/ui/components/SimpleNeuralControls.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, "simple-neural-ui.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id);
  ({ SimpleNeuralControls } = compiled.exports);
});
function elements(value) { return React.isValidElement(value) ? [value, ...React.Children.toArray(value.props.children).flatMap(elements)] : []; }
test("neural live capability help distinguishes an unbound running process without claiming execution", () => {
  const props = {game: {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss"}}, available: true,
    nativeVideo: false, running: true, onChange: () => assert.fail("help must not save")};
  const render = live => renderToStaticMarkup(React.createElement(SimpleNeuralControls, {...props, live}));
  assert.match(render(false), /Changes apply on the next launch\./);
  assert.doesNotMatch(render(false), /settings and managed model selections update during play|Supported processing changes can update during play/);
  assert.match(render(true), /Supported processing changes can update during play/);
  assert.match(render(true), /Provider and model bindings may require a restart/);
  assert.doesNotMatch(render(true), /effect is running|reconstruction is active/);
});
test("Simple neural opt-in selects a local model and manages proportional game sizing without reducing video by default", async () => {
  const previous = global.window;
  const saved = [], modelPath = "/Models/Test.dlssmodel", props = { game: { gamePath: "/Game" }, available: true, nativeVideo: false, running: false,
    status: { neuralModels: [{ version: "one", versionLabel: "Local model", modelPath }] }, onChange: async (...args) => saved.push(args) };
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: async () => ({modelPath})}}};
  const harness = componentHarness(SimpleNeuralControls, props);
  try {
    const tree = harness.render(), markup = renderToStaticMarkup(tree);assert.match(markup, /DLSS 5 · Experimental/);assert.match(markup, /MLX-DLSS/);assert.match(markup, /DLSSMac/);assert.doesNotMatch(markup, /checked=""/);
    assert.match(markup, /<h4 class="detailSectionHeading">Neural reconstruction/);assert.doesNotMatch(markup, /<legend>|Experimental neural rendering/);
    await elements(tree).find(row => row.type === "input").props.onChange({ target: { checked: true } });await harness.settle();
    assert.deepEqual(saved[0], ["/Game", { neuralMethod: "mlx-dlss", neuralModelPath: modelPath, neuralInputScale: null, neuralInputHeight: null }]);
    const video = componentHarness(SimpleNeuralControls, { ...props, nativeVideo: true });
    try { await elements(video.render()).find(row => row.type === "input").props.onChange({ target: { checked: true } });await video.settle();assert.equal(saved[1][1].neuralInputScale, 1);assert.equal(saved[1][1].neuralInputHeight, null); }
    finally { video.close(); }
    const configured = componentHarness(SimpleNeuralControls, { ...props, game: { gamePath: "/Game", graphics: { neuralMethod: "off", neuralModelPath: modelPath, neuralInputScale: 0.25, neuralInputHeight: 480 } } });
    try { await elements(configured.render()).find(row => row.type === "input").props.onChange({ target: { checked: true } });await configured.settle();assert.equal(saved[2][1].neuralInputScale, 0.25);assert.equal(saved[2][1].neuralInputHeight, null); }
    finally { configured.close(); }
  } finally { harness.close();global.window = previous; }
});
test("saved explicit neural scales expose a compact action to adopt Auto", async () => {
  const saved = [], harness = componentHarness(SimpleNeuralControls, {game: {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss", neuralInputScale: .5}},
    available: true, nativeVideo: false, running: false, onChange: async (...args) => saved.push(args)});
  try {
    const tree = harness.render();assert.match(renderToStaticMarkup(tree), /Existing saved scales remain explicit/);
    await elements(tree).find(row => row.type === "button" && row.props.children === "Use Auto").props.onClick();await harness.settle();
    assert.deepEqual(saved, [["/Game", {neuralInputScale: null, neuralInputHeight: null}]]);
  } finally {harness.close();}
});
test("canceling the model picker preserves settings and Simple shows automatic sizing without fixed-height controls", async () => {
  const previous = global.window, saved = [];global.window = { MacLauncher: { launcher: { ensureGameGraphicsModel: async () => null, pickGameEffectFile: async () => null } } };
  const props = { game: { gamePath: "/Game" }, available: true, nativeVideo: false, running: false, onChange: async (...args) => saved.push(args) };
  const harness = componentHarness(SimpleNeuralControls, props);
  try {
    await elements(harness.render()).find(row => row.type === "input").props.onChange({ target: { checked: true } });await harness.settle();assert.deepEqual(saved, []);
    const active = renderToStaticMarkup(React.createElement(SimpleNeuralControls, { ...props, game: { gamePath: "/Game", graphics: { neuralMethod: "mlx-dlss", neuralInputHeight: 480, neuralModelPath: "/Models/Test.dlssmodel" } } }));
    assert.match(active, /Auto uses the current physical output size/);assert.doesNotMatch(active, /480p|Process at up to|Auto · Adapts|>File<|>Test\.dlssmodel</);assert.match(active, /<summary>Options<\/summary>/);assert.match(active, /Manage models…/);
    assert.match(active, /id="simple-neural-intensity"[^>]*max="1"[^>]*value="1"/);
    assert.equal(renderToStaticMarkup(React.createElement(SimpleNeuralControls, { ...props, available: false })), "");
  } finally { harness.close();global.window = previous; }
});
test("Simple neural setup is consented, pending once and independent of scaler, shader and frame generation", async () => {
  const previous = global.window, saved = [], requests = [], busy = [];let finish;
  global.window = { MacLauncher: { launcher: { ensureGameGraphicsModel: (...args) => {
    requests.push(args);return new Promise(resolve => {finish = resolve;});
  } } } };
  const game = {gamePath: "/Game", graphics: {spatialMethod: "fsr1", frameGeneration: "lsfg", frameMultiplier: 4}};
  const harness = componentHarness(SimpleNeuralControls, {game, available: true, nativeVideo: false, running: true,
    onBusyChange: value => busy.push(value), onChange: async (...args) => saved.push(args)});
  try {
    const checkbox = () => elements(harness.render()).find(row => row.type === "input");
    checkbox().props.onChange({target: {checked: true}});checkbox().props.onChange({target: {checked: true}});
    assert.equal(requests.length, 1);assert.deepEqual(saved, []);
    assert.doesNotMatch(renderToStaticMarkup(harness.render()), /fieldset[^>]*disabled=""/);
    assert.match(renderToStaticMarkup(harness.render()), /aria-busy="true"/);
    assert.deepEqual(requests[0], ["/Game", "neural", {neuralMethod: "mlx-dlss", neuralInputScale: null, neuralInputHeight: null}]);
    finish({modelPath: "/Models/Prepared.dlssmodel"});await harness.settle();
    assert.deepEqual(saved, [["/Game", {...requests[0][2], neuralModelPath: "/Models/Prepared.dlssmodel"}]]);
    assert.deepEqual(busy, [true, false]);assert.equal(game.graphics.spatialMethod, "fsr1");assert.equal(game.graphics.frameMultiplier, 4);
    global.window.MacLauncher.launcher.ensureGameGraphicsModel = async () => {throw new Error("Model download was interrupted.");};
    checkbox().props.onChange({target: {checked: true}});await harness.settle();
    assert.equal(saved.length, 1);assert.match(renderToStaticMarkup(harness.render()), /role="alert">Model download was interrupted\./);
  } finally {harness.close();global.window = previous;}
});
test("enabling neural reconstruction delegates saved and catalog model choices to verified setup", async () => {
  const previous = global.window, requests = [], saved = [];
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: async (...args) => {
    requests.push(args);return {modelPath: "/Models/Verified-default.dlssmodel"};
  }}}};
  const harness = componentHarness(SimpleNeuralControls, {game: {gamePath: "/Game", graphics: {neuralModelPath: "/Missing/Old.dlssmodel"}},
    status: {neuralModels: [{version: "first", modelPath: "/Models/First-not-default.dlssmodel"}]}, available: true, nativeVideo: false, running: false,
    onChange: async (...args) => saved.push(args)});
  try {
    elements(harness.render()).find(row => row.type === "input").props.onChange({target: {checked: true}});await harness.settle();
    assert.equal(requests.length, 1);assert.equal(saved[0][1].neuralModelPath, "/Models/Verified-default.dlssmodel");
  } finally {harness.close();global.window = previous;}
});
test("neural intensity dragging keeps the latest draft and coalesces pending values without disabling controls", async () => {
  const calls = [], waiting = [], busy = [], game = {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss", neuralIntensity: 0.5}};
  const harness = componentHarness(SimpleNeuralControls, {game, available: true, nativeVideo: false, running: true,
    onBusyChange: value => busy.push(value), onChange: (...args) => {calls.push(args);return new Promise(resolve => waiting.push(resolve));}});
  const slider = () => elements(harness.render()).find(row => row.props.id === "simple-neural-intensity");
  try {
    slider().props.onChange({target: {value: "0.2"}});slider().props.onChange({target: {value: "0.4"}});slider().props.onChange({target: {value: "0.8"}});
    assert.equal(calls.length, 1);assert.equal(slider().props.value, 0.8);
    assert.equal(elements(harness.render()).find(row => row.type === "fieldset").props.disabled, false);assert.deepEqual(busy, []);
    waiting.shift()();await harness.settle();assert.deepEqual(calls, [["/Game", {neuralIntensity: 0.2}], ["/Game", {neuralIntensity: 0.8}]]);
    waiting.shift()();await harness.settle();assert.equal(slider().props.value, 0.8);assert.equal(game.graphics.neuralIntensity, 0.5);
  } finally {harness.close();}
});
test("failed queued neural edits restore the last accepted value and preserve independent pending scalar changes", async () => {
  const calls = [], waiting = [], game = {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss", neuralIntensity: 0.5, neuralTemporal: false}};
  const harness = componentHarness(SimpleNeuralControls, {game, available: true, nativeVideo: false, running: true,
    onChange: (...args) => {calls.push(args);return new Promise((resolve, reject) => waiting.push({resolve, reject}));}});
  const slider = () => elements(harness.render()).find(row => row.props.id === "simple-neural-intensity");
  const temporal = () => elements(harness.render()).find(row => row.type === "input" && row.props.type === "checkbox" && row.props.checked === false);
  try {
    slider().props.onChange({target: {value: "0.2"}});slider().props.onChange({target: {value: "0.8"}});
    temporal().props.onChange({target: {checked: true}});waiting.shift().resolve();await harness.settle();
    assert.deepEqual(calls[1], ["/Game", {neuralIntensity: 0.8, neuralTemporal: true}]);assert.equal(slider().props.value, 0.8);
    waiting.shift().reject(new Error("The selected processing settings were rejected."));await harness.settle();
    assert.equal(slider().props.value, 0.2);assert.ok(temporal());assert.match(renderToStaticMarkup(harness.render()), /role="alert">The selected processing settings were rejected/);
  } finally {harness.close();}
});
test("model acquisition stays exclusive and waits for accepted scalar edits", async () => {
  const previous = global.window, calls = [], waiting = [];let picks = 0;
  global.window = {MacLauncher: {launcher: {pickGameEffectFile: async () => {picks++;return null;}}}};
  const harness = componentHarness(SimpleNeuralControls, {game: {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss", neuralIntensity: 1}},
    available: true, nativeVideo: false, running: true, onChange: (...args) => {calls.push(args);return new Promise(resolve => waiting.push(resolve));}});
  try {
    const slider = elements(harness.render()).find(row => row.props.id === "simple-neural-intensity");
    slider.props.onChange({target: {value: "0.4"}});
    const choose = () => elements(harness.render()).find(row => row.type === "button" && row.props.children === "Choose model…");
    choose().props.onClick();choose().props.onClick();assert.equal(picks, 0);
    assert.equal(elements(harness.render()).find(row => row.type === "fieldset").props.disabled, false);
    waiting.shift()();await harness.settle();assert.equal(picks, 1);assert.equal(calls.length, 1);
    assert.equal(elements(harness.render()).find(row => row.type === "fieldset").props.disabled, false);
  } finally {harness.close();global.window = previous;}
});
test("neural Off bypasses pending setup and a late model result cannot enable it again", async () => {
  const previous = global.window, saved = [];let finish;
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: () => new Promise(resolve => {finish = resolve;})}}};
  const harness = componentHarness(SimpleNeuralControls, {game: {gamePath: "/Game"}, available: true, nativeVideo: false, running: true,
    defaultFrameGeneration: true, onChange: async (...args) => saved.push(args)});
  const toggle = () => elements(harness.render()).find(row => row.type === "input" && row.props.type === "checkbox");
  try {
    toggle().props.onChange({target: {checked: true}});assert.equal(toggle().props.checked, true);
    assert.equal(elements(harness.render()).find(row => row.type === "fieldset").props.disabled, false);
    toggle().props.onChange({target: {checked: false}});await harness.settle();
    assert.deepEqual(saved, [["/Game", {neuralMethod: "off"}]]);assert.equal(toggle().props.checked, false);
    finish({modelPath: "/Models/Late.dlssmodel"});await harness.settle();assert.equal(saved.length, 1);assert.equal(toggle().props.checked, false);
  } finally {harness.close();global.window = previous;}
});
test("neural Off is immediate during parameter publication and initial FG suggestion is not reapplied", async () => {
  const previous = global.window, saved = [], waiting = [];
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: async () => ({modelPath: "/Models/Ready.dlssmodel"})}}};
  const harness = componentHarness(SimpleNeuralControls, {game: {gamePath: "/Game"}, available: true, nativeVideo: false, running: true,
    defaultFrameGeneration: true, onChange: (...args) => {saved.push(args);if (args[1].neuralIntensity !== undefined) return new Promise(resolve => waiting.push(resolve));return Promise.resolve();}});
  const toggle = () => elements(harness.render()).find(row => row.type === "input" && row.props.type === "checkbox");
  try {
    toggle().props.onChange({target: {checked: true}});await harness.settle();assert.equal(saved[0][1].frameGeneration, "lsfg");assert.equal(saved[0][1].frameMultiplier, 4);
    elements(harness.render()).find(row => row.props.id === "simple-neural-intensity").props.onChange({target: {value: ".6"}});
    toggle().props.onChange({target: {checked: false}});await harness.settle();assert.equal(saved.at(-1)[1].neuralMethod, "off");
    waiting.shift()();await harness.settle();toggle().props.onChange({target: {checked: true}});await harness.settle();
    assert.equal(saved.at(-1)[1].neuralMethod, "mlx-dlss");assert.equal(saved.at(-1)[1].frameGeneration, undefined);
  } finally {harness.close();global.window = previous;}
});
test("an explicit frame choice during first neural setup supersedes its initial suggestion", async () => {
  const previous = global.window, saved = [];let finish;
  global.window = {MacLauncher: {launcher: {ensureGameGraphicsModel: () => new Promise(resolve => {finish = resolve;})}}};
  const props = {game: {gamePath: "/Game", graphics: {frameGeneration: "off"}}, available: true, nativeVideo: false, running: true,
    defaultFrameGeneration: true, frameSelectionRevision: 0, onChange: async (...args) => saved.push(args)};
  const harness = componentHarness(SimpleNeuralControls, props);
  try {
    elements(harness.render()).find(row => row.type === "input").props.onChange({target: {checked: true}});
    props.frameSelectionRevision = 1;harness.render();
    finish({modelPath: "/Models/Ready.dlssmodel"});await harness.settle();
    assert.equal(saved[0][1].neuralMethod, "mlx-dlss");assert.equal(saved[0][1].frameGeneration, undefined);assert.equal(saved[0][1].frameMultiplier, undefined);
  } finally {harness.close();global.window = previous;}
});
