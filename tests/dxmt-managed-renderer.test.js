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
function fixture(t, intel = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxmt-renderer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = intel ? 'x86_64' : 'aarch64', machine = intel ? 0x8664 : 0xa641;
  const primary = `wine/${folder}-unix/winemetal.so`, windows = `wine/${folder}-windows`;
  const entries = {
    [primary]: image({ installName: '@rpath/winemetal.so', ...(intel ? { cpu: X64 } : {}) }),
    [windows + '/d3d11.dll']: library('D3D11CreateDevice', { machine }),
    [windows + '/dxgi.dll']: library('CreateDXGIFactory1', { machine }),
    [windows + '/winemetal.dll']: library('DllMain', { machine })
  };
  const manifest = { schemaVersion: 1, id: 'dxmt', engine: 'dxmt', platform: 'darwin', version: 'fixture',
    executableRelative: primary, nativeArchitecture: intel ? 'x86_64' : 'arm64', windowsArchitecture: intel ? 'x86_64' : 'arm64ec',
    files: Object.keys(entries).map(file => ({ path: file })) };
  const put = (file, bytes) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  for (const [file, bytes] of Object.entries(entries)) put(file, bytes);
  const save = () => put('manifest.json', JSON.stringify(manifest)); save();
  return { root, manifest, primary, windows, put, save };
}

test('the Intel DXMT package requires an Intel Mach-O and x64 Windows libraries', t => {
  const f = fixture(t, true);
  const selected = DXMT.inspect(f.root);
  assert.deepEqual(selected.architectures, ['x86_64']);
  assert.equal(selected.executablePath, path.join(f.root, f.primary));
  f.put(f.windows + '/d3d11.dll', library('D3D11CreateDevice'));
  assert.throws(() => DXMT.inspect(f.root), /64-bit Windows/);
  f.put(f.windows + '/d3d11.dll', library('D3D11CreateDevice', { machine: 0x8664 }));
  f.put(f.primary, image({ installName: '@rpath/winemetal.so' }));
  assert.throws(() => DXMT.inspect(f.root), /x86_64 native renderer/);
});

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

// Versions, install, set default, delete and a custom path through the ordinary manager actions, with
// published-package fixtures in the Builds release layout. Status and selection never fetch.
test('MacLauncher DXMT lists, installs, defaults, removes and registers packages like any managed download', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const { execFileSync } = require('node:child_process');
  const { packageFor } = require('./helpers/managed-tool-fixture.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dxmt-managed-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unix = path.join(root, 'winemetal.so');
  fs.writeFileSync(path.join(root, 'winemetal.c'), 'const void *__wine_unix_call_funcs[1], *__wine_unix_call_wow64_funcs[1];\n');
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', '-mmacosx-version-min=13.0', '-dynamiclib', '-install_name', '@rpath/winemetal.so', path.join(root, 'winemetal.c'), '-o', unix]);
  const entries = [
    { path: 'wine/aarch64-unix/winemetal.so', bytes: fs.readFileSync(unix), mode: 0o755, architectures: ['arm64'] },
    { path: 'wine/aarch64-windows/d3d11.dll', bytes: library('D3D11CreateDevice'), mode: 0o644 },
    { path: 'wine/aarch64-windows/dxgi.dll', bytes: library('CreateDXGIFactory1'), mode: 0o644 },
    { path: 'wine/aarch64-windows/winemetal.dll', bytes: library('DllMain'), mode: 0o644 }];
  const versions = ['0.80-244-g7c8dee1-MCLv1', '0.80-250-gabcdef0-MCLv1'];
  const fixtures = versions.map(version => packageFor(path.join(root, version), { id: 'dxmt', version, architecture: 'arm64', entries,
    manifest: { id: 'dxmt', engine: 'dxmt', platform: 'darwin', executableRelative: 'wine/aarch64-unix/winemetal.so', nativeArchitecture: 'arm64',
      windowsArchitecture: 'arm64ec', upstreamRevision: 'a'.repeat(40), dependencies: [] } }));
  let offline = false; const requests = [];
  const dependencies = { systemVersionSync: () => '27.0',
    fetchUrlBuffer: async url => { assert.equal(offline, false, 'status and selection never fetch'); requests.push(url);
      return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: 'dxmt', updatePolicy: 'manual', packages: fixtures.map(item => item.record) })) }; },
    downloadToFile: async (url, destination) => { assert.equal(offline, false); requests.push(url);
      const fixture = fixtures.find(item => item.record.asset.url === url); assert.ok(fixture, 'downloads keep the published asset identity');
      fs.copyFileSync(fixture.archive, destination); } };
  const manager = DXMT.create({ dependencies }), userDataDir = path.join(root, 'profile');
  // Versions: every published version is offered after Refresh.
  await manager.refreshCatalog({ userDataDir, force: true });
  offline = true;
  const listed = manager.getState({ userDataDir, settings: {} });
  for (const version of versions) assert.ok(JSON.stringify(listed).includes(version), version);
  // Install: both versions, each admitted by the DXMT inspection.
  offline = false;
  const installed = [];
  for (const version of versions) installed.push(await manager.installRuntime({ userDataDir, version, architecture: 'arm64' }));
  offline = true;
  for (const [index, item] of installed.entries()) {
    assert.equal(item.version, versions[index]);
    assert.equal(fs.realpathSync(item.executablePath), fs.realpathSync(path.join(item.root, 'wine/aarch64-unix/winemetal.so')));
    assert.equal(item.baseRoot, path.join(item.root, 'wine'));
  }
  // Set default: the older version becomes the section default and is what an unset game selects.
  const settings = manager.applySettingsUpdate('setDefault', { version: versions[0] }, {}, { userDataDir });
  assert.equal(settings.defaultVersion, versions[0]);
  const chosen = manager.resolveSelection(null, { runtimes: { [manager.id]: settings } }, userDataDir, { verification: 'status' });
  assert.equal(chosen.version, versions[0]); assert.equal(chosen.ready, true);
  // Delete: the newer version's files go, the default stays.
  await manager.uninstallRuntime({ userDataDir, version: versions[1], settings });
  assert.equal(fs.existsSync(installed[1].installDir), false);
  assert.deepEqual(manager.getState({ userDataDir, settings }).installed.filter(row => !row.custom).map(row => row.version), [versions[0]]);
  // Custom path: an unpacked package elsewhere registers as its own copy and can be the default.
  const custom = path.join(root, versions[1], 'archive-input', 'files');
  await manager.registerCustomRuntime({ userDataDir, runtimePath: custom, settings });
  const rows = manager.getState({ userDataDir, settings }).installed;
  assert.ok(rows.some(row => row.custom && row.version === custom && row.ready), JSON.stringify(rows.map(row => [row.version, row.custom, row.ready])));
  assert.equal(manager.applySettingsUpdate('setDefault', { version: custom }, settings, { userDataDir }).customDefaults?.default, custom);
  assert.ok(requests.every(url => url.startsWith('https://')), 'only published catalog and asset URLs are requested');
});
