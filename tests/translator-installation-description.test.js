const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const D = require('../src/modules/shared/runtime/translator-description');
const Pinned = require('../src/modules/shared/runtime/pinned-native-manager');
const { peFixture } = require('./helpers/pe-fixture');
const { image, universal, ARM64, X64 } = require('./fixtures/macho-image');

function native(cpu, installName, library = '/usr/lib/libSystem.B.dylib') {
  const bytes = image({ cpu, installName, dependencies: [library], runPaths: ['@loader_path'], symbols: ['required_symbol'] });
  bytes.writeUInt32LE(0x80, 24);
  let command = 32, symbols;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8);
    command += bytes.readUInt32LE(command + 4);
  }
  bytes[symbols + 4] = 1; bytes[symbols + 5] = 0; bytes.writeUInt16LE(1 << 8, symbols + 6);
  return bytes;
}
function bothCpus(installName, library) {
  return universal([ARM64, X64].map(cpu => ({ cpu, bytes: native(cpu, installName, library) })));
}
function importingPe() {
  const f = peFixture({ is64: true }), start = 0x800, rva = offset => 0x2000 + offset;
  f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); f.bytes.write('Wine builtin DLL\0', 64);
  f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE(40, f.directories + 12);
  f.bytes.writeUInt32LE(rva(start + 40), f.raw + start); f.bytes.writeUInt32LE(rva(start + 56), f.raw + start + 16);
  f.bytes.writeUInt32LE(rva(start + 72), f.raw + start + 12);
  for (const offset of [40, 56]) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + start + offset);
  f.bytes.write('DXGI.dll\0', f.raw + start + 72); return f.bytes;
}
function diskFacts(value) {
  assert.equal(Object.hasOwn(value, 'root'), false); assert.equal(Object.hasOwn(value, 'id'), false);
  for (const file of value.files) {
    assert.equal(file.path, file.relative); assert.equal(Object.hasOwn(file, 'realPath'), false);
    for (const slice of file.format === 'macho' ? file.slices : []) {
      assert.equal(Object.hasOwn(slice, 'imports'), false); assert.equal(slice.importsComplete, false);
      assert.equal(slice.minimumMacOS, '13.0.0'); assert.deepEqual(slice.runPaths, ['@loader_path']);
      assert.equal(slice.dependencies.length, 1); assert.ok(slice.installName.path);
    }
  }
}

test('shared installation projection keeps live facts intact and both real prepare callbacks persist compact native descriptions', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-installation-description-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const dll = put('dxmt/d3d11.dll', importingPe());
  const unix = put('dxmt/winemetal.so', bothCpus('@rpath/winemetal.so', '@rpath/ntdll.so'));
  const component = path.dirname(dll), live = D.describeTranslator(component, { engine: 'dxmt' });
  const old = { ...live, unixImports: { obsolete: true }, futureMetadata: { imports: ['unrelated metadata remains'] },
    files: live.files.map(file => ({ ...file, unixImports: ['obsolete'], futureFileFact: 'retained' })) };
  const before = structuredClone(old), stored = D.installationDescription(old);
  diskFacts(stored); assert.deepEqual(old, before, 'live descriptions are not rewritten for persistence');
  assert.deepEqual(stored.futureMetadata, old.futureMetadata); assert.ok(stored.files.every(file => file.futureFileFact === 'retained'));
  assert.equal(Object.hasOwn(stored, 'unixImports'), false); assert.ok(stored.files.every(file => !Object.hasOwn(file, 'unixImports')));
  const pe = stored.files.find(file => file.format === 'pe'), macho = stored.files.find(file => file.format === 'macho');
  assert.deepEqual(pe.peImports, ['dxgi.dll']); assert.equal(pe.importsComplete, true); assert.equal(pe.machine, 0x8664);
  assert.deepEqual(macho.cpuSlices, ['arm64', 'x86_64']);
  assert.ok(macho.slices.every(slice => slice.dependencies[0].path === '@rpath/ntdll.so' && slice.installName.path === '@rpath/winemetal.so'));
  const persisted = JSON.parse(JSON.stringify(stored));
  assert.deepEqual(D.installationDescription(persisted), persisted, 'older relative records remain usable without their import inventory');
  assert.ok(live.files.find(file => file.path === unix).slices.every(slice => slice.imports[0].symbol === 'required_symbol' && slice.importsComplete));

  const configurations = new Map(), create = Pinned.createPinnedNativeManager;
  t.mock.method(Pinned, 'createPinnedNativeManager', options => { configurations.set(options.id, options); return create(options); });
  const modules = ['../src/modules/shared/runtime/translator-managers', '../src/modules/shared/vulkan/libraries'].map(require.resolve);
  const previous = modules.map(file => require.cache[file]); modules.forEach(file => { delete require.cache[file]; });
  t.after(() => modules.forEach((file, index) => { if (previous[index]) require.cache[file] = previous[index]; else delete require.cache[file]; }));
  require(modules[0]).createManager('dxmt');
  require(modules[1]).createManager('moltenvk', { systemVersionSync: () => '26.0' });
  const translatorMetadata = await configurations.get('sikarugir-graphics-bridge').prepareInstall({ unpacked: component,
    pin: { catalogSourceId: 'upstream', asset: { filename: 'component.tar.gz' } } });
  diskFacts(translatorMetadata.translator);
  assert.deepEqual(translatorMetadata.translator.files.find(file => file.format === 'pe').peImports, ['dxgi.dll']);
  assert.equal(translatorMetadata.files['d3d11.dll'], Pinned.hashFile(dll)); assert.equal(translatorMetadata.files['winemetal.so'], Pinned.hashFile(unix));
  assert.equal(translatorMetadata.translatorRelative, '');
  put('moltenvk/libMoltenVK.dylib', bothCpus('@rpath/libMoltenVK.dylib'));
  const driverMetadata = await configurations.get('vulkan-moltenvk').prepareInstall({ unpacked: path.join(root, 'moltenvk') });
  diskFacts(driverMetadata.translator); assert.equal(driverMetadata.backend, 'moltenvk'); assert.equal(driverMetadata.minimumMacOS, '13.0.0');
  assert.deepEqual(driverMetadata.libraries.map(file => file.file), ['libMoltenVK.dylib']);
  const inspected = D.inspectFile({ path: path.join(root, 'moltenvk/libMoltenVK.dylib') });
  assert.ok(inspected.slices.every(slice => slice.importsComplete && slice.imports[0].symbol === 'required_symbol'));
});
