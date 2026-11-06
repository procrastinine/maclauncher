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
test("CrossOver reports loader architecture even without a temporal camera bridge", async t => {
  const Module = require("../src/modules/crossover/main"), Temporal = require("../src/modules/crossover/temporal");
  t.mock.method(Temporal, "resolvePlan", () => null);
  // An empty CrossOver root supplies no included translators.
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const crossoverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crossover-graphics-inputs-"));
  t.after(() => fs.rmSync(crossoverRoot, {recursive: true, force: true}));
  const selected = {ready: true, install: {architectures: ["x86_64"], crossoverRoot}};
  assert.deepEqual(await Module.resolveGraphicsInputs({}, {runtimeId: "crossover"}, selected), {architecture: "x86_64"});
  t.mock.method(Temporal, "resolvePlan", () => ({inputs: {cameraProjection: true, sourceResolution: false, methods: ["fsr2"]}}));
  selected.install.architectures = ["arm64"];
  assert.deepEqual(await Module.resolveGraphicsInputs({}, {runtimeId: "crossover"}, selected),
    {architecture: "arm64", cameraProjection: true, sourceResolution: false, methods: ["fsr2"]});
});
test("FEX Wine selects arm64 native libraries while Rosetta Wine retains x64", t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { wineLayout } = require('../src/modules/shared/runtime/wine-layout');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-fex-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loaders = {};
  for (const [directory, cpu] of [['aarch64-unix', 0x0100000c], ['x86_64-unix', 0x01000007]]) {
    const file = path.join(root, 'lib/wine', directory, 'wine');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(2, 12);
    fs.writeFileSync(file, bytes); loaders[directory] = file;
  }
  for (const [directory, architecture] of [['aarch64-unix', 'arm64'], ['x86_64-unix', 'x86_64']]) {
    // The registered child loader is authoritative even with stale front-loader metadata.
    const install = { crossoverRoot: root, architectures: ['x86_64', 'arm64'], graphicsExecutablePath: loaders[directory] };
    assert.equal(wineLayout(install).architecture, architecture);
    assert.equal(Graphics.architecture(install, architecture === 'arm64' ? 'x64' : 'arm64'), architecture);
  }
  t.mock.method(require('../src/modules/shared/runtime/host-capabilities'), 'getHostCapabilities', () => ({ hardwareArch: 'arm64' }));
  assert.equal(wineLayout({ crossoverRoot: root, architectures: ['x86_64', 'arm64'] }).architecture, 'arm64');
  assert.equal(wineLayout({ crossoverRoot: root, architecture: 'x64' }).architecture, 'x86_64');
  assert.equal(wineLayout({ crossoverRoot: root, architecture: 'arm64' }).architecture, 'arm64');
});
