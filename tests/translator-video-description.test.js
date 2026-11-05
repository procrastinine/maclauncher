const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const { image, X64 } = require('./fixtures/macho-image');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-video-description-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, options = {}) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image({ cpu: X64, ...options })); return file;
  };
  const plugin = put('component/plugins/libgstfixture.dylib', { installName: '@rpath/libgstfixture.dylib', dependencies: ['@loader_path/../private/libfixture.dylib'] });
  const dependency = put('component/private/libfixture.dylib', { installName: '@rpath/libfixture.dylib' });
  return { root: path.join(root, 'component'), put, plugin, dependency };
}

test('video description keeps explicit plugin directories distinct from its complete binary closure', t => {
  const f = fixture(t), metadata = ['plugins/../plugins', 'plugins'];
  const value = Description.describeTranslator(f.root, { engine: 'gstreamer', pluginDirectories: metadata });
  assert.deepEqual(value.pluginDirectories, ['plugins']);
  assert.deepEqual(metadata, ['plugins/../plugins', 'plugins']);
  assert.deepEqual(new Set(value.files.map(file => file.path)), new Set([f.plugin, f.dependency]));
  assert.ok(value.files.every(file => file.format === 'macho' && file.cpuSlices.includes('x86_64')));
  assert.equal(value.files.find(file => file.path === f.plugin).slices[0].dependencies[0].path, '@loader_path/../private/libfixture.dylib');
  const future = { providerHint: 'future', closure: { optional: true } };
  const preserved = Description.description({ ...value, engine: 'future-video', form: 'future-form', future });
  assert.deepEqual(preserved.pluginDirectories, ['plugins']); assert.deepEqual(preserved.future, future);
});

test('absent and empty plugin directory metadata preserve flat prepared component behavior', t => {
  const f = fixture(t), flat = f.put('flat/libgstflat.dylib');
  const absent = Description.describeTranslator(path.dirname(flat), { engine: 'gstreamer' });
  assert.equal(Object.hasOwn(absent, 'pluginDirectories'), false); assert.equal(absent.files[0].path, flat);
  const empty = Description.describeTranslator(path.dirname(flat), { engine: 'gstreamer', pluginDirectories: [] });
  assert.deepEqual(empty.pluginDirectories, []); assert.deepEqual(empty.files, absent.files);
  const selected = Description.describeTranslator(path.dirname(flat), { engine: 'gstreamer', pluginDirectories: ['.'] });
  assert.deepEqual(selected.pluginDirectories, ['.']); assert.deepEqual(selected.files, absent.files);
});

test('explicit plugin directories remain inside the selected component root', t => {
  const f = fixture(t), outside = f.put('outside/libgstoutside.dylib');
  fs.symlinkSync(path.dirname(outside), path.join(f.root, 'escape'));
  const describe = pluginDirectories => Description.describeTranslator(f.root, { engine: 'gstreamer', pluginDirectories, logger: { warn() {} } });
  assert.throws(() => describe(['../outside']), /escapes its component root/);
  assert.throws(() => describe(['escape']), /escapes its component root/);
  assert.throws(() => describe([path.dirname(outside)]), /root-relative/);
  assert.throws(() => describe(['plugins/libgstfixture.dylib']), /must be a directory/);
  assert.throws(() => describe(['missing']), { code: 'ENOENT' });
  const value = describe(['plugins']);
  assert.deepEqual(value.pluginDirectories, ['plugins']);
  assert.ok(value.warnings.some(warning => warning.includes('outside its root')));
  assert.equal(value.files.some(file => file.path === outside), false);
});
