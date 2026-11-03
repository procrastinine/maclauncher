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

test('fresh source projects import in place with their original data and ordinary environment', async t => {
  const f = fixture(t);let calls = 0;
  const run = async (executable, project, options) => {
    calls++;assert.equal(executable, f.options.executable);assert.equal(project, f.source);
    assert.equal(options.env.HOME, process.env.HOME);assert.equal(options.env.XDG_DATA_HOME, process.env.XDG_DATA_HOME);assert.equal(options.env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME);
    assert.equal(options.logFile, undefined);imported(project);fs.writeFileSync(path.join(project, 'asset.png.import'), 'upstream generated import');
  };
  assert.equal(await Project.prepare(f.entry, {...f.options, run}), f.options.target);
  assert.equal(fs.readFileSync(path.join(f.source, 'asset.png'), 'utf8'), 'original asset');
  assert.equal(fs.readFileSync(path.join(f.source, 'asset.png.import'), 'utf8'), 'upstream generated import');
  assert.equal(fs.readFileSync(path.join(f.source, '.godot/imported/asset.ctex'), 'utf8'), 'original asset');
  assert.equal(await Project.prepare(f.entry, {...f.options, run}), f.options.target);assert.equal(calls, 1);
  assert.equal(fs.existsSync(f.options.userDataDir), false, 'no private game, editor home or receipt is created');
});
test('warm original-path preparation reads no assets, walks no tree and copies nothing', async t => {
  const f = fixture(t);imported(f.source);
  const read = fs.readFileSync, walk = fs.readdirSync, asyncWalk = fs.promises.readdir, copy = fs.copyFileSync, realpath = fs.realpathSync, open = fs.opendirSync;let opened = 0;
  try {
    fs.readFileSync = () => assert.fail('Warm Play must not read source resources or mirror receipts');
    fs.readdirSync = () => assert.fail('Warm Play must not enumerate a complete asset/cache directory');
    fs.promises.readdir = async () => assert.fail('Warm Play must not walk source resources');
    fs.copyFileSync = () => assert.fail('Warm Play must not copy assets');fs.realpathSync = () => assert.fail('Selected original paths must remain unchanged');
    fs.opendirSync = function(file, ...args) {assert.equal(file, path.join(f.source, '.godot/imported'));opened++;return open.call(this, file, ...args);};
    assert.equal(await Project.prepare(f.entry, {...f.options, run: () => assert.fail('Warm Play must not run an editor')}), f.options.target);
  } finally {fs.readFileSync = read;fs.readdirSync = walk;fs.promises.readdir = asyncWalk;fs.copyFileSync = copy;fs.realpathSync = realpath;fs.opendirSync = open;}
  assert.equal(opened, 1);
});
test('failed imports preserve existing original data and all old private generations', async t => {
  const f = fixture(t), old = path.join(f.options.userDataDir, 'games/project/modules/godot/source-projects/01234567890123456789');
  for (const directory of ['project', 'previous', 'preparing-1234567890123456', 'editor-home']) {fs.mkdirSync(path.join(old, directory), {recursive: true});fs.writeFileSync(path.join(old, directory, 'Save.cfg'), directory + ' retained save');}
  fs.writeFileSync(path.join(old, 'prepared.json'), JSON.stringify({schema: 1, source: f.source, input: 'legacy', version: f.options.version}));fs.writeFileSync(path.join(old, 'import.log'), 'legacy log');
  const error = Error('upstream import failed'), read = fs.readFileSync, walk = fs.readdirSync;
  try {
    fs.readFileSync = function(file, ...args) {assert.ok(!String(file).includes('source-projects'));return read.call(this, file, ...args);};
    fs.readdirSync = function(file, ...args) {assert.ok(!String(file).includes('source-projects'));return walk.call(this, file, ...args);};
    await assert.rejects(Project.prepare(f.entry, {...f.options, run: async (_executable, project) => {assert.equal(project, f.source);throw error;}}), value => value === error);
  } finally {fs.readFileSync = read;fs.readdirSync = walk;}
  assert.equal(fs.readFileSync(path.join(f.source, 'asset.png'), 'utf8'), 'original asset');assert.equal(fs.readFileSync(path.join(f.source, 'asset.png.import'), 'utf8'), 'original import options');
  for (const directory of ['project', 'previous', 'preparing-1234567890123456', 'editor-home']) assert.equal(fs.readFileSync(path.join(old, directory, 'Save.cfg'), 'utf8'), directory + ' retained save');
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'prepared.json'))).input, 'legacy');assert.equal(fs.readFileSync(path.join(old, 'import.log'), 'utf8'), 'legacy log');
  assert.equal(await Project.prepare(f.entry, {...f.options, run: async (_executable, project) => imported(project)}), f.options.target);
});
test('packed games and other major versions never inspect or prepare source projects', async t => {
  const f = fixture(t), forbidden = () => assert.fail('No importer should run');
  const pack = {kind: 'pack', path: '/unchanged.pck'};
  assert.equal(await Project.prepare(f.entry, {target: pack, run: forbidden}), pack);
  assert.equal(await Project.prepare(f.entry, {...f.options, version: '3.5.2-stable', run: forbidden}), f.options.target);
  assert.equal(fs.existsSync(f.options.userDataDir), false);
});
test('script-only projects reuse the upstream completed editor index, not a lone class index', async t => {
  const f = fixture(t);let calls = 0;
  fs.mkdirSync(path.join(f.source, '.godot'), {recursive: true});fs.writeFileSync(path.join(f.source, '.godot/global_script_class_cache.cfg'), 'list=Array[Dictionary]([])\n');
  const run = async (_executable, project) => {calls++;fs.mkdirSync(path.join(project, '.godot/editor'), {recursive: true});fs.writeFileSync(path.join(project, '.godot/editor/filesystem_cache10'), 'completed upstream index\n');};
  assert.equal(await Project.prepare(f.entry, {...f.options, run}), f.options.target);
  assert.equal(await Project.prepare(f.entry, {...f.options, run}), f.options.target);assert.equal(calls, 1);
});
test('an empty imported directory still triggers import without requiring invented output files', async t => {
  const f = fixture(t);fs.mkdirSync(path.join(f.source, '.godot/imported'), {recursive: true});let calls = 0;
  assert.equal(await Project.prepare(f.entry, {...f.options, run: async () => {calls++;}}), f.options.target, 'a successful upstream import is authoritative');
  assert.equal(calls, 1);
});
test('original selected paths and publisher links remain intact without a private projection', async t => {
  const f = fixture(t), selected = path.join(f.directory, 'selected-project'), outside = path.join(f.directory, 'outside');
  fs.symlinkSync(f.source, selected);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside, 'asset.txt'), 'external publisher asset');
  fs.symlinkSync(outside, path.join(f.source, 'publisher-link'));fs.symlinkSync('.', path.join(f.source, 'cycle'));
  const target = {kind: 'project', path: selected};
  assert.equal(await Project.prepare(f.entry, {...f.options, target, run: async (_executable, project) => {
    assert.equal(project, selected);assert.equal(fs.lstatSync(path.join(project, 'publisher-link')).isSymbolicLink(), true);imported(project);
  }}), target);
  assert.equal(fs.readFileSync(path.join(outside, 'asset.txt'), 'utf8'), 'external publisher asset');
  assert.equal(fs.readlinkSync(path.join(f.source, 'cycle')), '.');assert.equal(fs.existsSync(f.options.userDataDir), false);
});
test('original-path preparation respects cancellation before and after its owned importer', async t => {
  const f = fixture(t), controller = new AbortController(), reason = Error('cancelled');controller.abort(reason);
  await assert.rejects(Project.prepare(f.entry, {...f.options, signal: controller.signal, run: () => assert.fail('must not start')}), value => value === reason);
  const during = new AbortController();
  await assert.rejects(Project.prepare(f.entry, {...f.options, signal: during.signal, run: async (_executable, project) => {assert.equal(project, f.source);during.abort(reason);}}), value => value === reason);
  assert.equal(fs.existsSync(f.options.userDataDir), false);
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
