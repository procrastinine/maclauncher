const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Graphics = require('../src/modules/godot/graphics');
const crypto = require('node:crypto');
const Godot = require('../src/modules/godot/main');
const source = require('../src/modules/godot/graphics/source.json');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'godot-graphics-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'runtime');
  fs.mkdirSync(path.join(root, 'godot'), { recursive: true });
  fs.writeFileSync(path.join(root, 'godot', 'provider.json'), JSON.stringify({ abi: 1, complete: true, sourceCommit: source.commit }));
  fs.writeFileSync(path.join(root, 'godot', 'libmaclauncher-godot-camera.dylib'), 'library');
  for (const script of ['autoload.gd', 'camera-effect.gd']) fs.writeFileSync(path.join(root, 'godot', script), 'extends Node\n');
  const userDataDir = path.join(directory, 'data');
  const entry = { gameId: 'camera-game', graphics: { temporalMethod: 'off' } };
  return { directory, root, userDataDir, entry };
}
function pack(file, minor = 4) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(20); header.write('GDPC');
  header.writeUInt32LE(3, 4); header.writeUInt32LE(4, 8); header.writeUInt32LE(minor, 12);
  fs.writeFileSync(file, header);
}
function installGodotFixture(app) {
  const executable = path.join(app, 'Contents', 'MacOS', 'Godot');
  fs.mkdirSync(path.dirname(executable), {recursive: true});
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string></dict></plist>');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  return executable;
}
function managedLaunch(t) {
  const f = fixture(t), input = path.join(f.directory, 'game.pck');pack(input);
  const app = path.join(f.userDataDir, 'runtimes', 'godot', '4.4-stable', 'mono', 'Godot.app');
  const executable = installGodotFixture(app);
  Object.assign(f.entry, {gamePath: input, moduleData: {packPath: input, detectedVersion: '4.4.0', detectedMajor: 4},
    runtimeData: {godot: {version: '4.4-stable', variant: 'mono'}}});
  const warnings = [], calls = [], child = {pid: 123};
  const context = {userDataDir: f.userDataDir, graphicsRoot: f.root, platform: 'darwin', settings: {},
    logger: {warn: (...args) => warnings.push(args)},
    spawnDetachedChecked: async (...args) => {calls.push(args);return child;}};
  return {...f, input, executable, warnings, calls, child, context};
}

test('Godot managed launches retain the dormant bridge and original working directory', async t => {
  const f = managedLaunch(t);
  assert.equal(await Godot.launchRuntime('godot', f.entry, f.context), f.child);
  const [command, args, options] = f.calls[0];
  assert.equal(command, f.executable);assert.equal(args[0], '--main-pack');
  assert.notEqual(args[1], f.input);assert.equal(fs.realpathSync(args[1]), f.input);
  assert.equal(options.cwd, path.dirname(f.input));assert.ok(options.env.MACLAUNCHER_GODOT_CAMERA_EXTENSION);
  assert.equal(f.warnings.length, 0);assert.equal(f.context.graphicsBridgeFailure, undefined);
});

