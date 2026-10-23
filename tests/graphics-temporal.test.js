const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
const Temporal = require("../src/modules/shared/reshade/temporal-controls");
const Live = require("../src/modules/shared/reshade/live-controls");
const ReShade = require("../src/modules/shared/reshade");
const Native = require("../src/modules/shared/runtime/bundled-native");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-temporal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "runtime"), userDataDir = path.join(directory, "profile");
  fs.mkdirSync(root);fs.writeFileSync(path.join(root, "libreshade-macos.dylib"), "fixture");fs.writeFileSync(path.join(root, "fx-compile"), "fixture");
  const graphics = { temporalCameraAPI: 1, temporalMethods: ["metalfx", "fsr2", "fsr3", "fsr4", "dlss"], spatialMethods: ["fsr1"],
    presentation: { hosts: { window: { temporal: true, temporalMethods: ["metalfx", "fsr4"], spatial: true, effectPlacement: true },
      catalyst: { temporal: true, temporalMethods: ["metalfx"] }, remote: { spatial: true }, explicit: { spatial: true } } } };
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: 1, version: "test", minimumMacOS: "11.0", features: { graphics } }));
  return { root, userDataDir };
}

test("temporal settings require both an implementation and compatible host inputs", async t => {
  const options = fixture(t);
  t.mock.method(require("../src/modules/shared/reshade/temporal/fsr"), "resolve", () => ({ methods: ["fsr2", "fsr3"] }));
  assert.equal(Graphics.DEFAULTS.temporalMethod, "off");
  assert.deepEqual(Graphics.capabilities(options.root, "window").temporalMethods, ["metalfx"]);
  for (const graphicsHost of ["window", "catalyst"]) {
    const environment = await Graphics.prepare({ temporalMethod: "metalfx", temporalSharpness: 0.25 }, { ...options, graphicsHost });
    assert.equal(environment.RESHADE_TEMPORAL_METHOD, "metalfx");
    assert.equal(environment.RESHADE_TEMPORAL_SHARPNESS, "0.25");
  }
  for (const temporalMethod of ["fsr2", "fsr3", "fsr4"]) {
    await assert.rejects(Graphics.prepare({ temporalMethod }, { ...options, graphicsHost: "window" }), /compatible game inputs/);
  }
  for (const graphicsHost of ["remote", "explicit", undefined]) {
    assert.deepEqual(Graphics.capabilities(options.root, graphicsHost).temporalMethods, []);
    await assert.rejects(Graphics.prepare({ temporalMethod: "metalfx" }, { ...options, graphicsHost }), /compatible game inputs/);
  }
  for (const patch of [{ temporalMethod: "dlss" }, { temporalMethod: "fsr1" }, { temporalSharpness: 1.1 }, { temporalSharpness: -1 }, { temporalSharpness: NaN }])
    assert.throws(() => Graphics.updateSettings({}, patch));
  assert.deepEqual(await Graphics.prepare({}, { root: "/missing" }), {});
  t.mock.method(require("../src/modules/shared/reshade/temporal/fsr4"), "resolve", () => ({ directory: options.root }));
  assert.deepEqual(Graphics.capabilities(options.root, "window").temporalMethods, ["metalfx", "fsr4"], "FSR4 requires an installed compatible provider");
});

