const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Godot = require("../src/modules/godot/main"), Graphics = require("../src/modules/godot/graphics");
const {pack, settings} = require("./helpers/godot-pack");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-graphics-readiness-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, "original.pck"), userDataDir = path.join(root, "profile");
  fs.writeFileSync(source, pack({"project.binary": settings({"application/config/name": "Original"})}, {version: 2, offset: 0}).buffer);
  const app = path.join(userDataDir, "runtimes/godot/4.6.3-stable/standard/Godot.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), {recursive: true});
  fs.writeFileSync(path.join(app, "Contents/MacOS/Godot"), "fixture only", {mode: 0o755});
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const entry = {gameId: "game", gamePath: source, runtimeId: "godot", runtimeData: {godot: {version: "4.6.3-stable", variant: "standard"}},
    moduleData: {packPath: source, detectedMajor: 4, detectedVersion: "4.6.3"}};
  const inputs = {source: "godot", cameraProjection: true, methods: ["fsr2"], sourceResolution: {live: true},
    sceneFrameAPI: 1, sceneDestinationAPI: 1, sceneAovAPI: 1, sceneCopyBoundaryAPI: 1,
    sceneAovs: ["normal"], noisyColor: true, depth: true, motionVectors: true, jitter: true, viewMatrix: true, projectionMatrix: true,
    opaque: true, rawFrameAPI: 1};
  const warnings = [], calls = [], context = {userDataDir, settings: {}, platform: "darwin", graphicsInputs: inputs,
    logger: {warn: (...args) => warnings.push(args)}, spawnDetachedChecked: (...args) => {calls.push(args);return {pid: 42, exitCode: 0};}};
  return {source, entry, context, inputs, warnings, calls};
}

test("Godot null camera preparation clears unavailable scene/live inputs without warning or failure state", async t => {
  const f = fixture(t);t.mock.method(Graphics, "prepare", () => null);
  f.context.graphicsBridgeFailure = {provider: "godot", reason: "stale previous observation"};
  await Godot.launchRuntime("godot", f.entry, f.context);
  assert.deepEqual(f.context.graphicsInputs, {opaque: true, rawFrameAPI: 1});
  assert.deepEqual(f.warnings, []);assert.equal(f.context.graphicsBridgeFailure, undefined);
  assert.deepEqual(f.calls[0][1], ["--main-pack", f.source]);assert.equal(f.calls[0][2].cwd, path.dirname(f.source));
});

test("Godot failed camera preparation clears the same inputs and records only the actual failure", async t => {
  const f = fixture(t);t.mock.method(Graphics, "prepare", () => {throw Error("fixture bridge failure");});
  await Godot.launchRuntime("godot", f.entry, f.context);
  assert.deepEqual(f.context.graphicsInputs, {opaque: true, rawFrameAPI: 1});
  assert.deepEqual(f.context.graphicsBridgeFailure, {provider: "godot", reason: "fixture bridge failure"});
  assert.equal(f.warnings.length, 1);assert.deepEqual(f.calls[0][1], ["--main-pack", f.source]);
});

test("Godot ready camera preparation retains its actual scene inputs", async t => {
  const f = fixture(t);t.mock.method(Graphics, "prepare", () => ({target: {kind: "pack", path: f.source}, environment: {MACLAUNCHER_GODOT_CAMERA_EXTENSION: "/fixture/camera.gdextension"}}));
  await Godot.launchRuntime("godot", f.entry, f.context);
  assert.equal(f.context.graphicsInputs, f.inputs);assert.deepEqual(f.warnings, []);
  assert.equal(f.context.graphicsBridgeFailure, undefined);assert.equal(f.calls[0][2].env.MACLAUNCHER_GODOT_CAMERA_EXTENSION, "/fixture/camera.gdextension");
});

test("Godot camera cancellation propagates without a fallback launch or misleading failure", async t => {
  const f = fixture(t), abort = Object.assign(Error("fixture cancellation"), {name: "AbortError"});
  t.mock.method(Graphics, "prepare", () => {throw abort;});
  await assert.rejects(Godot.launchRuntime("godot", f.entry, f.context), error => error === abort);
  assert.equal(f.context.graphicsInputs, f.inputs);assert.deepEqual(f.warnings, []);assert.deepEqual(f.calls, []);assert.equal(f.context.graphicsBridgeFailure, undefined);
});
