const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Packs = require("../src/modules/shared/reshade/shader-packs"), ReShade = require("../src/modules/shared/reshade");
const Placebo = require("../src/modules/shared/reshade/libplacebo"), LiveEffect = require("../src/modules/shared/reshade/live-effect");
const features = { formats: ["fx", "libplacebo"], providers: { libplacebo: { architectures: ["arm64", "x86_64"], minimumMacOS: "15.0" } } };
const options = { graphicsArchitecture: "arm64", macOSVersion: "26.0" };
function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mpv-collection-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));return directory;
}
test("the former included Anime4K filters resolve to the managed Anime4K collection", () => {
  const Managed = require("../src/modules/shared/reshade/managed-shaders"), StoredPlan = require("../src/modules/shared/effects/stored-plan");
  assert.equal(Packs.listEffects(null, features, options).some(row => row.group === "Anime4K"), false);
  const renamed = {"shader:anime4k:restore-cnn-s": "shader:managed-anime4k:97c24dc370ab300c",
    "shader:anime4k:denoise-bilateral-mean": "shader:managed-anime4k:48ec0cb087afaf0d"};
  for (const [id, current] of Object.entries(renamed)) {
    assert.equal(Packs.lookup(id), null);assert.equal(Packs.normalizeId(id), current);assert.ok(Managed.isId(current));
    assert.equal(ReShade.normalizeSettings({ enabled: true, preset: id }).preset, current);
  }
  assert.equal(Packs.normalizeId("pack:anime4k:7684e9586f8d:deblur-dog"), "shader:managed-anime4k:d24499348ed515a9");
  const shader = id => ({ id: "row", kind: "shader", enabled: true, shader: { enabled: true, preset: id } });
  const read = StoredPlan.inspect({ schema: 2, mode: "advanced", enabled: true, video: [shader("shader:anime4k:restore-cnn-s")] });
  assert.equal(read.migrated, true);assert.equal(read.plan.video[0].shader.preset, renamed["shader:anime4k:restore-cnn-s"]);
  const current = StoredPlan.inspect({ schema: 2, mode: "advanced", enabled: true, video: [shader("shader:image:deband")] });
  assert.equal(current.migrated, false);
});
test("bundled formats follow original provider architecture and macOS availability", t => {
  const onlyArm = { ...features, providers: { libplacebo: { architectures: ["arm64"], minimumMacOS: "15.0" } } };
  const find = (support, selection) => Packs.listEffects(null, support, selection).find(row => row.id === "shader:image:color-balance");
  assert.match(find({}, options).reason, /unavailable/);
  assert.match(find(onlyArm, { ...options, graphicsArchitecture: "x64" }).reason, /arm64 game processes/);
  assert.match(find(features, { ...options, macOSVersion: "14.0" }).reason, /macOS 15.0/);
  assert.equal(find(features, options).available, true);
  const onlyIntel = { ...features, providers: { libplacebo: { architectures: ["x86_64"] } } };
  assert.equal(find(onlyIntel, { ...options, graphicsArchitecture: "x64" }).available, true);
  assert.equal(Packs.resolveEffect(null, "shader:image:color-balance", onlyIntel, undefined,
    { ...options, graphicsArchitecture: "x64" }).format, "libplacebo");
  assert.throws(() => Packs.resolveEffect(null, "shader:image:color-balance", onlyArm, undefined,
    { ...options, graphicsArchitecture: "x64" }), /arm64 game processes/);
  const root = temporary(t);
  for (const file of ["fx-compile", "libreshade-macos.dylib"]) fs.writeFileSync(path.join(root, file), "fixture");
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: 1, version: "fixture", minimumMacOS: "13.0", features: { shaders: onlyArm } }));
  const state = ReShade.getState({ root, platform: "darwin", graphicsArchitecture: "x64", macOSVersion: "26.0" });
  const row = state.presets.find(row => row.id === "shader:image:color-balance");
  assert.equal(row.format, "libplacebo");assert.equal(row.available, false);assert.match(row.reason, /arm64 game processes/);
  assert.equal(state.presets.find(row => row.id === "shader:sweetfx:curves").available, true);
});
test("packaged MPV assets resolve outside ASAR and retain their provider format", t => {
  const root = temporary(t), moduleRoot = path.join(root, "app.asar/src/modules/shared/reshade"), physical = moduleRoot.replace("app.asar/", "app.asar.unpacked/");
  const original = Packs.resolveEffect(null, "shader:image:color-balance", features, undefined, options);
  const dest = path.join(physical, "shader-collection/image/color-balance.hook");
  fs.mkdirSync(path.dirname(dest), { recursive: true });fs.copyFileSync(original.file, dest);
  const selected = Packs.resolveEffect(null, "shader:image:color-balance", features, undefined, { ...options, moduleRoot });
  assert.equal(selected.file, dest);assert.equal(selected.format, "libplacebo");assert.deepEqual(selected.includePaths, []);
});
test("included MPV filters use the installed original parser and immutable live provider route", { skip: process.platform !== "darwin" }, async t => {
  const root = ReShade.runtimeRoot(), helper = path.join(root, "libplacebo-prepare");
  if (!fs.existsSync(helper)) return t.skip("Requires the included libplacebo provider");
  t.mock.method(globalThis, "fetch", () => assert.fail("Included shaders never fetch"));
  const userDataDir = temporary(t), execute = promisify(execFile);
  const rows = Packs.listEffects(null, features, options).filter(row => row.group === "Image" && row.sourcePath.endsWith(".hook"));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const selected = Packs.resolveEffect(null, row.id, features, undefined, options);
    const metadata = await Placebo.inspect(selected.file, { root, execute });assert.equal(metadata.rgbCompatible, true);
    const entry = { gameId: row.id.split(":").at(-1), reshade: { enabled: true, preset: row.id } };
    // The launcher CPU must not replace the selected child runtime CPU.
    const support = { ...features, providers: { libplacebo: { architectures: ["x86_64"] } } };
    const directory = await LiveEffect.prepare(entry, { root, userDataDir, features: support, graphicsArchitecture: "x64", execute });
    const selection = JSON.parse(fs.readFileSync(path.join(path.dirname(directory), "live-selection.json")));
    assert.equal(selection.format, "libplacebo");
    const bundle = path.join(directory, selection.revision);assert.ok(Placebo.verifyBundle(bundle));
    assert.deepEqual(fs.readFileSync(path.join(bundle, "effect.hook")), fs.readFileSync(selected.file));
  }
});
