const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let GraphicsRange;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/GraphicsNumber.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "graphics-number.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ GraphicsRange } = compiled.exports);
});

test("a dragged graphics range commits once on release and once after a pause", async () => {
  const values = [], h = componentHarness(GraphicsRange, {id: "duty", min: "0", max: "1", step: "0.05", value: .5, onValue: value => values.push(value)});
  try {
    for (const value of [".55", ".6", ".65"]) h.render().props.onChange({target: {value}});
    assert.equal(h.render().props.value, .65);assert.deepEqual(values, []);
    h.render().props.onPointerUp();assert.deepEqual(values, [.65]);
    h.render().props.onPointerUp();assert.deepEqual(values, [.65], "a release without movement commits nothing");
    h.render().props.onChange({target: {value: ".7"}});
    await new Promise(resolve => setTimeout(resolve, 200));assert.deepEqual(values, [.65, .7]);
  } finally {h.close();}
});