test('Godot overlay failure launches the original target and preserves independent shared stages', async t => {
 for (const sink of ['record', 'throw', 'reject']) await t.test(sink, async t => {
  const f = managedLaunch(t), selected = {cameraProjection: true, source: 'godot', methods: ['fsr2', 'fsr3'],
    sourceResolution: {control: 'engine', heights: true, multipliers: [2]}, architecture: 'arm64', opaque: true};
  const warn = f.context.logger.warn;
  f.context.logger.warn = (...args) => {
    warn(...args);
    if (sink === 'throw') throw new Error('Warning observer failed');
    if (sink === 'reject') return Promise.reject(new Error('Warning observer failed'));
  };
  f.context.graphicsInputs = selected;
  Object.assign(f.entry, {reshade: {enabled: true, preset: 'crt'}, graphics: {temporalMethod: 'fsr2', spatialMethod: 'bilinear'}});
  const before = structuredClone(f.entry);
  const privateTarget = Graphics.prepare(f.entry, {...f, platform: 'darwin', version: '4.4', target: {kind: 'pack', path: f.input}}).target.path;
  fs.unlinkSync(privateTarget);fs.writeFileSync(privateTarget, 'unrelated existing file');
  fs.mkdirSync(path.join(f.root, 'effects'));
  for (const file of ['libreshade-macos.dylib', 'fx-compile', 'effects/crt.fx']) fs.writeFileSync(path.join(f.root, file), 'fixture');
  fs.writeFileSync(path.join(f.root, 'runtime.json'), JSON.stringify({schema: 1, version: 'test', minimumMacOS: '13.0',
    features: {shaders: {formats: ['fx']}, graphics: {effectPlanAPI: 1, spatialMethods: ['bilinear'],
      presentation: {hosts: {window: {spatial: true, resolutionMultipliers: [1, 2]}}}}}}));
  let environment;
  f.context.spawnDetachedChecked = async (...args) => {
    f.calls.push(args);
    // This is the real shared preparation called at the core spawn boundary;
    // only the compiler executable is replaced with filesystem outputs.
    environment = await require('../src/modules/shared/reshade').prepare(f.entry, {
      root: f.root, userDataDir: f.userDataDir, graphicsHost: 'window', graphicsInputs: f.context.graphicsInputs,
      diagnostics: false, gpuTiming: false, trace: false, verify: () => true, execute: async (_command, parameters) => {
        if (parameters[0] === '--prepare') fs.copyFileSync(parameters[1], parameters[2]);
        else for (const file of ['textures.json', 'uniforms.json']) fs.writeFileSync(path.join(parameters[1], file), '[]');
      }});
    return f.child;
  };
  assert.equal(await Godot.launchRuntime('godot', f.entry, f.context), f.child);
  const [command, args, options] = f.calls[0];
  assert.equal(command, f.executable);assert.deepEqual(args, ['--main-pack', f.input]);
  assert.equal(options.cwd, path.dirname(f.input));assert.equal(options.env, undefined);
  assert.deepEqual(f.context.graphicsInputs, {architecture: 'arm64', opaque: true});
  assert.equal(selected.cameraProjection, true);assert.equal(f.context.graphicsBridgeFailure.provider, 'godot');
  assert.match(f.warnings[0][0], /original game target/);assert.match(f.warnings[0][1], /unrelated file/);
  const document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.find(node => node.kind === 'temporal').enabled, false);
  assert.equal(document.nodes.find(node => node.kind === 'shader').enabled, true);
  assert.equal(document.nodes.find(node => node.kind === 'spatial').enabled, true);
  assert.deepEqual(f.entry, before);assert.equal(fs.readFileSync(privateTarget, 'utf8'), 'unrelated existing file');
  await new Promise(resolve => setImmediate(resolve));
 });
});

test('Godot missing temporal helper and project-cache preparation failures are optional at launch', async t => {
  const off = managedLaunch(t);fs.rmSync(path.join(off.root, 'godot'), {recursive: true});
  await Godot.launchRuntime('godot', off.entry, off.context);
  assert.deepEqual(off.calls[0][1], ['--main-pack', off.input]);assert.equal(off.warnings.length, 0);
  assert.equal(fs.existsSync(path.join(off.userDataDir, 'games')), false, 'no unavailable dormant bridge is staged for All off');
  const missing = managedLaunch(t);missing.entry.graphics.temporalMethod = 'fsr2';
  fs.rmSync(path.join(missing.root, 'godot'), {recursive: true});
  assert.equal(await Godot.launchRuntime('godot', missing.entry, missing.context), missing.child);
  assert.deepEqual(missing.calls[0][1], ['--main-pack', missing.input]);
  assert.match(missing.warnings[0][1], /missing from the graphics runtime/);
  const f = managedLaunch(t), project = path.join(f.directory, 'project');
  fs.mkdirSync(path.join(project, '.godot', 'imported'), {recursive: true});
  fs.writeFileSync(path.join(project, 'project.godot'), '[application]\nconfig/name="Original"\n');
  fs.writeFileSync(path.join(project, '.godot', 'imported', 'asset.ctex'), 'original cache');
  f.entry.moduleData.projectRoot = project;
  const prepared = Graphics.prepare(f.entry, {...f, platform: 'darwin', version: '4.4', target: {kind: 'project', path: project}});
  fs.rmSync(path.join(prepared.target.path, '.godot'), {recursive: true});
  fs.writeFileSync(path.join(prepared.target.path, '.godot'), 'unrelated existing cache');
  await Godot.launchRuntime('godot', f.entry, f.context);
  assert.deepEqual(f.calls[0][1], ['--path', project]);assert.equal(f.calls[0][2].env, undefined);
  assert.equal(fs.readFileSync(path.join(project, '.godot', 'imported', 'asset.ctex'), 'utf8'), 'original cache');
  assert.equal(fs.readFileSync(path.join(prepared.target.path, '.godot'), 'utf8'), 'unrelated existing cache');
});

