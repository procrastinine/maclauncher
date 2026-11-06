const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const D = require('../src/modules/shared/runtime/translator-description');
const Component = require('../src/modules/shared/runtime/component-runtime');
const PE = require('../src/modules/shared/runtime/pe-exports');
const Files = require('../src/modules/shared/runtime/translator-files');
const Loader = require('../src/modules/crossover/runtime/graphics-loader');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-resilience-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, relative, bytes) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
function dll() {
  const fixture = peFixture({ is64: true });
  fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22); fixture.bytes.write('Wine builtin DLL\0', 64);
  return fixture.bytes;
}
const denied = () => Object.assign(Error('synthetic inaccessible entry'), { code: 'EACCES' });

test('translator resilience keeps optional unreadable version labels out of registration failure', t => {
  const root = scratch(t), messages = [], logger = { warn: message => messages.push(message) };
  put(root, 'd3d11.dll', dll()); const version = put(root, 'version', 'optional label');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === version) throw denied(); return read(file, ...args); });
  const selected = Component.inspected(root, { engine: 'dxmt' }, { version: 'catalog label', logger });
  assert.equal(selected.translator.version, 'catalog label');
  assert.equal(selected.translator.files[0].architecture, 'x86_64');
  assert.equal(D.describeTranslator(root, { engine: 'dxmt', logger }).version, '');
  assert.ok(messages.some(message => /optional component version/.test(message)));
  assert.equal(D.describeTranslator(path.join(root, 'd3d11.dll'), { engine: 'dxmt', logger }).warnings.length, 0);
});

test('translator resilience skips unconsumed inaccessible entries and still rejects consumed path escapes', t => {
  const root = scratch(t), component = path.join(root, 'component'), messages = [], logger = { warn: value => messages.push(value) };
  put(component, 'd3d11.dll', dll()); const docs = path.join(component, 'docs'); fs.mkdirSync(docs);
  fs.symlinkSync('missing-notice', path.join(component, 'LICENSE'));
  fs.mkdirSync(path.join(component, 'Other.framework')); fs.symlinkSync('missing-notice', path.join(component, 'Other.framework/LICENSE'));
  const notice = put(component, 'Other.framework/NOTICE', 'optional notice'), access = fs.accessSync;
  t.mock.method(fs, 'accessSync', (file, ...args) => { if (file === notice) throw denied(); return access(file, ...args); });
  fs.symlinkSync('.', path.join(component, 'cycle'));
  const list = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => { if (file === docs) throw denied(); return list(file, ...args); });
  assert.equal(Component.inspected(component, { engine: 'dxvk' }, { logger }).translator.files.length, 1);
  assert.ok(messages.some(message => /LICENSE/.test(message)));
  assert.ok(messages.some(message => /docs/.test(message)));
  const link = path.join(component, 'dxgi.dll'); fs.symlinkSync('missing.dll', link);
  assert.throws(() => D.describeTranslator(component, { engine: 'dxvk', logger }), { code: 'ENOENT' });
  fs.unlinkSync(link); fs.symlinkSync(put(root, 'external.dll', dll()), link);
  assert.throws(() => D.describeTranslator(component, { engine: 'dxvk', logger }), /escapes its component root/);
  fs.unlinkSync(link); fs.symlinkSync(put(root, 'outside.json', JSON.stringify({ ICD: { library_path: 'external.dll' } })), path.join(component, 'driver.json'));
  assert.throws(() => D.describeTranslator(component, { engine: 'dxvk', logger }), /escapes its component root/);
});

test('translator resilience retains basic valid PE facts when optional export inspection is exhausted', t => {
  const root = scratch(t), fixture = peFixture({ is64: true }), count = PE.LIMITS.exportNames + 1;
  const names = Array.from({ length: count }, (_, index) => Buffer.from(`export_${index}\0`));
  const tableBytes = 40 + count * 10, size = tableBytes + names.reduce((sum, name) => sum + name.length, 0) + 1;
  const bytes = Buffer.alloc(fixture.raw + size); fixture.bytes.copy(bytes, 0, 0, fixture.raw);
  bytes.writeUInt16LE(0x2002, fixture.peOffset + 22); bytes.write('Wine builtin DLL\0', 64);
  bytes.writeUInt32LE(size, fixture.section + 8); bytes.writeUInt32LE(size, fixture.section + 16);
  bytes.writeUInt32LE(0x2000, fixture.directories); bytes.writeUInt32LE(size - 1, fixture.directories + 4);
  bytes.writeUInt32LE(0, fixture.directories + 16); bytes.writeUInt32LE(0, fixture.directories + 20);
  const functions = 40, pointers = functions + count * 4, ordinals = pointers + count * 4;
  for (const [offset, value] of [[20, count], [24, count], [28, 0x2000 + functions], [32, 0x2000 + pointers], [36, 0x2000 + ordinals]]) bytes.writeUInt32LE(value, fixture.raw + offset);
  let cursor = tableBytes;
  names.forEach((name, index) => {
    bytes.writeUInt32LE(0x2000 + size - 1, fixture.raw + functions + index * 4);
    bytes.writeUInt32LE(0x2000 + cursor, fixture.raw + pointers + index * 4);
    bytes.writeUInt16LE(index, fixture.raw + ordinals + index * 2); name.copy(bytes, fixture.raw + cursor); cursor += name.length;
  });
  const file = put(root, 'd3d11.dll', bytes);
  assert.equal(PE.readPeExports(file), null);
  const facts = PE.readPeExports(file, { headersOnly: true });
  assert.equal(facts.architecture, 'x86_64'); assert.equal(facts.machine, 0x8664); assert.equal(facts.form, 'builtin');
  const inspected = Component.inspected(root, { engine: 'dxvk' }, { logger: { warn() {} } });
  assert.equal(inspected.translator.files[0].format, 'pe');
  assert.match(inspected.translator.files[0].inspectionWarning, /incomplete/);
  fs.writeFileSync(file, Buffer.from('not a binary'));
  assert.throws(() => Component.inspected(root, { engine: 'dxvk' }, { logger: { warn() {} } }), /no loadable library/);
  fs.writeFileSync(file, bytes.subarray(0, fixture.raw - 1));
  assert.throws(() => Component.inspected(root, { engine: 'dxvk' }, { logger: { warn() {} } }), /no loadable library/);
});

