const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

// A new backend lane is a new module instance: its in-memory inspections are empty.
function lane(t) {
  const files = ['translator-description', 'wine-translators'].map(name => require.resolve('../src/modules/shared/runtime/' + name));
  const previous = files.map(file => require.cache[file]);
  for (const file of files) delete require.cache[file];
  const Translators = require(files[1]);
  t.after(() => files.forEach((file, index) => { require.cache[file] = previous[index]; }));
  return Translators;
}
function component(root) {
  const dir = path.join(root, 'runtimes', 'translator-fixture', '1.0'); fs.mkdirSync(dir, { recursive: true });
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64);
  fs.writeFileSync(path.join(dir, 'd3d11.dll'), pe.bytes);
  fs.writeFileSync(path.join(dir, 'winemetal.so'), image({ cpu: X64, dependencies: ['@rpath/ntdll.so'], symbols: ['fixture_import'] }));
  return dir;
}

test('managed translator choices in a new lane come from retained facts without reading translator binaries', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-retained-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = component(root), binaries = new Set(['d3d11.dll', 'winemetal.so'].map(name => path.join(dir, name)));
  const manager = { id: 'translator-fixture', label: 'Fixture', translatorEngine: 'dxmt',
    getState: () => ({ installed: [{ version: '1.0', ready: true }] }),
    resolveSelection: (_entry, _settings, _data, { version }) => ({ install: { version, installDir: dir } }) };
  const context = { userDataDir: path.join(root, 'profile'), settings: { runtimes: {} }, runtimeSettings: {}, logger: { warn() {} } };
  const opened = [], open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (binaries.has(String(file))) opened.push(path.basename(String(file))); return open(file, ...args); });
  const read = async Translators => (await Translators.optionsInventory(null, 'crossover', context, { managers: [manager] })).choices
    .find(choice => choice.id === 'translator-fixture:1.0');

  const first = await read(lane(t));
  assert.ok(first, 'the first lane prepares the description and offers the choice');
  assert.ok(opened.length > 0, 'preparing reads the binaries once');
  assert.equal(fs.readdirSync(path.join(context.userDataDir, 'cache/translator-descriptions')).length, 1);

  opened.length = 0;
  const later = await read(lane(t));
  assert.deepEqual(opened, [], 'a later lane reads the retained facts only');
  assert.deepEqual(later.files.map(file => path.basename(file.path)).sort(), ['d3d11.dll', 'winemetal.so']);
  assert.equal(later.files.find(file => file.format === 'pe').machine, 0x8664);
  assert.equal(later.files.find(file => file.format === 'macho').slices[0].importsComplete, false, 'Play completes native imports itself');

  // A retained description whose files changed is prepared again.
  fs.appendFileSync(path.join(dir, 'd3d11.dll'), Buffer.alloc(16));
  opened.length = 0;
  assert.ok(await read(lane(t)));
  assert.ok(opened.includes('d3d11.dll'));
});

test('a managed translator that cannot be described is reported and left out', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-missing-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings = [], manager = { id: 'translator-fixture', label: 'Fixture', translatorEngine: 'dxmt',
    getState: () => ({ installed: [{ version: '1.0', ready: true }] }),
    resolveSelection: (_entry, _settings, _data, { version }) => ({ install: { version, installDir: path.join(root, 'absent') } }) };
  const context = { userDataDir: path.join(root, 'profile'), settings: { runtimes: {} }, runtimeSettings: {}, logger: { warn: message => warnings.push(message) } };
  const { choices } = await lane(t).optionsInventory(null, 'crossover', context, { managers: [manager] });
  assert.equal(choices.some(choice => choice.managerId === 'translator-fixture'), false);
  assert.equal(warnings.filter(message => message.includes('[translators] Fixture')).length, 1);
});
