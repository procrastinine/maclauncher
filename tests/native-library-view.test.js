const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { prepareNativeLibraryView } = require('../src/modules/shared/runtime/native-library-view');
const MachO = require('../src/modules/shared/runtime/macho-load-commands');
const { fileDigest } = require('../src/modules/shared/runtime/verified-identity');
const { image, X64 } = require('./fixtures/macho-image');

function put(root, relative, bytes) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-library-view-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source'), root = path.join(scratch, 'prepared');
  const plugin = put(source, 'lib/gstreamer-1.0/plugin.dylib', image({ cpu: X64,
    dependencies: ['@rpath/libcore.dylib', '@rpath/libprivate.dylib'], runPaths: ['@loader_path/..'] }));
  const sdkCore = put(source, 'lib/libcore.dylib', image({ cpu: X64, installName: '@rpath/libcore.dylib', symbols: ['sdk_core'] }));
  const privateLibrary = put(source, 'lib/libprivate.dylib', image({ cpu: X64, installName: '@rpath/libprivate.dylib' }));
  const host = put(scratch, 'host/libcore.dylib', image({ cpu: X64, installName: '@rpath/libcore.dylib', symbols: ['host_core'] }));
  const data = put(source, 'lib/gstreamer-1.0/plugin.data', 'plugin data');
  put(source, 'libexec/scanner-data', 'scanner data'); put(source, 'README', 'source data');
  return { scratch, source, root, plugin, sdkCore, privateLibrary, host, data,
    description: { root: source, files: [{ path: plugin, format: 'macho', relocate: true }], pluginDirectories: [path.dirname(plugin)] } };
}

test('native library views preserve loader neighborhoods and share unchanged bytes across consumers', async t => {
  const f = fixture(t), before = fs.readFileSync(f.plugin), warnings = [];
  fs.symlinkSync('missing-doc', path.join(f.source, 'optional-doc'));
  const options = { root: f.root, bindings: [{ source: f.sdkCore, target: f.host }], logger: { warn: text => warnings.push(text) } };
  const result = await prepareNativeLibraryView(f.description, options);
  const plugin = path.join(result.pluginDirectories[0], path.basename(f.plugin));
  assert.equal(fs.lstatSync(plugin).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(plugin), before); assert.deepEqual(fs.readFileSync(f.plugin), before);
  const slice = MachO.readMachOLoadCommands(plugin).slices[0];
  assert.equal(slice.architecture, 'x86_64');
  assert.ok(slice.dependencies.some(value => value.path === '@rpath/libcore.dylib'));
  const libraryRoot = path.resolve(path.dirname(plugin), slice.runPaths[0].replace('@loader_path', '.'));
  assert.equal(fs.realpathSync(path.join(libraryRoot, 'libcore.dylib')), f.host);
  assert.equal(fs.realpathSync(path.join(libraryRoot, 'libprivate.dylib')), f.privateLibrary);
  assert.equal(fs.realpathSync(path.join(path.dirname(plugin), 'plugin.data')), f.data);
  assert.equal(fs.lstatSync(path.join(f.root, 'libexec')).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(f.root, 'README')), path.join(f.source, 'README'));
  assert.notDeepEqual(fs.readFileSync(f.sdkCore), fs.readFileSync(f.host));
  assert.deepEqual(result.identityInputs, [{ source: f.sdkCore, target: f.host, ...fileDigest(f.host) }]);
  assert.match(warnings[0], /Skipping an unused package entry/);
  const inode = fs.statSync(plugin).ino;
  const secondConsumer = await prepareNativeLibraryView(f.description, options);
  assert.deepEqual(secondConsumer, result); assert.equal(fs.statSync(plugin).ino, inode);
});

test('optional exclusions omit only supplied leaves while linking usable siblings and data', async t => {
  const f = fixture(t), omitted = put(f.source, 'lib/gstreamer-1.0/unusable.dylib', image({ cpu: X64 }));
  const result = await prepareNativeLibraryView({ ...f.description, files: [] }, { root: f.root, excludedFiles: [omitted] });
  assert.equal(fs.existsSync(path.join(result.pluginDirectories[0], path.basename(omitted))), false);
  assert.equal(fs.realpathSync(path.join(result.pluginDirectories[0], path.basename(f.plugin))), f.plugin);
  assert.equal(fs.realpathSync(path.join(result.pluginDirectories[0], path.basename(f.data))), f.data);
});

test('selected source paths and aliases remain contained and output never overlaps the source', async t => {
  const f = fixture(t);
  await assert.rejects(prepareNativeLibraryView(f.description, { root: f.root, files: [{ path: f.host, relocate: true }] }), /source escapes/);
  const alias = path.join(f.source, 'outside.dylib'); fs.symlinkSync(f.host, alias);
  await assert.rejects(prepareNativeLibraryView(f.description, { root: f.root, files: [{ path: alias, relocate: true }] }), /source link escapes/);
  const overlap = path.join(f.source, 'new-view');
  await assert.rejects(prepareNativeLibraryView(f.description, { root: overlap }), /overlaps its source/);
  assert.equal(fs.existsSync(overlap), false);
});

test('unexpected destination aliases never redirect writes into an external directory', async t => {
  const f = fixture(t), external = path.join(f.scratch, 'external'), sentinel = put(external, 'sentinel', 'untouched');
  fs.mkdirSync(f.root); fs.symlinkSync(external, path.join(f.root, 'lib'));
  await assert.rejects(prepareNativeLibraryView(f.description, { root: f.root }), { code: 'NATIVE_LIBRARY_VIEW_STALE' });
  assert.deepEqual(fs.readdirSync(external), ['sentinel']); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('altered copies and unexpected cached plugins request generation recovery without repairs in place', async t => {
  const f = fixture(t), result = await prepareNativeLibraryView(f.description, { root: f.root });
  const plugin = path.join(result.pluginDirectories[0], path.basename(f.plugin)), original = fs.readFileSync(f.plugin);
  fs.writeFileSync(plugin, 'altered cached plugin');
  await assert.rejects(prepareNativeLibraryView(f.description, { root: f.root }), { code: 'NATIVE_LIBRARY_VIEW_STALE' });
  assert.equal(fs.readFileSync(plugin, 'utf8'), 'altered cached plugin'); assert.deepEqual(fs.readFileSync(f.plugin), original);
  const secondRoot = path.join(f.scratch, 'another-generation');
  const second = await prepareNativeLibraryView(f.description, { root: secondRoot });
  const injected = put(second.pluginDirectories[0], 'injected.dylib', image({ cpu: X64 }));
  await assert.rejects(prepareNativeLibraryView(f.description, { root: secondRoot }), { code: 'NATIVE_LIBRARY_VIEW_STALE' });
  assert.equal(fs.existsSync(injected), true);
});
