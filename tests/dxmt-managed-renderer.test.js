const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { image, X64 } = require('./fixtures/macho-image');
const DXMT = require('../src/modules/crossover/runtime/maclauncher-dxmt');

// An authored PE image with one export and no executable machine instructions.
function library(name, { machine = 0xa641, executable = true, forwarded = false } = {}) {
  const bytes = Buffer.alloc(4096), coff = 0x80, optional = coff + 24, section = optional + 240;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(coff, 60);
  bytes.writeUInt32LE(0x4550, coff); bytes.writeUInt16LE(machine, coff + 4);
  bytes.writeUInt16LE(1, coff + 6); bytes.writeUInt16LE(240, coff + 20); bytes.writeUInt16LE(0x2002, coff + 22);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x2000, optional + 56);
  bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, optional + 112); bytes.writeUInt32LE(0x400, optional + 116);
  bytes.write('.text', section); bytes.writeUInt32LE(3584, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(3584, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(executable ? 0x60000020 : 0x40000040, section + 36);
  bytes.writeUInt32LE(1, 0x210); bytes.writeUInt32LE(1, 0x214); bytes.writeUInt32LE(1, 0x218);
  bytes.writeUInt32LE(0x1050, 0x21c); bytes.writeUInt32LE(0x1090, 0x220); bytes.writeUInt32LE(0x10d0, 0x224);
  bytes.writeUInt32LE(forwarded ? 0x1140 : 0x1800, 0x250);
  bytes.writeUInt32LE(0x1100, 0x290); bytes.writeUInt16LE(0, 0x2d0); bytes.write(name, 0x300);
  if (forwarded) bytes.write('other.entry', 0x340);
  return bytes;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxmt-renderer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = {
    'wine/aarch64-unix/winemetal.so': image({ installName: '@rpath/winemetal.so' }),
    'wine/aarch64-windows/d3d11.dll': library('D3D11CreateDevice'),
    'wine/aarch64-windows/dxgi.dll': library('CreateDXGIFactory1'),
    'wine/aarch64-windows/winemetal.dll': library('DllMain')
  };
  const manifest = { schemaVersion: 1, id: 'dxmt', engine: 'dxmt', platform: 'darwin', version: 'fixture',
    executableRelative: 'wine/aarch64-unix/winemetal.so', nativeArchitecture: 'arm64', windowsArchitecture: 'arm64ec',
    files: Object.keys(entries).map(file => ({ path: file })) };
  const put = (file, bytes) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  for (const [file, bytes] of Object.entries(entries)) put(file, bytes);
  const save = () => put('manifest.json', JSON.stringify(manifest)); save();
  return { root, manifest, put, save };
}

test('the native DXMT renderer requires a complete ARM64EC Direct3D pair', t => {
  const f = fixture(t), selected = DXMT.inspect(f.root);
  assert.deepEqual(selected.architectures, ['arm64']); assert.equal(selected.needsRosetta, false);
  for (const file of ['d3d11.dll', 'dxgi.dll', 'winemetal.dll']) {
    const relative = 'wine/aarch64-windows/' + file, before = fs.readFileSync(path.join(f.root, relative));
    fs.unlinkSync(path.join(f.root, relative)); assert.throws(() => DXMT.inspect(f.root), /missing|ENOENT/); f.put(relative, before);
  }
  const native = fs.readFileSync(selected.executablePath);
  f.put(f.manifest.executableRelative, image({ cpu: X64 })); assert.throws(() => DXMT.inspect(f.root), /arm64 native/);
  f.put(f.manifest.executableRelative, image({ fileType: 2 })); assert.throws(() => DXMT.inspect(f.root), /dynamic library/);
  f.put(f.manifest.executableRelative, native);
  for (const machine of [0xaa64, 0x8664]) {
    f.put('wine/aarch64-windows/d3d11.dll', library('D3D11CreateDevice', { machine }));
    assert.throws(() => DXMT.inspect(f.root), /64-bit Windows/);
  }
});

test('DXMT admission checks executable APIs and declared package identity', t => {
  const f = fixture(t);
  for (const options of [{ executable: false }, { forwarded: true }]) {
    f.put('wine/aarch64-windows/d3d11.dll', library('D3D11CreateDevice', options));
    assert.throws(() => DXMT.inspect(f.root), /Windows API/);
  }
  f.put('wine/aarch64-windows/d3d11.dll', library('AnotherEntry'));
  assert.throws(() => DXMT.inspect(f.root), /Windows API/);
  f.put('wine/aarch64-windows/d3d11.dll', library('D3D11CreateDevice'));
  f.manifest.files.pop(); f.save(); assert.throws(() => DXMT.inspect(f.root), /missing a required library/);
  f.manifest.nativeArchitecture = 'x86_64'; f.save(); assert.throws(() => DXMT.inspect(f.root), /does not describe/);
});

test('MacLauncher DXMT is an ordinary managed translator source', () => {
  const module = require('../src/modules/crossover/main');
  const manager = module.runtimeManagers.find(item => item.id === 'dxmt');
  assert.ok(manager); assert.equal(manager.translatorEngine, 'dxmt');
  assert.equal(manager.ui.management, 'managed');
  assert.deepEqual(manager.sourceIds, ['maclauncher-dxmt']);
  assert.equal(manager.sources[0].upstream.builds, 'dxmt');
  for (const method of ['refreshCatalog', 'installRuntime', 'uninstallRuntime', 'resolveSelection']) assert.equal(typeof manager[method], 'function');
  assert.equal(typeof manager.customRuntime.inspect, 'function');
});
