const test = require("node:test"), assert = require("node:assert/strict");
const Graphics = require("../src/modules/crossover/graphics-inputs");
test("Wine graphics uses its loader architecture independently of the launcher", () => {
  assert.equal(Graphics.architecture({architectures: ["x86_64"]}, "arm64"), "x86_64");
  assert.equal(Graphics.architecture({architectures: ["arm64"]}, "x64"), "arm64");
  assert.equal(Graphics.architecture({architectures: ["x86_64", "arm64"]}, "arm64"), "arm64");
  assert.equal(Graphics.architecture({architectures: ["arm64", "x86_64"]}, "x64"), "x86_64");
  assert.equal(Graphics.architecture({installationMetadata: {architectures: ["x86_64"]}}, "arm64"), "x86_64");
});
test("Wine graphics retains explicit source metadata and does not invent pixel contracts", () => {
  const source = {source: "streamline", cameraProjection: true, methods: ["fsr2"],
    opacity: false, color: "linear", origin: "bottom-left", sourceResolution: false};
  const result = Graphics.inputs({architectures: ["x86_64"]}, source, {hostArchitecture: "arm64"});
  assert.deepEqual(result, {...source, architecture: "x86_64"});
  assert.equal(Object.hasOwn(source, "architecture"), false);
  assert.deepEqual(Graphics.inputs({architectures: ["x86_64"]}, null), {architecture: "x86_64"});
  assert.equal(Graphics.inputs({}, null), null);
  assert.deepEqual(Graphics.inputs({}, null, {fallback: "x86_64"}), {architecture: "x86_64"});
});
test("Sikarugir declares the native architecture verified by its payload resolver", () => {
  assert.equal(require("../src/modules/crossover/manifest.json").runtime.entries.sikarugir.graphicsArchitecture, "x86_64");
});
test("CrossOver reports loader architecture even without a temporal camera bridge", t => {
  const Module = require("../src/modules/crossover/main"), Temporal = require("../src/modules/crossover/temporal");
  t.mock.method(Temporal, "resolvePlan", () => null);
  const selected = {ready: true, install: {architectures: ["x86_64"]}};
  assert.deepEqual(Module.resolveGraphicsInputs({}, {runtimeId: "crossover"}, selected), {architecture: "x86_64"});
  t.mock.method(Temporal, "resolvePlan", () => ({inputs: {cameraProjection: true, sourceResolution: false, methods: ["fsr2"]}}));
  selected.install.architectures = ["arm64"];
  assert.deepEqual(Module.resolveGraphicsInputs({}, {runtimeId: "crossover"}, selected),
    {architecture: "arm64", cameraProjection: true, sourceResolution: false, methods: ["fsr2"]});
});