test('Godot optional graphics fallback preserves cancellation and unrelated launch failures', async t => {
  const f = managedLaunch(t), failure = new Error('Game spawn failed');
  f.context.spawnDetachedChecked = async () => {throw failure;};
  await assert.rejects(Godot.launchRuntime('godot', f.entry, f.context), error => error === failure);
  assert.equal(f.warnings.length, 0);
  const abort = Object.assign(new Error('Cancelled'), {name: 'AbortError'});
  t.mock.method(Graphics, 'prepare', () => {throw abort;});
  await assert.rejects(Godot.launchRuntime('godot', f.entry, f.context), error => error === abort);
  assert.equal(f.warnings.length, 0);assert.equal(f.context.graphicsBridgeFailure, undefined);
  fs.rmSync(f.executable);
  await assert.rejects(Godot.launchRuntime('godot', f.entry, f.context), /Godot runtime v4\.4-stable is not installed/);
});

test('Godot pack bootstrap preserves the original pack and overrides, ready for live selection from off', t => {
  const f = fixture(t), input = path.join(f.directory, 'Original " game.pck');
  pack(input);
  const original = '[autoload]\nGameState="*res://state.gd"\n[application]\nconfig/name="Original"\n';
  fs.writeFileSync(path.join(f.directory, 'override.cfg'), original);
  const prepared = Graphics.prepare(f.entry, { ...f, platform: 'darwin', version: '4.4-stable', target: { kind: 'pack', path: input } });
  assert.equal(fs.realpathSync(prepared.target.path), input);
  assert.equal(fs.readFileSync(path.join(f.directory, 'override.cfg'), 'utf8'), original);
  const override = fs.readFileSync(path.join(prepared.directory, 'override.cfg'), 'utf8');
  assert.ok(override.startsWith(original));
  assert.match(override, /\[autoload\]\nMacLauncherTemporalCamera_/);
  assert.match(override, /autoload\.gd/);
  assert.ok(fs.existsSync(prepared.environment.MACLAUNCHER_GODOT_CAMERA_EXTENSION));
  assert.deepEqual(Graphics.prepare(f.entry, { ...f, platform: 'darwin', version: '4.4-stable', target: { kind: 'pack', path: input } }), prepared);
});

test('Godot project bootstrap isolates writable caches and preserves resources and autoloads', t => {
  const f = fixture(t), project = path.join(f.directory, 'project');
  fs.mkdirSync(path.join(project, '.godot', 'imported'), { recursive: true });
  fs.writeFileSync(path.join(project, 'project.godot'), '[autoload]\nState="*res://state.gd"\n');
  fs.writeFileSync(path.join(project, 'state.gd'), 'extends Node\n');
  fs.writeFileSync(path.join(project, '.godot', 'uid_cache.bin'), 'original');
  fs.writeFileSync(path.join(project, '.godot', 'imported', 'asset.ctex'), 'asset');
  const prepared = Graphics.prepare(f.entry, { ...f, platform: 'darwin', version: '4.5', target: { kind: 'project', path: project } });
  assert.equal(fs.realpathSync(path.join(prepared.target.path, 'project.godot')), path.join(project, 'project.godot'));
  const cache = path.join(prepared.target.path, '.godot', 'uid_cache.bin');
  assert.equal(fs.lstatSync(cache).isSymbolicLink(), false);
  fs.writeFileSync(cache, 'updated');
  assert.equal(fs.readFileSync(path.join(project, '.godot', 'uid_cache.bin'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(prepared.target.path, '.godot', 'imported', 'asset.ctex'), 'utf8'), 'asset');
  assert.equal(fs.existsSync(path.join(project, 'override.cfg')), false);
});

test('Godot Simple spatial scaling selects its engine filter without changing Advanced or neural ordering', t => {
  const f = fixture(t), input = path.join(f.directory, 'game.pck'); pack(input);
  const metadataFile = path.join(f.root, 'godot', 'provider.json'), metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, sourceResolutionAPI: 1 }));
  const prepare = (graphics, effects) => Graphics.prepare({ ...f.entry, graphics, effects },
    { ...f, platform: 'darwin', version: '4.6.3', target: { kind: 'pack', path: input } });
  for (const spatialMethod of ['bilinear', 'metalfx', 'fsr1'])
    assert.equal(prepare({ spatialMethod }).environment.MACLAUNCHER_GODOT_SPATIAL_METHOD, spatialMethod);
  for (const [graphics, effects] of [[{ spatialMethod: 'metalfx', neuralMethod: 'mlx-dlss' }],
    [{ spatialMethod: 'metalfx', temporalMethod: 'fsr2' }], [{ spatialMethod: 'nearest' }],
    [{ spatialMethod: 'metalfx' }, { version: 1, rows: [] }]])
    assert.equal(prepare(graphics, effects).environment.MACLAUNCHER_GODOT_SPATIAL_METHOD, undefined);
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  assert.equal(prepare({ spatialMethod: 'metalfx' }).environment.MACLAUNCHER_GODOT_SPATIAL_METHOD, undefined);
});

