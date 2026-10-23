const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Providers = require("../src/modules/shared/reshade/shader-providers"), Retro = require("../src/modules/shared/reshade/retroarch");
const Placebo = require("../src/modules/shared/reshade/libplacebo"), LiveEffect = require("../src/modules/shared/reshade/live-effect");
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shader-provider-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const userDataDir = path.join(temporary, "profile"), hook = path.join(temporary, "Tone.hook"), slang = path.join(temporary, "Tone.slangp"), calls = [];
  fs.writeFileSync(hook, "//!HOOK MAIN\n//!BIND HOOKED\n");fs.writeFileSync(slang, "shaders=1\n");
  const parameters = [{ name: "Gain", label: "Gain", type: "float", default: [1], min: 0, max: 2, step: .1 }];
  const execute = async (command, args, options) => {
    calls.push({ command, args });assert.equal(options.env.DYLD_INSERT_LIBRARIES, undefined);
    if (args[0] === "--inspect") return { stdout: JSON.stringify({ schema: 1, parameters }) };
    assert.equal(args[0], "--prepare");assert.equal(fs.existsSync(args[2]), false);fs.mkdirSync(args[2]);
    const name = command.endsWith("libplacebo-prepare") ? "effect.hook" : "effect.slangp", bytes = fs.readFileSync(args[1]);
    fs.writeFileSync(path.join(args[2], name), bytes);
    fs.writeFileSync(path.join(args[2], "metadata.json"), JSON.stringify({ schema: 1, parameters,
      files: [{ path: name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }] }));
    return { stdout: "" };
  };
  return { temporary, userDataDir, hook, slang, calls, options: { root: temporary, userDataDir, execute }, parameters };
}
test("providers share format routing and enforce actual CPU and macOS requirements", () => {
  for (const file of ["A.SLANGP", "A.slang"]) assert.equal(Providers.packaged(file).format, "slangp");
  for (const file of ["A.glsl", "A.HOOK"]) assert.equal(Providers.packaged(file).format, "libplacebo");
  assert.equal(Providers.packaged("A.fx"), null);assert.equal(Providers.packaged("A.glslp"), null);
  const features = { formats: ["fx", "slangp", "libplacebo"], providers: { libplacebo: { architectures: ["arm64"], minimumMacOS: "15.0" } } };
  assert.equal(Providers.availability("slang", { features, graphicsArchitecture: "x64" }), null);
  assert.match(Providers.availability("libplacebo", { features, graphicsArchitecture: "x86_64", macOSVersion: "26.0" }), /arm64 game processes/);
  assert.match(Providers.availability("libplacebo", { features, graphicsArchitecture: "arm64", macOSVersion: "14.0" }), /macOS 15.0/);
  assert.equal(Providers.availability("libplacebo", { features, graphicsArchitecture: "arm64", macOSVersion: "15.0" }), null);
  assert.match(Providers.availability("libplacebo"), /unavailable/);
});
test("shared preparation deduplicates verified shader bundles and rejects modified or undeclared resources", async t => {
  const f = fixture(t), a = await Retro.prepare(f.slang, f.options), b = await Retro.prepare(f.slang, f.options);
  assert.equal(a.directory, b.directory);assert.equal(fs.readdirSync(path.dirname(a.directory)).length, 1);
  assert.equal(f.calls.length, 2);assert.equal(a.metadata.parameters.length, 1);
  fs.writeFileSync(path.join(a.directory, "extra"), "private");assert.throws(() => Retro.verifyBundle(a.directory), /undeclared/);fs.unlinkSync(path.join(a.directory, "extra"));
  fs.symlinkSync(f.hook, path.join(a.directory, "alias"));assert.throws(() => Retro.verifyBundle(a.directory), /undeclared/);fs.unlinkSync(path.join(a.directory, "alias"));
  fs.writeFileSync(a.effect, "changed");assert.throws(() => Retro.verifyBundle(a.directory), /resource changed/);
});
test("libplacebo inspection and immutable live selection use the same helper protocol and cache", async t => {
  const f = fixture(t), inspected = await Placebo.inspect(f.hook, f.options);
  assert.deepEqual(inspected.parameters, f.parameters);
  const features = { formats: ["libplacebo"], providers: { libplacebo: { architectures: ["arm64"] } } };
  const entry = { gameId: "game-a", reshade: { enabled: true, preset: "custom", effectPath: f.hook } };
  const first = await LiveEffect.prepare(entry, { ...f.options, features, graphicsArchitecture: "arm64" });
  const selection = JSON.parse(fs.readFileSync(path.join(path.dirname(first), "live-selection.json")));
  assert.equal(selection.format, "libplacebo");const effect = path.join(first, selection.revision, "effect.hook");
  const cached = await Placebo.prepare(f.hook, f.options);
  assert.equal(fs.statSync(effect).ino, fs.statSync(cached.effect).ino, "game selection shares immutable cached resources");
  const count = f.calls.length;
  await LiveEffect.prepare(entry, { ...f.options, features, graphicsArchitecture: "arm64" });assert.equal(f.calls.length, count);
  await assert.rejects(LiveEffect.prepare(entry, { ...f.options, features, graphicsArchitecture: "x86_64" }), /arm64 game processes/);
  assert.equal(fs.existsSync(effect), true);
});
test("provider metadata retains large parameter sets, original modes and valid integer controls", () => {
  const parameters = Array.from({ length: 4096 }, (_, i) => ({ name: "Parameter" + i, type: "int", default: [1], min: 0, max: 3, mode: "constant", options: [{ value: 0, label: "Off" }, { value: 1, label: "On" }] }));
  const result = Placebo.metadata({ schema: 1, parameters });assert.equal(result.parameters.length, 4096);
  assert.equal(result.parameters[0].mode, "constant");assert.deepEqual(result.parameters[0].options, [{ value: 0, label: "Off" }, { value: 1, label: "On" }]);
  assert.throws(() => Placebo.metadata({ schema: 1, parameters: [{ ...parameters[0], options: [{ value: NaN, label: "Invalid" }] }] }), /choices/);
  assert.throws(() => Placebo.metadata({ schema: 1, parameters: [...parameters, parameters[0]] }), /invalid/);
  assert.throws(() => Placebo.metadata({ schema: 1, parameters: [{ name: "X", type: "float", default: [Infinity] }] }), /invalid/);
  assert.throws(() => Placebo.metadata({ schema: 1, parameters: [], rgbCompatible: false }), /RGB-compatible hook/);
  assert.deepEqual(Placebo.metadata({schema: 1, parameters: [], rgbCompatible: false}, {nativeVideo: true}).parameters, []);
});