test("camera integrations enable only installed methods on temporal-capable hosts and bind live launch inputs", async t => {
  const options = fixture(t), FSR = require("../src/modules/shared/reshade/temporal/fsr");
  t.mock.method(FSR, "resolve", () => ({ methods: ["fsr2", "fsr3"] }));
  t.mock.method(FSR, "prepare", () => ({ RESHADE_FSR2_LIBRARY: "/installed/fsr2.dylib", RESHADE_FSR3_LIBRARY: "/installed/fsr3.dylib" }));
  const graphicsInputs = { cameraProjection: true, source: "native-renderer", methods: ["fsr2", "fsr3"] };
  assert.deepEqual(Graphics.capabilities(options.root, "window").cameraTemporalMethods, ["fsr2", "fsr3"]);
  assert.deepEqual(Graphics.capabilities(options.root, "window", { graphicsInputs }).temporalMethods, ["metalfx", "fsr2", "fsr3"]);
  for (const host of ["remote", "explicit", null])
    assert.deepEqual(Graphics.capabilities(options.root, host, { graphicsInputs }).temporalMethods, []);
  const context = { ...options, graphicsHost: "window", graphicsInputs };
  assert.equal((await Graphics.prepare({ temporalMethod: "fsr3" }, context)).RESHADE_TEMPORAL_METHOD, "fsr3");
  await assert.rejects(Graphics.prepare({ temporalMethod: "fsr2" }, { ...context, graphicsInputs: { ...graphicsInputs, cameraProjection: false } }), /compatible game inputs/);
  if (process.platform === "darwin") {
    t.mock.method(Native, "systemVersionSync", () => "27.0");
    const entry = { gameId: "camera-native", graphics: {temporalMethod: "fsr2"} };
    const env = await ReShade.prepare(entry, { ...context, verify: () => true, execute: () => assert.fail("inactive shader compilation") });
    const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(env.RESHADE_CONTROL_FILE), "launch.json")));
    assert.deepEqual(launch.graphicsInputs, graphicsInputs);
    assert.deepEqual(launch.liveTemporalMethods, ["fsr2"], "only the selected temporal implementation is bound");
    await ReShade.validateLiveGraphics({ ...entry, graphics: { temporalMethod: "fsr2" } }, { ...context, graphicsInputs: null });
  }
  t.mock.method(FSR, "resolve", () => ({ methods: ["fsr3"] }));
  assert.deepEqual(Graphics.capabilities(options.root, "window", { graphicsInputs }).temporalMethods, ["metalfx", "fsr3"]);
});

test("temporal controls use an independent bounded packet and image-only writes leave absent temporal controls alone", t => {
  const { userDataDir } = fixture(t), entry = { gameId: "temporal", graphics: { temporalMethod: "fsr4", temporalSharpness: 0.25 } };
  assert.equal(Temporal.write(entry, userDataDir), null);
  const imageFile = Live.write(entry, userDataDir, { create: true });
  assert.equal(fs.existsSync(Temporal.file(entry, userDataDir)), false);
  const imageBefore = fs.readFileSync(imageFile), file = Temporal.write(entry, userDataDir, { create: true });
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, 24);assert.equal(bytes.toString("ascii", 0, 8), "MLTMCTL1");
  assert.equal(bytes.readUInt32LE(8), 4);assert.equal(bytes.readFloatLE(12), 0.25);
  assert.equal(bytes.readUInt32LE(16), 0);assert.equal(bytes.readUInt32LE(20), 0);
  Live.write({ ...entry, graphics: { ...entry.graphics, temporalMethod: "off" } }, userDataDir);
  assert.equal(fs.readFileSync(file).readUInt32LE(8), 0);
  assert.deepEqual(fs.readFileSync(imageFile), imageBefore, "temporal choice does not alter the image-only ABI");
  assert.throws(() => Temporal.write({ gameId: "../outside" }, userDataDir, { create: true }), /saved game/);
});

