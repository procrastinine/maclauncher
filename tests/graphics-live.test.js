const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Live = require("../src/modules/shared/reshade/live-controls");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
const ReShade = require("../src/modules/shared/reshade");
const LiveEffect = require("../src/modules/shared/reshade/live-effect");
test("live settings isolate shader identity, preserve values and reset them when changing effects", t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-live-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = { gameId: "example", reshade: { enabled: true, preset: "cas", parameters: { Sharpening: [0.25] } },
    graphics: { frameGeneration: "lsfg", framePacing: "adaptive", targetFps: 90, frameMultiplier: 3, smoothCadence: true } };
  assert.equal(Live.write(entry, userDataDir), null);
  const file = Live.write(entry, userDataDir, { create: true }), bytes = fs.readFileSync(file);
  assert.equal(bytes.length, 19116);assert.equal(bytes.toString("ascii", 0, 8), "MLFXCTL2");
  assert.equal(bytes.readUInt32LE(8), 90);assert.equal(bytes.readUInt32LE(12), 3);assert.equal(bytes.readUInt32LE(16), 15);
  assert.equal(bytes.toString("ascii", 24, 88), Live.effectKey(entry.reshade));
  assert.equal(bytes.readUInt32LE(20), 1);assert.equal(bytes.readFloatLE(304), 0.25);
  const saved = ReShade.updateSettings(entry.reshade, { enabled: false });
  assert.deepEqual(saved.parameters, { Sharpening: [0.25] });saved.parameters.Sharpening[0] = 1;
  assert.equal(entry.reshade.parameters.Sharpening[0], 0.25);
  assert.equal(ReShade.updateSettings(entry.reshade, { preset: "crt" }).parameters, undefined);
  assert.equal(ReShade.updateSettings(entry.reshade, { parameters: null }).parameters, undefined);
  for (const parameters of [{ value: [Infinity] }, { value: ["1"] }, { value: new Array(2) }, { "../file": [1] }, { value: [1,2,3,4,5] }])
    assert.throws(() => ReShade.updateSettings(entry.reshade, { parameters }));
  entry.graphics.frameGeneration = "off";Live.write(entry, userDataDir);
  assert.equal(fs.readFileSync(file).readUInt32LE(16) & 1, 0);
  entry.graphics.effectPlacement = "after";entry.reshade.preset = "chain";Live.write(entry, userDataDir);
  assert.equal(fs.readFileSync(file).readUInt32LE(16) & (16 | 32), 48, "placement and shader-chain flags remain independent");
  entry.graphics.effectPlacement = "before";Live.write(entry, userDataDir);
  assert.equal(fs.readFileSync(file).readUInt32LE(16) & (16 | 32), 16);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["controls.bin"]);
});
test("live effect publication preserves the running selection on failure and snapshots image inputs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-live-effect-"));t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const userDataDir = path.join(root, "profile");fs.mkdirSync(path.join(root, "effects"));
  fs.writeFileSync(path.join(root, "effects/crt.fx"), "source");fs.writeFileSync(path.join(root, "effects/lookup.png"), "image");
  const entry = { gameId: "example", reshade: { enabled:true, preset:"crt" } };let calls = 0;
  const options = { root, userDataDir, execute: async (_command, args) => {
    calls++;if(args[0] === "--prepare")fs.writeFileSync(args[2], "expanded shader");
    else fs.writeFileSync(path.join(args[1], "textures.json"), JSON.stringify(["lookup.png"]));
  }};
  const directory = await LiveEffect.prepare(entry, options), selected = path.join(path.dirname(directory), "live-selection.json");
  const before = fs.readFileSync(selected), revision = JSON.parse(before).revision;
  assert.equal(fs.readFileSync(path.join(directory, revision, "texture-0"), "utf8"), "image");
  fs.writeFileSync(path.join(root, "effects/lookup.png"), "changed");
  await LiveEffect.prepare(entry, options);assert.equal(calls, 2, "parameter-only edits do not compile again");
  await assert.rejects(LiveEffect.prepare(entry, { ...options, force:true, execute: async () => { throw Error("unsupported shader"); } }), /running effect is unchanged/);
  assert.deepEqual(fs.readFileSync(selected), before);
  assert.equal(fs.readFileSync(path.join(directory, revision, "texture-0"), "utf8"), "image");
  await LiveEffect.prepare({ ...entry, reshade: { ...entry.reshade, enabled:false } }, { ...options, execute: () => assert.fail("disabled effect compilation") });
  assert.deepEqual(fs.readFileSync(selected), before);
  Live.write(entry, userDataDir, { create:true });const bytes = fs.readFileSync(Live.file(entry, userDataDir));
  assert.equal(bytes.toString("ascii", 88, 152), revision);assert.equal(bytes.readUInt32LE(16)&8, 8);
  assert.equal(fs.readdirSync(path.dirname(directory)).some(name => name.startsWith("live-compile-")), false);
});
test("adaptive controls validate settings and require an advertised host capability", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-adaptive-"));t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ features: require("../src/modules/shared/reshade/features.json") }));
  const selected = Graphics.updateSettings({}, { frameGeneration: "lsfg", framePacing: "adaptive", targetFps: 90, smoothCadence: true, frameMultiplier: 4, modelVersion: "sha256-" + "a".repeat(64) });
  const env = await Graphics.prepare(selected, { root, graphicsHost: "window", resolveModel: async () => ({ modelPath: "/local/Lossless.dll" }) });
  assert.equal(env.RESHADE_FRAME_PACING, "adaptive");assert.equal(env.RESHADE_TARGET_HZ, "90");assert.equal(env.RESHADE_STABLE_CADENCE, "1");assert.equal(env.RESHADE_FRAME_MULTIPLIER, "4");
  await assert.rejects(Graphics.prepare(selected, { root, graphicsHost: "explicit" }), /Adaptive.*unavailable/);
  for (const patch of [{ targetFps: 29 }, { targetFps: 241 }, { targetFps: 59.5 }, { framePacing: "unknown" }, { smoothCadence: 1 }])assert.throws(() => Graphics.updateSettings({}, patch));
});
test("shader metadata and image inputs describe the frozen prepared source when the original changes during validation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-source-snapshot-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, "Local.fx"), userDataDir = path.join(root, "profile");
  const original = "//!INPUT_POLICY source\noriginal";
  fs.writeFileSync(source, original);
  const directory = await LiveEffect.prepare({gameId: "snapshot", reshade: {enabled: true, preset: "custom", effectPath: source}}, {
    root, userDataDir, execute: async (_command, args, options) => {
      if (args[0] === "--prepare") {
        fs.writeFileSync(source, "//!INPUT_POLICY srgb-sdr\nchanged-depth");
        assert.ok(options.env.RESHADE_INCLUDE_PATH.split(path.delimiter).includes(path.dirname(source)));
        fs.copyFileSync(args[1], args[2]);
      } else {
        const depth = fs.readFileSync(args[0], "utf8").includes("depth");
        fs.writeFileSync(path.join(args[1], "requirements.json"), JSON.stringify({depth, motion: false}));
        fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
      }
    }
  });
  const selection = JSON.parse(fs.readFileSync(path.join(path.dirname(directory), "live-selection.json")));
  assert.equal(fs.readFileSync(path.join(directory, selection.revision, "effect.prepared.fx"), "utf8"), original);
  assert.equal(selection.inputPolicy, "source");
  assert.deepEqual(selection.requirements, {depth: false, motion: false});
  assert.equal(fs.readFileSync(source, "utf8"), "//!INPUT_POLICY srgb-sdr\nchanged-depth");
});
test("depth input definitions change the compiler identity and prepared defines of depth shaders only", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-depth-input-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), compiled = [];fs.mkdirSync(path.join(root, "effects"));
  fs.writeFileSync(path.join(root, "effects/depth.fx"), "depth source");fs.writeFileSync(path.join(root, "effects/grayscale.fx"), "color source");
  const execute = async (_command, args, {env}) => {
    if (args[0] === "--prepare") {compiled.push(Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("RESHADE_DEPTH_"))));fs.copyFileSync(args[1], args[2]);return;}
    fs.writeFileSync(path.join(args[1], "requirements.json"), JSON.stringify({depth: fs.readFileSync(args[0], "utf8").includes("depth"), motion: false}));
    fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
  };
  const prepare = async (preset, depthInput) => {
    const directory = await LiveEffect.prepare({gameId: preset, reshade: {enabled: true, preset}}, {root, userDataDir, execute, depthInput});
    return JSON.parse(fs.readFileSync(path.join(path.dirname(directory), "live-selection.json"))).compilerIdentity;
  };
  const standard = await prepare("depth");
  assert.deepEqual(compiled.splice(0), [{RESHADE_DEPTH_INPUT_IS_REVERSED: "0"}]);
  const reversed = await prepare("depth", {reversed: true, logarithmic: true, farPlane: 2500.5, multiplier: 2});
  assert.notEqual(reversed, standard);
  assert.deepEqual(compiled.splice(0), [{RESHADE_DEPTH_INPUT_IS_REVERSED: "1", RESHADE_DEPTH_INPUT_IS_LOGARITHMIC: "1",
    RESHADE_DEPTH_LINEARIZATION_FAR_PLANE: "2500.5", RESHADE_DEPTH_MULTIPLIER: "2.0"}]);
  assert.equal(await prepare("depth", {reversed: true, logarithmic: true, farPlane: 2500.5, multiplier: 2}), reversed);assert.equal(compiled.length, 0);
  assert.equal(await prepare("depth", {}), standard, "the default input restores the earlier identity");assert.equal(compiled.length, 1);
  const color = await prepare("grayscale");compiled.length = 0;
  assert.equal(await prepare("grayscale", {reversed: true}), color, "a shader without depth keeps its compiled revision");assert.equal(compiled.length, 0);
  assert.deepEqual(LiveEffect.depthDefinitions(), {RESHADE_DEPTH_INPUT_IS_REVERSED: "0"});
  assert.throws(() => LiveEffect.depthDefinitions({farPlane: 0}), /far plane/);
});