test('translator resilience regenerates owned alias drift without changing prior generations or prefix files', async t => {
  const root = scratch(t), component = path.join(root, 'component'), userDataDir = path.join(root, 'profile'), messages = [];
  const source = put(component, 'd3d11.dll', dll());
  put(component, 'winemetal.so', image({ cpu: X64 }));
  const plan = { runtime: 'sikarugir', components: { renderer: { used: D.describeTranslator(component, { engine: 'dxmt' }) } } };
  const options = { userDataDir, layout: { architecture: 'x86_64', unixName: 'x86_64-unix' }, logger: { warn: value => messages.push(value) } };
  const symlink = fs.promises.symlink;
  let raced = false;
  const competing = t.mock.method(fs.promises, 'symlink', async (input, target) => {
    if (!raced && target.endsWith('d3d11.dll')) {
      raced = true; await symlink(path.relative(path.dirname(target), input), target);
      throw Object.assign(Error('synthetic concurrent alias'), { code: 'EEXIST' });
    }
    return symlink(input, target);
  });
  const first = await Files.prepareTranslatorFiles(plan, options), alias = path.join(first.root, 'lib/wine/x86_64-windows/d3d11.dll');
  assert.equal(raced, true); competing.mock.restore();
  fs.unlinkSync(alias); fs.symlinkSync(path.relative(path.dirname(alias), source), alias);
  assert.equal((await Files.prepareTranslatorFiles(plan, options)).root, first.root);
  const prefix = put(root, 'external-prefix/drive_c/windows/system32/d3d11.dll', 'user DLL sentinel');
  const altered = put(root, 'other.dll', dll()); fs.unlinkSync(alias); fs.symlinkSync(altered, alias);
  const next = await Files.prepareTranslatorFiles(plan, options);
  assert.notEqual(next.root, first.root); assert.equal(fs.realpathSync(path.join(next.root, 'lib/wine/x86_64-windows/d3d11.dll')), source);
  assert.equal(fs.readlinkSync(alias), altered); assert.equal(fs.readFileSync(prefix, 'utf8'), 'user DLL sentinel');
  assert.equal((await Files.prepareTranslatorFiles(plan, options)).root, next.root);
  assert.ok(messages.some(message => /old view is retained/.test(message)));
  const other = path.join(root, 'aliased-profile'); fs.mkdirSync(other); fs.symlinkSync(userDataDir, path.join(other, 'graphics'));
  await assert.rejects(Files.prepareTranslatorFiles(plan, { ...options, userDataDir: other }), /must not be aliases/);
  fs.unlinkSync(source);
  await assert.rejects(Files.prepareTranslatorFiles(plan, options), { code: 'ENOENT' });
});

test('translator resilience stages another loader generation and never executes changed cached inputs', async t => {
  const root = scratch(t), vendor = path.join(root, 'vendor'), userDataDir = path.join(root, 'profile'), messages = [];
  const installation = { crossoverRoot: vendor, loaderPath: put(vendor, 'bin/wineloader', image({ cpu: X64, fileType: 2 })) };
  put(vendor, 'bin/wineserver', image({ cpu: X64, fileType: 2 })); put(vendor, 'share/data', 'data');
  put(vendor, 'lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64 }));
  put(vendor, 'lib/wine/x86_64-unix/wine', image({ cpu: X64, fileType: 2 }));
  const library = put(vendor, 'lib/wine/x86_64-unix/crypt32.so', image({ cpu: X64 }));
  for (const name of ['ntdll', 'apisetschema']) put(vendor, `lib/wine/x86_64-windows/${name}.dll`, dll());
  let signs = 0;
  const options = { userDataDir, logger: { warn: value => messages.push(value) }, execute: async (_command, args) => {
    if (args[0] === '-d') return { stdout: '<?xml version="1.0"?><plist><dict></dict></plist>' };
    if (args.includes('--sign')) signs++;
    return { stdout: '' };
  } };
  const first = await Loader.prepare(installation, path.join(root, 'game'), options);
  fs.writeFileSync(first, 'changed cached loader');
  const next = await Loader.prepare(installation, path.join(root, 'game'), options);
  assert.notEqual(next, first); assert.equal(fs.readFileSync(first, 'utf8'), 'changed cached loader');
  assert.deepEqual(fs.readFileSync(next), fs.readFileSync(installation.loaderPath));
  const alias = path.resolve(path.dirname(next), '../lib/wine/x86_64-unix/crypt32.so');
  fs.unlinkSync(alias); fs.symlinkSync(path.relative(path.dirname(alias), library), alias);
  assert.equal(await Loader.prepare(installation, path.join(root, 'game'), options), next);
  assert.equal(signs, 4); assert.ok(messages.some(message => /old view is retained/.test(message)));
  assert.equal(fs.readdirSync(path.join(userDataDir, 'graphics/crossover-loaders')).some(name => name.startsWith('prepare-')), false);
  fs.unlinkSync(installation.loaderPath);
  await assert.rejects(Loader.prepare(installation, path.join(root, 'game'), options), { code: 'ENOENT' });
});