test('Godot preparation leaves unsupported runtimes alone and requires the helper for a selected temporal method', t => {
  const f = fixture(t);
  assert.equal(Graphics.prepare(f.entry, { ...f, version: '4.3', platform: 'darwin' }), null);
  assert.equal(Graphics.prepare(f.entry, { ...f, version: '4.4', platform: 'linux' }), null);
  fs.rmSync(path.join(f.root, 'godot'), { recursive: true });
  assert.equal(Graphics.prepare(f.entry, { ...f, version: '4.4', platform: 'darwin' }), null);
  f.entry.graphics.temporalMethod = 'fsr2';
  assert.throws(() => Graphics.prepare(f.entry, { ...f, version: '4.4', platform: 'darwin' }), /missing from the graphics runtime/);
});

test('Godot camera capability requires the selected installed runtime, existing game and helper', t => {
  const f = fixture(t), input = path.join(f.directory, 'game.pck'); pack(input);
  f.entry.moduleData = { packPath: input, detectedVersion: '4.4.0', detectedMajor: 4 };
  const context = { userDataDir: f.userDataDir, graphicsRoot: f.root, platform: 'darwin', settings: { runtimes: { godot: {} } } };
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context), null);
  const app = path.join(f.userDataDir, 'runtimes', 'godot', '4.4-stable', 'mono', 'Godot.app');
  installGodotFixture(app);
  assert.deepEqual(Godot.resolveGraphicsInputs(f.entry, context), { cameraProjection: true, source: 'godot', methods: ['fsr2', 'fsr3'] });
  assert.deepEqual(Godot.actions.runtimeStatus(f.entry, {}, context).graphicsInputs, Godot.resolveGraphicsInputs(f.entry, context));
  const metadataFile = path.join(f.root, 'godot', 'provider.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, sourceResolutionAPI: 1 }));
  assert.equal(Graphics.resolve(f.root).sourceResolutionAPI, 1);
  assert.deepEqual(Godot.resolveGraphicsInputs(f.entry, context).sourceResolution,
    { heights: true, multipliers: [1, 1.5, 2, 3], methods: ['bilinear', 'metalfx', 'fsr1'], control: 'engine' });
  fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, sourceResolutionAPI: 2 }));
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context).sourceResolution, undefined);
  assert.equal(Godot.resolveGraphicsInputs(f.entry, { ...context, runtimeId: 'native' }), null);
  fs.rmSync(input);
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context), null);
});

