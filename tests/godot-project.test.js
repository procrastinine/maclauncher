const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Project = require('../src/modules/godot/project');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-project-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const source = path.join(directory, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Game"\n');
  fs.writeFileSync(path.join(source, 'asset.png'), 'original asset');
  fs.writeFileSync(path.join(source, 'asset.png.import'), 'original import options');
  const entry = {gameId: 'project'};
  const options = {target: {kind: 'project', path: source}, executable: '/managed/Godot', version: '4.6.3-stable',
    userDataDir: path.join(directory, 'data')};
  return {directory, source, entry, options};
}
function imported(project) {
  fs.mkdirSync(path.join(project, '.godot', 'imported'), {recursive: true});
  fs.writeFileSync(path.join(project, '.godot', 'imported', 'asset.ctex'), fs.readFileSync(path.join(project, 'asset.png')));
}

test('source project imports use a writable private clone, preserve originals and reuse the completed cache', async t => {
  const f = fixture(t); let calls = 0;
  const run = async (_executable, project, options) => {
    calls++; assert.notEqual(project, f.source); assert.ok(options.env.HOME.startsWith(fs.realpathSync(f.options.userDataDir) + path.sep));
    imported(project); fs.writeFileSync(path.join(project, 'asset.png.import'), 'generated import');
  };
  const first = await Project.prepare(f.entry, {...f.options, run});
  assert.notEqual(first.path, f.source);
  assert.equal(fs.readFileSync(path.join(f.source, 'asset.png.import'), 'utf8'), 'original import options');
  assert.equal(fs.existsSync(path.join(f.source, '.godot')), false);
  assert.equal(fs.readFileSync(path.join(first.path, '.godot', 'imported', 'asset.ctex'), 'utf8'), 'original asset');
  assert.deepEqual(await Project.prepare(f.entry, {...f.options, run}), first);
  assert.equal(calls, 1, 'warm launch must not run another editor');
});

test('asset updates reimport; failed replacements retain the previous complete cache and can retry', async t => {
  const f = fixture(t);
  const first = await Project.prepare(f.entry, {...f.options, run: async (_, project) => imported(project)});
  fs.writeFileSync(path.join(f.source, 'asset.png'), 'updated asset bytes');
  const failure = new Error('import failed');
  await assert.rejects(Project.prepare(f.entry, {...f.options, run: async () => {throw failure;}}), error => error === failure);
  assert.equal(fs.readFileSync(path.join(first.path, '.godot', 'imported', 'asset.ctex'), 'utf8'), 'original asset');
  const updated = await Project.prepare(f.entry, {...f.options, run: async (_, project) => imported(project)});
  assert.equal(updated.path, first.path);
  assert.equal(fs.readFileSync(path.join(updated.path, '.godot', 'imported', 'asset.ctex'), 'utf8'), 'updated asset bytes');
});

test('already imported source projects and exported packs skip preparation and tool work', async t => {
  const f = fixture(t), forbidden = () => {throw Error('unexpected import');};
  imported(f.source);
  assert.equal(await Project.prepare(f.entry, {...f.options, run: forbidden}), f.options.target);
  const pack = {kind: 'pack', path: '/unchanged.pck'};
  assert.equal(await Project.prepare(f.entry, {target: pack, run: forbidden}), pack);
  assert.equal(fs.existsSync(f.options.userDataDir), false);
});

test('empty resource directories are imported again and cannot be accepted as a completed cache', async t => {
  const f = fixture(t); let calls = 0;
  fs.mkdirSync(path.join(f.source, '.godot', 'imported'), {recursive: true});
  fs.writeFileSync(path.join(f.source, '.godot', 'global_script_class_cache.cfg'), 'list=Array[Dictionary]([])\n');
  await assert.rejects(Project.prepare(f.entry, {...f.options, run: async (_, project) => {
    calls++; fs.mkdirSync(path.join(project, '.godot', 'imported'), {recursive: true});
  }}), /did not create the project resource cache/);
  const prepared = await Project.prepare(f.entry, {...f.options, run: async (_, project) => {calls++; imported(project);}});
  fs.rmSync(path.join(prepared.path, '.godot', 'imported', 'asset.ctex'));
  await Project.prepare(f.entry, {...f.options, run: async (_, project) => {calls++; imported(project);}});
  assert.equal(calls, 3, 'an empty source or previously accepted cache must not skip import');
  assert.deepEqual(fs.readdirSync(path.join(f.source, '.godot', 'imported')), []);
});