test("inactive hosts skip setup and selected temporal switching cannot bind later providers", { skip: process.platform !== "darwin" }, async t => {
  const options = fixture(t);t.mock.method(Native, "systemVersionSync", () => "27.0");
  const entry = { gameId: "native", graphics: {temporalMethod: "metalfx"} };
  const context = { ...options, graphicsHost: "window", verify: () => true, execute: () => assert.fail("inactive shader compilation"), diagnostics: false, gpuTiming: false, trace: false };
  assert.deepEqual(await ReShade.prepare({gameId: "inactive"}, context), {});
  assert.equal(fs.existsSync(options.userDataDir), false, "an inactive native launch creates no graphics profile");
  const env = await ReShade.prepare(entry, context);
  assert.equal(env.RESHADE_TEMPORAL_METHOD, "metalfx");
  assert.equal(env.RESHADE_TEMPORAL_CONTROL_FILE, Temporal.file(entry, options.userDataDir));
  await ReShade.validateLiveGraphics({ ...entry, graphics: { temporalMethod: "metalfx" } }, context);
  await ReShade.validateLiveGraphics({ ...entry, graphics: { effectPlacement: "after" } }, context);
  const launchFile = path.join(path.dirname(env.RESHADE_CONTROL_FILE), "launch.json"), launch = JSON.parse(fs.readFileSync(launchFile));
  assert.equal(launch.liveEffectPlacement, true);
  fs.writeFileSync(launchFile, JSON.stringify({ ...launch, liveEffectPlacement: false }));
  await assert.rejects(ReShade.validateLiveGraphics({ ...entry, graphics: { effectPlacement: "after" } }, context), /Restart the game/);
  fs.writeFileSync(launchFile, JSON.stringify(launch));
  await assert.rejects(ReShade.validateLiveGraphics({ ...entry, graphics: { temporalMethod: "fsr2" } }, context), /compatible game inputs/);
  t.mock.method(require("../src/modules/shared/reshade/temporal/fsr4"), "resolve", () => ({ directory: options.root }));
  assert.ok(Graphics.capabilities(options.root, "window").temporalMethods.includes("fsr4"));
  await assert.rejects(ReShade.validateLiveGraphics({ ...entry, graphics: { temporalMethod: "fsr4" } }, context), /Restart the game/);
  assert.equal(fs.readFileSync(env.RESHADE_TEMPORAL_CONTROL_FILE).readUInt32LE(8), 1, "a provider installed after launch cannot replace the selected live method");
  const remote = await ReShade.prepare({ gameId: "web", graphics: {spatialMethod: "fsr1"} }, { ...context, graphicsHost: "remote" });
  assert.ok(remote.DYLD_INSERT_LIBRARIES, "remote spatial processing remains available without temporal setup");
  assert.equal(remote.RESHADE_TEMPORAL_CONTROL_FILE, undefined);
  assert.equal(fs.existsSync(Temporal.file({ gameId: "web" }, options.userDataDir)), false);
});

test("isolated native apps retain bounded temporal controls and read-only provider resources", async t => {
  const { root, userDataDir } = fixture(t), inputs = path.join(root, "inputs"), outputs = path.join(root, "outputs");
  fs.mkdirSync(inputs);fs.mkdirSync(outputs);
  const providerRoot = path.join(root, "temporal/fsr4"), build = path.join(providerRoot, "build");
  fs.mkdirSync(build, { recursive: true });
  const library = path.join(providerRoot, "libmaclauncher-fsr4.dylib");fs.writeFileSync(library, "fixture");
  const control = Temporal.write({ gameId: "sandbox" }, userDataDir, { create: true });
  const graphics = { RESHADE_TEMPORAL_CONTROL_FILE: control, RESHADE_TEMPORAL_METHOD: "fsr4", RESHADE_FSR4_LIBRARY: library,
    FSR4_ROOT: providerRoot, FSR4_BUILD_DIR: build, FSR4_SETTINGS: "/unrelated/settings.json" };
  const scoped = await require("../src/modules/shared/runtime/macos-sandbox").isolateGraphics(graphics, inputs, outputs);
  assert.equal(scoped.graphics.RESHADE_TEMPORAL_CONTROL_FILE, control);
  assert.equal(scoped.graphics.FSR4_ROOT, providerRoot);assert.equal(scoped.graphics.FSR4_BUILD_DIR, build);
  assert.equal(scoped.graphics.FSR4_SETTINGS, undefined);
  assert.deepEqual(scoped.readable.sort(), [control, library].map(file => fs.realpathSync(file)).sort());
  assert.deepEqual(scoped.readableDirectories, [fs.realpathSync(providerRoot)]);
  const clean = ReShade.mergeEnvironment({ FSR4_ROOT: "/stale", FSR4_BUILD_DIR: "/stale/build" }, { DYLD_INSERT_LIBRARIES: "/owned/native.dylib" });
  assert.equal(clean.FSR4_ROOT, undefined);assert.equal(clean.FSR4_BUILD_DIR, undefined);
});