test('Godot live source capability requires the installed versioned helper and its recorded hash', t => {
  const f = fixture(t), input = path.join(f.directory, 'game.pck');pack(input);
  f.entry.moduleData = {packPath: input, detectedVersion: '4.4.0', detectedMajor: 4};
  const app = path.join(f.userDataDir, 'runtimes', 'godot', '4.4-stable', 'mono', 'Godot.app');
  installGodotFixture(app);
  const metadataFile = path.join(f.root, 'godot', 'provider.json');
  const metadata = {...JSON.parse(fs.readFileSync(metadataFile, 'utf8')), sourceResolutionAPI: 1, sourceResolutionLiveAPI: 1};
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  assert.equal(Graphics.resolve(f.root).sourceResolutionLiveAPI, 0);
  const script = fs.readFileSync(require.resolve('../src/modules/godot/graphics/autoload.gd'));
  fs.writeFileSync(path.join(f.root, 'godot', 'autoload.gd'), script);
  metadata.ownedSourceSha256 = {'autoload.gd': crypto.createHash('sha256').update(script).digest('hex')};
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  const context = {userDataDir: f.userDataDir, graphicsRoot: f.root, platform: 'darwin', settings: {runtimes: {godot: {}}}};
  assert.equal(Graphics.resolve(f.root).sourceResolutionLiveAPI, 1);
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context).sourceResolution.live, true);
  fs.appendFileSync(path.join(f.root, 'godot', 'autoload.gd'), '# changed\n');
  assert.equal(Graphics.resolve(f.root).sourceResolutionLiveAPI, 0);
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context).sourceResolution.live, undefined);
});