test('contained source links become writable regular private files without changing source modes', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, 'assets'));
  const original = path.join(f.source, 'assets', 'image.png');
  fs.writeFileSync(original, 'linked image', {mode: 0o444});
  fs.symlinkSync('assets', path.join(f.source, 'alias'));
  const mode = fs.statSync(original).mode;
  const prepared = await Project.prepare(f.entry, {...f.options, run: async (_, project) => {
    assert.equal(fs.lstatSync(path.join(project, 'alias')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(project, 'alias', 'image.png'), 'utf8'), 'linked image');
    fs.writeFileSync(path.join(project, 'alias', 'image.png'), 'private update');
    imported(project);
  }});
  assert.equal(fs.statSync(original).mode, mode);
  assert.equal(fs.readFileSync(original, 'utf8'), 'linked image');
  assert.equal(fs.readFileSync(path.join(prepared.path, 'alias', 'image.png'), 'utf8'), 'private update');
});

test('cyclic and external source links fail before copying or starting the editor', async t => {
  const f = fixture(t), forbidden = () => {throw Error('editor must not start');};
  const link = path.join(f.source, 'linked');
  fs.symlinkSync('.', link);
  await assert.rejects(Project.prepare(f.entry, {...f.options, run: forbidden}), /cyclic directory link/);
  fs.unlinkSync(link);
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'preserved'), 'outside project');
  fs.symlinkSync(outside, link);
  await assert.rejects(Project.prepare(f.entry, {...f.options, run: forbidden}), /links must stay inside the project/);
  assert.equal(fs.existsSync(f.options.userDataDir), false);
  assert.equal(fs.readFileSync(path.join(outside, 'preserved'), 'utf8'), 'outside project');
});

test('a private storage alias into the original project is rejected before any write', async t => {
  const f = fixture(t);
  fs.symlinkSync(f.source, f.options.userDataDir);
  await assert.rejects(Project.prepare(f.entry, {...f.options, run: () => assert.fail('unexpected import')}),
    /storage must be outside the original project/);
  assert.deepEqual(fs.readdirSync(f.source).sort(), ['asset.png', 'asset.png.import', 'project.godot']);
});

test('actual import subprocess receives no graphics injection and is registered as a temporary tool', async t => {
  const f = fixture(t), executable = path.join(f.directory, 'importer');
  fs.writeFileSync(executable, '#!/usr/bin/env node\nconst fs=require("fs"),path=require("path");const p=process.argv[process.argv.indexOf("--path")+1];fs.mkdirSync(path.join(p,".godot"),{recursive:true});fs.writeFileSync(path.join(p,"tool.json"),JSON.stringify({args:process.argv.slice(2),env:process.env}));\n', {mode: 0o755});
  const env = Project.toolEnvironment({PATH: process.env.PATH, DYLD_INSERT_LIBRARIES: 'forbidden', RESHADE_FLAGS: '8',
    MACLAUNCHER_GODOT_CAMERA_EXTENSION: 'forbidden', NODE_OPTIONS: '--require=forbidden', RETAIN: 'yes'});
  let registered;
  await Project.runImport(executable, f.source, {env, logFile: path.join(f.directory, 'import.log'),
    onToolProcessSpawn: (child, options) => {registered = {pid: child.pid, options};}});
  const observed = JSON.parse(fs.readFileSync(path.join(f.source, 'tool.json')));
  assert.deepEqual(observed.args, ['--headless', '--editor', '--path', f.source, '--import']);
  assert.equal(observed.env.RETAIN, 'yes');
  assert.equal(Object.keys(observed.env).some(k => /^(DYLD_|RESHADE_|MACLAUNCHER_)/.test(k) || k === 'NODE_OPTIONS'), false);
  assert.ok(registered.pid > 0); assert.deepEqual(registered.options, {stopOnLauncherExit: true});
});

test('cancellation stops the actual owned import subprocess before a complete cache can be accepted', async t => {
  const f = fixture(t), executable = path.join(f.directory, 'slow-importer'), controller = new AbortController();
  fs.writeFileSync(executable, '#!/usr/bin/env node\nsetTimeout(()=>{},30000);\n', {mode: 0o755});
  const reason = new Error('Stopped'); let child;
  await assert.rejects(Project.runImport(executable, f.source, {signal: controller.signal, env: Project.toolEnvironment(),
    logFile: path.join(f.directory, 'import.log'), onToolProcessSpawn: value => {
      child = value; setTimeout(() => controller.abort(reason), 30);
    }}), error => error === reason);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(fs.existsSync(path.join(f.source, '.godot')), false);
});

test('asynchronous stop failure is contained, cancellation is preserved and actual child close is awaited', async t => {
  const f = fixture(t), executable = path.join(f.directory, 'slow-importer'), controller = new AbortController();
  fs.writeFileSync(executable, '#!/usr/bin/env node\nsetTimeout(()=>{},30000);\n', {mode: 0o755});
  const reason = new Error('Stopped'); let child;
  await assert.rejects(Project.runImport(executable, f.source, {signal: controller.signal, env: Project.toolEnvironment(),
    logFile: path.join(f.directory, 'import.log'), stop: async () => {throw new Error('stop request failed');},
    onToolProcessSpawn: value => {child = value; controller.abort(reason);}
  }), error => error === reason);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
