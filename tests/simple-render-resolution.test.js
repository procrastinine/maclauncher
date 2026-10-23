const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let SimpleRenderResolution;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: { ssr: path.join(__dirname, "../src/renderer/src/ui/components/SimpleRenderResolution.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, "simple-render-resolution.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id);
  ({ SimpleRenderResolution } = compiled.exports);
});
function elements(value) { return React.isValidElement(value) ? [value, ...React.Children.toArray(value.props.children).flatMap(elements)] : []; }
test("custom resizing shaders use local selection metadata without a second spatial filter or stale source controls", async () => {
  const previous = global.window, calls = [], saved = [];let traits = { conditionalGeometry: true };
  global.window = { MacLauncher: { launcher: { getGameEffects: async gamePath => { calls.push(gamePath);return { selectedShaderTraits: traits }; } } } };
  const props = { game: { gamePath: "/Game", runtimeId: "native", graphics: { spatialMethod: "off", spatialMultiplier: 2 },
    reshade: { enabled: true, preset: "custom", effectPath: "/Shaders/Unrelated-name.hook" } }, multipliers: [1, 1.5, 2, 3],
    onChange: async (...args) => saved.push(args) };
  const before = structuredClone(props.game), harness = componentHarness(SimpleRenderResolution, props);
  try {
    assert.equal(harness.render(), null);await harness.settle();
    assert.match(renderToStaticMarkup(harness.render()), /value="2" selected="">50% · 2× upscale/);
    await elements(harness.render()).find(row => row.props.id === "game-resolution-multiplier").props.onChange({ target: { value: "3" } });
    assert.deepEqual(saved, [["/Game", { spatialMultiplier: 3 }]]);assert.deepEqual(props.game, before);assert.deepEqual(calls, ["/Game"]);
    traits = undefined;props.game.reshade = { ...props.game.reshade, effectPath: "/Shaders/Color.hook" };
    assert.equal(harness.render(), null);await harness.settle();assert.equal(harness.render(), null);assert.equal(calls.length, 2);
  } finally { harness.close();global.window = previous; }
});
test("completed-frame sizing saves the same scalar request and keeps ordinary CRT unchanged", async () => {
  const saved = [], props = {game: {gamePath: "/Browser", graphics: {spatialMethod: "fsr1", spatialMultiplier: null},
    reshade: {enabled: true, preset: "crt"}}, multipliers: [], sourceResolution: false, processingAvailable: true,
    onChange: async (...args) => saved.push(args)};
  const harness = componentHarness(SimpleRenderResolution, props), before = structuredClone(props.game);
  try {
    const select = () => elements(harness.render()).find(row => row.props.id === "game-resolution-multiplier");
    assert.equal(select().props.value, "auto");
    await select().props.onChange({target: {value: "2"}});
    assert.deepEqual(saved, [["/Browser", {spatialMultiplier: 2}]]);assert.deepEqual(props.game, before);
    props.game.graphics = {...props.game.graphics, spatialMethod: "off"};assert.equal(harness.render(), null);
    props.game.reshade = {...props.game.reshade, preset: "filter:resize"};
    props.shaderTraits = {outputScale: {x: 2, y: 2}};
    assert.match(renderToStaticMarkup(harness.render()), /Processing resolution/);
    assert.match(renderToStaticMarkup(harness.render()), /value="4">25% · 4× upscale/);
  } finally {harness.close();}
});