test('Godot headless source control parses, follows extent changes and restores only owned scales', t => {
  const engine = process.env.MACLAUNCHER_TEST_GODOT || path.join(os.homedir(), 'Library', 'Application Support', 'maclauncher',
    'runtimes', 'godot', '4.6.3-stable', 'mono', 'Godot_mono.app', 'Contents', 'MacOS', 'Godot');
  if (!fs.existsSync(engine)) { t.skip('A local Godot runtime is required for GDScript execution.'); return; }
  const f = fixture(t);
  fs.copyFileSync(require.resolve('../src/modules/godot/graphics/autoload.gd'), path.join(f.directory, 'autoload.gd'));
  fs.writeFileSync(path.join(f.directory, 'project.godot'), '[application]\nconfig/name="GodotSourceControl"\n[debug]\nfile_logging/enable_file_logging=false\n');
  fs.writeFileSync(path.join(f.directory, 'helper.gd'), 'extends "res://autoload.gd"\nvar extent := Vector2(1920, 1080)\nfunc _ready() -> void:\n\tset_process(false)\nfunc _source_extent(_viewport: Viewport) -> Vector2:\n\treturn extent\nfunc _source_rendering_method() -> String:\n\treturn "forward_plus"\nfunc _source_driver() -> String:\n\treturn "metal"\n');
  fs.writeFileSync(path.join(f.directory, 'verify.gd'), String.raw`extends SceneTree
class InactiveBridge:
	extends RefCounted
	var checks := 0
	func method() -> int:
		checks += 1
		return 0
func close_to(actual: float, expected: float) -> void:
	assert(absf(actual - expected) < 0.00001, str(actual) + " != " + str(expected))
func _initialize() -> void:
	call_deferred("verify")
func source_command(helper: Node, epoch: int, revision: String, source: Variant, launch_id: String = "source-test") -> void:
	var record := {"schema": 1, "launchId": launch_id, "epoch": epoch, "revision": revision.repeat(64), "control": "engine", "source": source}
	var output := FileAccess.open(helper.source_control_file + ".next", FileAccess.WRITE)
	output.store_string(JSON.stringify(record))
	output.close()
	assert(DirAccess.rename_absolute(helper.source_control_file + ".next", helper.source_control_file) == OK)
	helper._poll_source_control()
func verify() -> void:
	for key in ["RESHADE_RENDER_SOURCE_CONTROL", "RESHADE_RENDER_HEIGHT", "RESHADE_RENDER_MAX_HEIGHT", "RESHADE_RENDER_MULTIPLIER", "RESHADE_RENDER_SOURCE_METHOD", "MACLAUNCHER_GODOT_SPATIAL_METHOD", "RESHADE_RENDER_SOURCE_CONTROL_FILE", "RESHADE_RENDER_SOURCE_STATUS_FILE", "RESHADE_RENDER_SOURCE_LAUNCH_ID"]:
		OS.set_environment(key, "")
	var idle = load("res://autoload.gd").new()
	root.add_child(idle)
	assert(not idle.source_control_enabled and not idle.is_processing())
	idle.free()
	var helper = load("res://helper.gd").new()
	root.add_child(helper)
	# A live-capable bootstrap is not an enabled camera effect. Exercise the
	# actual inactive process path with existing game viewport/compositor state.
	var inactive_viewport := SubViewport.new()
	root.add_child(inactive_viewport)
	var inactive_camera := Camera3D.new()
	inactive_viewport.add_child(inactive_camera)
	var original_compositor := Compositor.new()
	inactive_camera.compositor = original_compositor
	inactive_viewport.scaling_3d_scale = 0.7
	inactive_viewport.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR
	var inactive_bridge := InactiveBridge.new()
	helper.bridge = inactive_bridge
	helper.viewports.append(weakref(inactive_viewport))
	helper._process(0.0)
	assert(inactive_bridge.checks == 1 and helper.bindings.is_empty())
	assert(inactive_camera.compositor == original_compositor)
	close_to(inactive_viewport.scaling_3d_scale, 0.7)
	assert(inactive_viewport.scaling_3d_mode == Viewport.SCALING_3D_MODE_FSR)
	helper.bridge = null
	inactive_viewport.free()
	OS.set_environment("RESHADE_RENDER_SOURCE_CONTROL", "engine")
	OS.set_environment("RESHADE_RENDER_HEIGHT", "480")
	helper._configure_source_control("mobile")
	assert(helper.source_control_enabled)
	helper._configure_source_control("gl_compatibility")
	assert(not helper.source_control_enabled)
	helper._configure_source_control("forward_plus")
	OS.set_environment("MACLAUNCHER_GODOT_SPATIAL_METHOD", "fsr1")
	OS.set_environment("RESHADE_RENDER_SOURCE_METHOD", "bilinear")
	helper._configure_source_control("forward_plus")
	assert(helper.source_spatial_method == "bilinear")
	OS.set_environment("RESHADE_RENDER_SOURCE_METHOD", "")
	helper._configure_source_control("forward_plus")
	assert(helper.source_spatial_method == "fsr1")
	OS.set_environment("MACLAUNCHER_GODOT_SPATIAL_METHOD", "")
	helper._configure_source_control("forward_plus")
	helper.source_spatial_method = "metalfx"
	assert(helper._source_scaling_mode("metal") == Viewport.SCALING_3D_MODE_METALFX_SPATIAL)
	assert(helper._source_scaling_mode("vulkan") == -1)
	helper.source_spatial_method = "fsr1"
	assert(helper._source_scaling_mode("metal") == Viewport.SCALING_3D_MODE_FSR)
	helper.source_spatial_method = "bilinear"
	assert(helper._source_scaling_mode("metal") == Viewport.SCALING_3D_MODE_BILINEAR)
	close_to(helper._source_scale(Vector2(1920, 1080), 0.8), 480.0 / 1080.0)
	close_to(helper._source_scale(Vector2(320, 200), 0.8), 1.0)
	helper.source_height = 1
	close_to(helper._source_scale(Vector2(1920, 1080), 1.0), 0.1)
	helper.source_height = 0
	helper.source_max_height = 480
	close_to(helper._source_scale(Vector2(1920, 1080), 0.25), 0.25)
	close_to(helper._source_scale(Vector2(1920, 1080), 1.5), 480.0 / 1080.0)
	helper.source_max_height = 0
	helper.source_multiplier = 2.0
	close_to(helper._source_scale(Vector2(1920, 1080), 0.8), 0.5)
	close_to(helper._source_scale(Vector2(1920, 1080), 0.25), 0.25)
	helper.source_multiplier = 3.0
	close_to(helper._source_scale(Vector2(600, 1000), 1.0), 0.334)
	helper.source_multiplier = 0.0
	helper.source_height = 480
	var camera := Camera3D.new()
	root.add_child(camera)
	camera.make_current()
	var child_viewport := SubViewport.new()
	child_viewport.scaling_3d_scale = 0.7
	root.add_child(child_viewport)
	var original_window_size := root.size
	root.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR
	root.scaling_3d_scale = 0.8
	helper._sync_source_resolution()
	close_to(root.scaling_3d_scale, 480.0 / 1080.0)
	close_to(child_viewport.scaling_3d_scale, 0.7)
	assert(root.size == original_window_size)
	assert(root.scaling_3d_mode == Viewport.SCALING_3D_MODE_BILINEAR)
	root.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR
	helper._sync_source_resolution()
	assert(helper.source_original_mode == Viewport.SCALING_3D_MODE_FSR)
	helper.bindings = {123: {}}
	helper._sync_source_mode(root)
	assert(root.scaling_3d_mode == Viewport.SCALING_3D_MODE_FSR)
	helper.bindings.clear()
	helper.extent = Vector2(3840, 2160)
	helper._sync_source_resolution()
	close_to(root.scaling_3d_scale, 480.0 / 2160.0)
	root.scaling_3d_scale = 0.6
	helper._sync_source_resolution()
	root.disable_3d = true
	helper._sync_source_resolution()
	close_to(root.scaling_3d_scale, 0.6)
	assert(root.scaling_3d_mode == Viewport.SCALING_3D_MODE_FSR)
	root.disable_3d = false
	helper._sync_source_resolution()
	root.scaling_3d_scale = 0.9
	helper._restore_source_resolution()
	close_to(root.scaling_3d_scale, 0.9)
	helper._sync_source_resolution()
	OS.set_environment("RESHADE_RENDER_SOURCE_CONTROL", "")
	helper._sync_source_resolution()
	close_to(root.scaling_3d_scale, 0.9)
	OS.set_environment("RESHADE_RENDER_SOURCE_CONTROL", "engine")
	helper._sync_source_resolution()
	helper.free()
	close_to(root.scaling_3d_scale, 0.9)
	OS.set_environment("RESHADE_RENDER_SOURCE_CONTROL", "")
	OS.set_environment("RESHADE_RENDER_SOURCE_CONTROL_FILE", ProjectSettings.globalize_path("res://source-control.json"))
	OS.set_environment("RESHADE_RENDER_SOURCE_STATUS_FILE", ProjectSettings.globalize_path("res://source-status.json"))
	OS.set_environment("RESHADE_RENDER_SOURCE_LAUNCH_ID", "source-test")
	root.scaling_3d_scale = 0.8
	root.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR
	var dormant = load("res://helper.gd").new()
	root.add_child(dormant)
	dormant._configure_live_source_control()
	source_command(dormant, 1, "0", null)
	close_to(root.scaling_3d_scale, 0.8)
	assert(root.scaling_3d_mode == Viewport.SCALING_3D_MODE_FSR and not dormant.is_processing())
	dormant.free()
	assert(DirAccess.remove_absolute(OS.get_environment("RESHADE_RENDER_SOURCE_CONTROL_FILE")) == OK)
	var live = load("res://helper.gd").new()
	root.add_child(live)
	live._configure_live_source_control()
	assert(not live.is_processing() and not live.source_control_enabled)
	root.scaling_3d_scale = 0.8
	root.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR
	source_command(live, 1, "a", {"multiplier": 2, "method": "fsr1"})
	assert(live.source_epoch == 1 and live.is_processing())
	close_to(root.scaling_3d_scale, 0.5)
	assert(root.scaling_3d_mode == Viewport.SCALING_3D_MODE_FSR and root.size == original_window_size)
	var status: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(live.source_status_file))
	assert(status.epoch == 1 and status.requested.multiplier == 2 and status.applied.scale == 0.5 and status.applied.viewportHeight == 1080)
	var unchanged_status: String = live.source_last_status
	for iteration in range(20):
		live._sync_source_resolution()
	assert(live.source_last_status == unchanged_status)
	source_command(live, 1, "a", {"height": 100})
	close_to(root.scaling_3d_scale, 0.5)
	source_command(live, 1, "b", {"height": 100})
	assert(live.source_epoch == 1 and not live.source_control_error.is_empty())
	source_command(live, 2, "b", {"height": 360, "maximum": true, "method": "bilinear"})
	close_to(root.scaling_3d_scale, 1.0 / 3.0)
	assert(live.source_control_error.is_empty())
	root.scaling_3d_scale = 0.2
	live._sync_source_resolution()
	close_to(root.scaling_3d_scale, 0.2)
	source_command(live, 3, "c", {"multiplier": 2})
	close_to(root.scaling_3d_scale, 0.2)
	root.scaling_3d_scale = 0.6
	live._sync_source_resolution()
	close_to(root.scaling_3d_scale, 0.5)
	source_command(live, 4, "d", null)
	close_to(root.scaling_3d_scale, 0.6)
	assert(not live.is_processing() and not live.source_control_enabled)
	status = JSON.parse_string(FileAccess.get_file_as_string(live.source_status_file))
	assert(status.epoch == 4 and status.requested == null and status.applied == null)
	source_command(live, 5, "e", {"height": 1})
	close_to(root.scaling_3d_scale, 0.1)
	source_command(live, 4, "d", null)
	assert(live.source_epoch == 5)
	source_command(live, 6, "f", null, "another-launch")
	assert(live.source_epoch == 5)
	var malformed := FileAccess.open(live.source_control_file, FileAccess.WRITE)
	malformed.store_string("{}")
	malformed.close()
	live._poll_source_control()
	close_to(root.scaling_3d_scale, 0.1)
	assert(live.source_epoch == 5)
	source_command(live, 6, "f", null)
	close_to(root.scaling_3d_scale, 0.6)
	assert(root.size == original_window_size)
	close_to(child_viewport.scaling_3d_scale, 0.7)
	live.free()
	camera.free()
	child_viewport.free()
	print("GODOT_SOURCE_CONTROL_OK")
	quit(0)
`);
  const result = spawnSync(engine, ['--headless', '--path', f.directory, '--log-file', path.join(f.directory, 'godot.log'),
    '--script', 'res://verify.gd'], { encoding: 'utf8', timeout: 20000, env: { ...process.env } });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /GODOT_SOURCE_CONTROL_OK/);
  assert.doesNotMatch(result.stderr, /SCRIPT ERROR|Parse Error/);
});

