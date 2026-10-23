const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Packs = require("../src/modules/shared/reshade/shader-packs"), ReShade = require("../src/modules/shared/reshade");
const Placebo = require("../src/modules/shared/reshade/libplacebo"), LiveEffect = require("../src/modules/shared/reshade/live-effect");
const features = { formats: ["fx", "libplacebo"], providers: { libplacebo: { architectures: ["arm64", "x86_64"], minimumMacOS: "15.0" } } };
const options = { graphicsArchitecture: "arm64", macOSVersion: "26.0" };
function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mpv-collection-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));return directory;
}
test("included MPV filters retain original pinned RGB source and MIT notices offline", t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Included shader sources never fetch"));
  const rows = Packs.listEffects(null, features, options).filter(row => row.group === "Anime4K");
  assert.equal(rows.length, 4);assert.ok(rows.every(row => row.format === "libplacebo" && row.available && row.bundled));
  const pack = Packs.lookup(rows[0].id).pack, root = path.resolve(__dirname, "../src/modules/shared/reshade", pack.bundledPath);
  const inventory = JSON.parse(fs.readFileSync(path.join(root, "source-files.json")));
  assert.equal(inventory.revision, pack.revision);assert.equal(inventory.files.length, 5);
  assert.match(fs.readFileSync(path.join(root, "LICENSE"), "utf8"), /MIT License/);
  for (const item of inventory.files) {
    const bytes = fs.readFileSync(path.join(root, item.path));assert.equal(bytes.length, item.size);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), item.sha256);
    assert.equal(crypto.createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"), item.gitBlob);
    if (item.path.endsWith(".glsl")) {
      const source = bytes.toString();assert.match(source, /\/\/!HOOK MAIN/);
      assert.doesNotMatch(source, /\/\/!HOOK (?:LUMA|CHROMA)\b|\/\/!WHEN\b/);
      assert.match(source, /Permission is hereby granted/);
    }
  }
});
test("bundled formats follow original provider architecture and macOS availability", t => {
  const onlyArm = { ...features, providers: { libplacebo: { architectures: ["arm64"], minimumMacOS: "15.0" } } };
  const find = (support, selection) => Packs.listEffects(null, support, selection).find(row => row.id === "shader:anime4k:restore-cnn-s");
  assert.match(find({}, options).reason, /unavailable/);
  assert.match(find(onlyArm, { ...options, graphicsArchitecture: "x64" }).reason, /arm64 game processes/);
  assert.match(find(features, { ...options, macOSVersion: "14.0" }).reason, /macOS 15.0/);
  assert.equal(find(features, options).available, true);
  const onlyIntel = { ...features, providers: { libplacebo: { architectures: ["x86_64"] } } };
  assert.equal(find(onlyIntel, { ...options, graphicsArchitecture: "x64" }).available, true);
  assert.equal(Packs.resolveEffect(null, "shader:anime4k:restore-cnn-s", onlyIntel, undefined,
    { ...options, graphicsArchitecture: "x64" }).format, "libplacebo");
  assert.throws(() => Packs.resolveEffect(null, "shader:anime4k:restore-cnn-s", onlyArm, undefined,
    { ...options, graphicsArchitecture: "x64" }), /arm64 game processes/);
  const root = temporary(t);
  for (const file of ["fx-compile", "libreshade-macos.dylib"]) fs.writeFileSync(path.join(root, file), "fixture");
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: 1, version: "fixture", minimumMacOS: "13.0", features: { shaders: onlyArm } }));
  const state = ReShade.getState({ root, platform: "darwin", graphicsArchitecture: "x64", macOSVersion: "26.0" });
  const row = state.presets.find(row => row.id === "shader:anime4k:restore-cnn-s");
  assert.equal(row.format, "libplacebo");assert.equal(row.available, false);assert.match(row.reason, /arm64 game processes/);
  assert.equal(state.presets.find(row => row.id === "shader:sweetfx:curves").available, true);
});
test("packaged MPV assets resolve outside ASAR and retain their provider format", t => {
  const root = temporary(t), moduleRoot = path.join(root, "app.asar/src/modules/shared/reshade"), physical = moduleRoot.replace("app.asar/", "app.asar.unpacked/");
  const original = Packs.resolveEffect(null, "shader:anime4k:denoise-bilateral-mean", features, undefined, options);
  const dest = path.join(physical, "shader-collection/anime4k/glsl/Denoise/Anime4K_Denoise_Bilateral_Mean.glsl");
  fs.mkdirSync(path.dirname(dest), { recursive: true });fs.copyFileSync(original.file, dest);
  const selected = Packs.resolveEffect(null, "shader:anime4k:denoise-bilateral-mean", features, undefined, { ...options, moduleRoot });
  assert.equal(selected.file, dest);assert.equal(selected.format, "libplacebo");assert.deepEqual(selected.includePaths, []);
});
test("included MPV filters use the installed original parser and immutable live provider route", { skip: process.platform !== "darwin" }, async t => {
  const root = ReShade.runtimeRoot(), helper = path.join(root, "libplacebo-prepare");
  if (!fs.existsSync(helper)) return t.skip("Requires the included libplacebo provider");
  t.mock.method(globalThis, "fetch", () => assert.fail("Included shaders never fetch"));
  const userDataDir = temporary(t), execute = promisify(execFile);
  const rows = Packs.listEffects(null, features, options).filter(row => row.group === "Anime4K");
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
