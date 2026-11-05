const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const D = require('../src/modules/shared/runtime/translator-description');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

test('legacy aggregate imports are discarded while actual PE and native slice facts remain intact', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-legacy-metadata-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64);
  const dll = path.join(root, 'd3d11.dll'); fs.writeFileSync(dll, pe.bytes);
  const bytes = image({ cpu: X64, dependencies: ['@rpath/ntdll.so'], symbols: ['wine_unix_call'] });
  bytes.writeUInt32LE(0x80, 24);
  let command = 32, symbols;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8);
    command += bytes.readUInt32LE(command + 4);
  }
  bytes[symbols + 4] = 1; bytes[symbols + 5] = 0; bytes.writeUInt16LE(1 << 8, symbols + 6);
  const native = path.join(root, 'winemetal.so'); fs.writeFileSync(native, bytes);
  const old = { unixImports: { obsolete: true }, futureMetadata: 'preserved' };
  const peFacts = D.inspectFile({ path: dll, ...old }), nativeFacts = D.inspectFile({ path: native, ...old });
  assert.equal(peFacts.machine, 0x8664); assert.equal(peFacts.architecture, 'x86_64'); assert.equal(peFacts.form, 'builtin');
  assert.deepEqual(nativeFacts.cpuSlices, ['x86_64']);
  assert.deepEqual(nativeFacts.slices[0].imports, [{ symbol: 'wine_unix_call', ordinal: 1, library: '@rpath/ntdll.so', weak: false }]);
  assert.equal(nativeFacts.slices[0].importsComplete, true);
  const restored = D.description({ ...old, component: 'd3d-renderer', engine: 'future-engine', form: 'future-form',
    files: [{ ...peFacts, unixImports: old.unixImports }, { ...nativeFacts, unixImports: ['obsolete'] }] });
  assert.equal(restored.futureMetadata, 'preserved');
  for (const value of [restored, peFacts, nativeFacts, ...restored.files]) assert.equal(Object.hasOwn(value, 'unixImports'), false);
  assert.ok(restored.files.every(file => file.futureMetadata === 'preserved'));
  const inspected = D.describeTranslator(root, { engine: 'dxmt', logger: { warn() {} } });
  assert.equal(Object.hasOwn(inspected, 'unixImports'), false);
  assert.ok(inspected.files.every(file => !Object.hasOwn(file, 'unixImports')));
  assert.deepEqual(inspected.files.find(file => file.format === 'macho').slices[0].imports, nativeFacts.slices[0].imports);
});
