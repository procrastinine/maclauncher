const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const { build } = require('vite');
const D = require('../src/modules/shared/runtime/translator-description');
const { withSettings } = require('../src/modules/shared/runtime/wine-translators');
const manifest = require('../src/modules/crossover/manifest.json');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');
let choices;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, '../src/renderer/src/ui/components/runtime-setting-choices.ts'), write: false,
    rollupOptions: { output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'translator-ui-choices.cjs'), module); compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id); choices = compiled.exports;
});
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-ui-choices-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  return { root, put };
}
function builtin() {
  const fixture = peFixture({ is64: true }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
  fixture.bytes.write('Wine builtin DLL\0', 64); return fixture.bytes;
}
function load(result, fields) {
  const received = [], failures = [];
  return new Promise(resolve => choices.loadSettingChoices(['listTranslatorOptions'], async () => result,
    (_action, value) => received.push(value), (_action, error) => failures.push(error),
    () => resolve({ received, failures }), fields));
}
const plist = version => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;

test('actual two-line Template DXVK version text keeps every Sikarugir translator choice list available', async t => {
  const { root, put } = scratch(t);
  put('renderer/dxvk/wine/x86_64-windows/d3d11.dll', builtin());
  put('renderer/dxvk/version', 'DXVK-Sikarugir-async-v1.10.3\nD9VK-Sikarugir-v2.3\n');
  const description = D.describeTranslator(path.join(root, 'renderer/dxvk'), { engine: 'dxvk', source: 'Sikarugir Template' });
  assert.equal(description.version, 'DXVK-Sikarugir-async-v1.10.3 D9VK-Sikarugir-v2.3');
  const option = { value: description.id, label: D.label(description) };
  assert.doesNotMatch(option.label, /[\x00-\x1f\x7f]/);
  const fields = withSettings(manifest).runtime.entries.sikarugir.settings.fields.filter(field => field.optionsAction === 'listTranslatorOptions');
  assert.ok(fields.length > 1);
  const result = Object.fromEntries(fields.map(field => [field.optionsKey || field.key, [{ value: 'automatic', label: "Template's automatic choice" }, option]]));
  const loaded = await load(result, fields);
  assert.deepEqual(loaded.failures, []); assert.equal(loaded.received.length, 1);
  for (const field of fields) assert.equal(loaded.received[0][field.optionsKey || field.key][1], option);
});

test('a malformed optional choice or list preserves valid siblings, atomic patches and unrelated action metadata', async t => {
  const warnings = []; t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const fields = withSettings(manifest).runtime.entries.sikarugir.settings.fields.filter(field => field.optionsAction === 'listTranslatorOptions');
  const first = fields[0].optionsKey || fields[0].key, second = fields[1].optionsKey || fields[1].key;
  const valid = { value: 'included:prepared', label: 'Prepared component', runtimeSettingsPatch: { translatorD3D9: 'included:prepared' } };
  const sibling = { value: 'automatic', label: "Template's automatic choice" }, metadata = { future: 'preserved' };
  const result = { [first]: [valid, { value: 'invalid-label', label: 123 }, { value: 'bad\nidentity', label: 'Invalid identity' },
    { value: 'bad-label', label: 'DXVK-Sikarugir-async-v1.10.3\nD9VK-Sikarugir-v2.3' }, sibling], [second]: 'not a choice list',
    futureMetadata: metadata, unrelated: [{ notAnOption: true }] };
  const loaded = await load(result, fields);
  assert.deepEqual(loaded.failures, []); assert.deepEqual(loaded.received[0][first], [valid, sibling]);
  assert.equal(loaded.received[0][first][0], valid); assert.deepEqual(loaded.received[0][second], []);
  assert.equal(loaded.received[0].futureMetadata, metadata); assert.equal(loaded.received[0].unrelated, result.unrelated);
  assert.equal(warnings.length, 2);
});

test('framework Resources metadata supplies the component version directly or through its explicit containing framework root', t => {
  const { root, put } = scratch(t), framework = path.join(root, 'GStreamer.framework/Versions/1.0');
  const plugins = path.join(framework, 'lib/gstreamer-1.0');
  put('GStreamer.framework/Versions/1.0/lib/gstreamer-1.0/libgstfixture.dylib', image({ cpu: X64, symbols: ['gst_plugin_fixture_get_desc'] }));
  put('GStreamer.framework/Versions/1.0/Resources/Info.plist', plist('1.26.11'));
  assert.equal(D.describeTranslator(framework, { engine: 'gstreamer', version: 'release label' }).version, '1.26.11');
  assert.equal(D.describeTranslator(plugins, { engine: 'gstreamer', version: 'release label', frameworkRoot: framework }).version, '1.26.11');
  put('GStreamer.framework/Versions/1.0/lib/gstreamer-1.0/version', 'component\nversion');
  assert.equal(D.describeTranslator(plugins, { engine: 'gstreamer', version: 'release label', frameworkRoot: framework }).version, 'component version');
});

test('unknown, unreadable or escaping optional framework metadata keeps fallback labels while consumed binary escapes reject', t => {
  const { root, put } = scratch(t), messages = [], logger = { warn: warning => messages.push(warning) };
  const component = path.join(root, 'component'), info = put('component/Resources/Info.plist', 'unknown optional metadata');
  put('component/d3d11.dll', builtin());
  assert.equal(D.describeTranslator(component, { engine: 'dxvk', version: 'release label', logger }).version, 'release label');
  fs.writeFileSync(info, plist('1.26.11'));
  const open = fs.openSync;
  const denied = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === info) throw Object.assign(Error('synthetic unreadable plist'), { code: 'EACCES' });
    return open(file, ...args);
  });
  assert.equal(D.describeTranslator(component, { engine: 'dxvk', version: 'release label', logger }).version, 'release label');
  denied.mock.restore(); fs.unlinkSync(info); fs.symlinkSync(put('external/Info.plist', plist('9.9')), info);
  assert.equal(D.describeTranslator(component, { engine: 'dxvk', version: 'release label', logger }).version, 'release label');
  assert.equal(messages.filter(warning => /optional framework version/.test(warning)).length, 3);
  assert.ok(messages.some(warning => /outside its root/.test(warning)));
  fs.symlinkSync(put('external/dxgi.dll', builtin()), path.join(component, 'dxgi.dll'));
  assert.throws(() => D.describeTranslator(component, { engine: 'dxvk', logger }), /escapes its component root/);
});