test('Native Godot apps use their pack version and keep the executable and bundle unchanged', t => {
  const f = fixture(t), app = path.join(f.directory, 'Original.app'), input = path.join(app, 'Contents', 'Resources', 'Original.pck');
  pack(input);
  f.entry.gamePath = app;
  f.entry.moduleData = { packPath: input, detectedVersion: '4.4.0', projectRoot: '/unused/recovered/project' };
  const context = { userDataDir: f.userDataDir, graphicsRoot: f.root, platform: 'darwin', runtimeId: 'native' };
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context).source, 'godot');
  const before = fs.readFileSync(input);
  const prepared = Godot.prepareNativeLaunch(f.entry, context, { appPath: app, executable: '/original/executable' });
  assert.equal(prepared.args[0], '--main-pack');
  assert.equal(fs.realpathSync(prepared.args[1]), input);
  assert.deepEqual(fs.readFileSync(input), before);
  assert.equal(fs.existsSync(path.join(app, 'Contents', 'Resources', 'override.cfg')), false);
  assert.equal(prepared.executable, undefined);
  pack(input, 3);
  assert.equal(Godot.resolveGraphicsInputs(f.entry, context), null);
  assert.equal(Godot.prepareNativeLaunch(f.entry, context), null);
});

test('Native Godot graphics overlay failure retains the publisher app launch', t => {
  const f = fixture(t), app = path.join(f.directory, 'Original.app'), input = path.join(app, 'Contents', 'Resources', 'Original.pck');
  pack(input);f.entry.gamePath = app;f.entry.moduleData = {packPath: input};
  const prepared = Graphics.prepare(f.entry, {...f, platform: 'darwin', version: '4.4', target: {kind: 'pack', path: input}});
  fs.unlinkSync(prepared.target.path);fs.writeFileSync(prepared.target.path, 'unrelated file');
  const warnings = [], context = {userDataDir: f.userDataDir, graphicsRoot: f.root, platform: 'darwin', runtimeId: 'native',
    graphicsInputs: {source: 'godot', cameraProjection: true, methods: ['fsr2'], architecture: 'arm64'},
    logger: {warn: (...args) => warnings.push(args)}};
  assert.equal(Godot.prepareNativeLaunch(f.entry, context), null);
  assert.deepEqual(context.graphicsInputs, {architecture: 'arm64'});assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(prepared.target.path, 'utf8'), 'unrelated file');assert.equal(fs.existsSync(path.join(app, 'Contents', 'Resources', 'override.cfg')), false);
  assert.deepEqual(fs.readFileSync(input).subarray(0, 4), Buffer.from('GDPC'));
});
