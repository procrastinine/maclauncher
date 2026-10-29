const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourceDirectory = path.resolve(__dirname, '../src/modules/renpy');
const walkthroughFiles = ['urw_core.rpy', 'urw_processor.rpy', 'urw_screens.rpy', 'urw_updater.rpy', 'urw_utils.rpy'];

function load(file, { packaged, resourcesPath, moduleDirectory = sourceDirectory }) {
  const filename = path.join(sourceDirectory, file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: createRequire(filename), __dirname: moduleDirectory, Buffer, console,
    process: { versions: packaged ? { electron: '40.0.0' } : {}, defaultApp: !packaged,
      resourcesPath, env: process.env, platform: process.platform, arch: process.arch } }, { filename });
  return module.exports;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renpy-resource-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function walkthrough(directory, text) {
  fs.mkdirSync(directory, { recursive: true });
  for (const file of walkthroughFiles) fs.writeFileSync(path.join(directory, file), text + ':' + file);
}

test('UnRen uses the declared extraResources root or the exact development source', t => {
  const root = fixture(t), resources = path.join(root, 'Resources');
  const unren = load('unren.js', { packaged: true, resourcesPath: resources });
  const exact = path.join(resources, 'unren'); fs.mkdirSync(exact, { recursive: true });
  assert.equal(unren.resolveUnrenRoot(), exact);
  fs.rmSync(exact, { recursive: true });
  for (const legacy of [['resources', 'unren'], ['app.asar.unpacked', 'unren'], ['app.asar.unpacked', 'resources', 'unren']])
    fs.mkdirSync(path.join(resources, ...legacy), { recursive: true });
  assert.equal(unren.resolveUnrenRoot(), null, 'a missing app resource cannot fall back to development or legacy paths');
  assert.equal(load('unren.js', { packaged: true }).resolveUnrenRoot(), null);
  fs.mkdirSync(exact);
  const development = load('unren.js', { packaged: false, resourcesPath: resources });
  assert.equal(development.resolveUnrenRoot(), path.join(sourceDirectory, 'resources', 'unren'));
  const command = development.buildUnrenCommand();
  assert.equal(command.unrenRoot, path.join(sourceDirectory, 'resources', 'unren'));
  assert.equal(command.env.PYTHONPATH.split(path.delimiter)[0], path.join(sourceDirectory, 'resources'));
});

test('walkthrough uses its declared app route and Mod keeps its packaged launcher-source route', t => {
  const root = fixture(t), resources = path.join(root, 'Resources');
  const moduleDirectory = path.join(resources, 'app.asar', 'src/modules/renpy');
  const sourceResources = path.join(moduleDirectory, 'resources');
  const relative = path.join('universal-renpy-walkthrough', '__urw');
  walkthrough(path.join(sourceResources, relative), 'wrong source fallback');
  walkthrough(path.join(resources, 'resources', 'renpy-cheats', relative), 'wrong nested fallback');
  walkthrough(path.join(resources, 'app.asar.unpacked', 'renpy-cheats', relative), 'wrong asar fallback');
  fs.mkdirSync(path.join(moduleDirectory, 'overlays'), { recursive: true });
  const updater = fs.readFileSync(path.join(sourceDirectory, 'overlays/urw_updater.rpy'));
  fs.writeFileSync(path.join(moduleDirectory, 'overlays/urw_updater.rpy'), updater);
  fs.writeFileSync(path.join(sourceResources, '0x52_URM.rpa'), 'exact packaged Mod');
  const renpy = load('main.js', { packaged: true, resourcesPath: resources, moduleDirectory });
  const game = path.join(root, 'game'); fs.mkdirSync(game);
  const entry = { contentRootDir: root, gamePath: root, renpyGameOnly: false };
  assert.throws(() => renpy.actions.patchRenpyWalkthrough(entry, {}, {}), /files not found/);
  assert.equal(fs.existsSync(path.join(game, '__urw')), false);
  walkthrough(path.join(resources, 'renpy-cheats', relative), 'exact packaged walkthrough');
  const status = renpy.actions.patchRenpyWalkthrough(entry, {}, {});
  assert.equal(status.urwInstalled, true);
  assert.equal(fs.readFileSync(path.join(game, '__urw/urw_core.rpy'), 'utf8'), 'exact packaged walkthrough:urw_core.rpy');
  assert.deepEqual(fs.readFileSync(path.join(game, '__urw/urw_updater.rpy')), updater);
  renpy.actions.addRenpyMod(entry, {}, {});
  assert.equal(fs.readFileSync(path.join(game, '0x52_URM.rpa'), 'utf8'), 'exact packaged Mod');
});
