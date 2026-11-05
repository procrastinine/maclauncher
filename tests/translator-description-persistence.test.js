const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-persisted-facts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function dll() {
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
  pe.bytes.write('Wine builtin DLL\0', 64); return pe.bytes;
}
function importingNative() {
  const bytes = image({ cpu: X64, dependencies: ['@rpath/ntdll.so'], symbols: ['scratch_import'] });
  bytes.writeUInt32LE(0x80, 24);
  let cursor = 32;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(cursor) === 2) {
      const symbols = bytes.readUInt32LE(cursor + 8);
      bytes[symbols + 4] = 1; bytes[symbols + 5] = 0; bytes.writeUInt16LE(1 << 8, symbols + 6);
    }
    cursor += bytes.readUInt32LE(cursor + 4);
  }
  return bytes;
}
function observeReads(t, binaries) {
  const handles = new Map(), counts = { reads: 0, directories: 0 }, open = fs.openSync, read = fs.readSync, close = fs.closeSync, readdir = fs.readdirSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { const fd = open(file, ...args); handles.set(fd, String(file)); return fd; });
  t.mock.method(fs, 'readSync', (fd, ...args) => { if (binaries.has(handles.get(fd))) counts.reads++; return read(fd, ...args); });
  t.mock.method(fs, 'closeSync', fd => { handles.delete(fd); return close(fd); });
  t.mock.method(fs, 'readdirSync', (...args) => {
    if ([...binaries].some(file => String(args[0]) === path.dirname(file) || String(args[0]).startsWith(path.dirname(file) + path.sep))) counts.directories++;
    return readdir(...args);
  });
  return counts;
}
function freshDescription(t) {
  const file = require.resolve('../src/modules/shared/runtime/translator-description'), previous = require.cache[file];
  delete require.cache[file]; const result = require(file);
  t.after(() => { require.cache[file] = previous; }); return result;
}

test('description preparation persists compact facts and a cold cache-only reader never opens unchanged binaries or walks directories', async t => {
  const root = scratch(t), component = path.join(root, 'component'), userDataDir = path.join(root, 'profile');
  fs.mkdirSync(component); const pe = path.join(component, 'd3d11.dll'), native = path.join(component, 'winemetal.so');
  fs.writeFileSync(pe, dll()); fs.writeFileSync(native, importingNative());
  const counts = observeReads(t, new Set([pe, native])), options = { engine: 'dxmt', source: { label: 'Scratch' }, userDataDir, logger: { warn() {} } };
  assert.equal(Description.cachedTranslator(component, options), null); assert.deepEqual(counts, { reads: 0, directories: 0 });
  const prepared = await Description.prepareTranslator(component, options); assert.ok(counts.reads > 0); assert.ok(counts.directories > 0);
  assert.equal(prepared.files.find(file => file.path === pe).machine, 0x8664);
  const cachedNative = prepared.files.find(file => file.path === native);
  assert.equal(cachedNative.slices[0].importsComplete, false); assert.equal(Object.hasOwn(cachedNative.slices[0], 'imports'), false);
  const live = Description.describeTranslator(component, options);
  assert.equal(live.files.find(file => file.path === native).slices[0].imports[0].symbol, 'scratch_import');
  const peReader = require('../src/modules/shared/runtime/pe-exports');
  const parsePe = t.mock.method(peReader, 'readPeExports', () => assert.fail('Validated persisted PE facts must not be reparsed'));
  const open = fs.openSync, peOpen = t.mock.method(fs, 'openSync', (file, ...args) => {
    assert.notEqual(String(file), pe, 'The live transition reads native imports without reopening unchanged PE files'); return open(file, ...args);
  });
  const after = { ...counts }, cold = freshDescription(t), cached = cold.cachedTranslator(component, options);
  assert.ok(cached); assert.deepEqual(counts, after, 'a second module instance reads the persisted observation record only');
  const liveFromCache = cold.describeTranslator(component, options), actualNative = liveFromCache.files.find(file => file.path === native);
  assert.equal(actualNative.slices[0].importsComplete, true); assert.equal(actualNative.slices[0].imports[0].symbol, 'scratch_import');
  assert.equal(liveFromCache.files.find(file => file.path === pe).machine, 0x8664); assert.equal(liveFromCache.files.find(file => file.path === pe).form, 'builtin');
  assert.equal(parsePe.mock.callCount(), 0); assert.ok(counts.reads > after.reads, 'native symbol facts are completed from the actual image');
  parsePe.mock.restore(); peOpen.mock.restore();
  cached.files.length = 0; cached.source.label = 'caller mutation';
  assert.equal(cold.cachedTranslator(component, options).files.length, 2); assert.equal(cold.cachedTranslator(component, options).source.label, 'Scratch');
  const files = fs.readdirSync(path.join(userDataDir, 'cache/translator-descriptions'));
  assert.equal(files.length, 1); assert.equal(fs.readFileSync(path.join(userDataDir, 'cache/translator-descriptions', files[0]), 'utf8').includes('scratch_import'), false);
  const beforeMetadataChange = counts.reads;
  Description.describeTranslator(component, { ...options, source: { label: 'Another source label' } });
  assert.equal(counts.reads, beforeMetadataChange, 'different descriptive metadata reuses the same observed binary facts');
  const fileOptions = { ...options, source: 'single-file' }, fileDescription = await Description.prepareTranslator(pe, fileOptions);
  assert.equal(fileDescription.root, pe); assert.equal(fileDescription.files[0].path, pe); assert.equal(fileDescription.files[0].relative, 'd3d11.dll');
  const single = freshDescription(t).cachedTranslator(pe, fileOptions);
  assert.equal(single.files[0].path, pe); assert.equal(Description.restoreInstallationDescription(pe, Description.installationDescription(single)).files[0].path, pe);

  const core = path.join(root, 'libgstreamer-1.0.0.dylib'), bytes = image({ cpu: X64, installName: '@rpath/libgstreamer-1.0.0.dylib' });
  let cursor = 32;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(cursor) === 13) bytes.writeUInt32LE(2612 << 16, cursor + 16);
    cursor += bytes.readUInt32LE(cursor + 4);
  }
  fs.writeFileSync(core, bytes);
  assert.equal((await Description.prepareTranslator(core, { engine: 'gstreamer', userDataDir })).version, '1.26.11');
});

test('cache-only reads return a miss for changed bytes, metadata, directory entries or aliases without inspecting them', async t => {
  const root = scratch(t), component = path.join(root, 'component'), userDataDir = path.join(root, 'profile');
  fs.mkdirSync(component); const pe = path.join(component, 'd3d11.dll'); fs.writeFileSync(pe, dll());
  const counts = observeReads(t, new Set([pe])), options = { engine: 'dxvk', userDataDir, logger: { warn() {} } };
  await Description.prepareTranslator(component, options);
  const before = fs.statSync(pe), changed = dll(); changed[64] = 88; fs.writeFileSync(pe, changed); fs.utimesSync(pe, before.atime, before.mtime);
  const afterChange = { ...counts }; assert.equal(Description.cachedTranslator(component, options), null); assert.deepEqual(counts, afterChange);
  assert.equal((await Description.prepareTranslator(component, options)).files[0].form, 'native');
  fs.writeFileSync(path.join(component, 'version'), 'actual release');
  assert.equal(Description.cachedTranslator(component, options), null); assert.equal((await Description.prepareTranslator(component, options)).version, 'actual release');
  fs.writeFileSync(path.join(component, 'd3d9.dll'), dll());
  assert.equal(Description.cachedTranslator(component, options), null); assert.equal((await Description.prepareTranslator(component, options)).files.length, 2);
  const second = path.join(root, 'other'); fs.mkdirSync(second); fs.writeFileSync(path.join(second, 'd3d8.dll'), dll());
  const alias = path.join(root, 'alias'); fs.symlinkSync(component, alias);
  await Description.prepareTranslator(alias, options); fs.unlinkSync(alias); fs.symlinkSync(second, alias);
  assert.equal(Description.cachedTranslator(alias, options), null); assert.deepEqual((await Description.prepareTranslator(alias, options)).apis, ['Direct3D 8']);
});

test('a cold ordinary translator manager hydrates its existing managed installation description without opening or scanning the payload', t => {
  const root = scratch(t), runtime = require('../src/modules/shared/runtime/translator-managers').createManager('dxvk');
  const Architecture = require('../src/modules/shared/runtime/architecture');
  const version = 'scratch-managed', directory = Architecture.withArchitecture('x64', () => runtime.core.getInstallDir({ userDataDir: root, version })), component = path.join(directory, 'dxvk');
  fs.mkdirSync(component, { recursive: true }); const pe = path.join(component, 'd3d11.dll'); fs.writeFileSync(pe, dll());
  const translator = Description.installationDescription(Description.describeTranslator(component, { engine: 'dxvk', source: 'upstream', version: 'observed release' }));
  const asset = { url: 'https://example.test/dxvk.tar.gz', filename: 'dxvk.tar.gz', sha256: 'a'.repeat(64) };
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({ version, architecture: 'x64', upstreamRevision: 'scratch-source', source: 'download',
    catalogEntry: { version, architecture: 'x64', upstreamRevision: 'scratch-source', asset }, executableRelative: 'dxvk/d3d11.dll', archiveSha256: asset.sha256,
    installationMetadata: { translator, translatorRelative: 'dxvk' } }));
  const counts = observeReads(t, new Set([pe]));
  const selected = Architecture.withArchitecture('x64', () => runtime.core.resolveInstalled({ userDataDir: root, version, verification: 'status' }));
  assert.ok(selected); assert.equal(selected.translatorRoot, component); assert.equal(selected.translator.version, 'observed release');
  assert.equal(selected.translator.files[0].path, pe); assert.deepEqual(selected.translator.apis, ['Direct3D 11']);
  assert.deepEqual(counts, { reads: 0, directories: 0 });
});

test('a cold ordinary Vulkan manager hydrates persisted native CPU and hash facts without reparsing or hashing its payload', t => {
  const root = scratch(t), Architecture = require('../src/modules/shared/runtime/architecture');
  const runtime = require('../src/modules/shared/vulkan/libraries').createManager('moltenvk', { hostArch: 'arm64', systemVersionSync: () => '26.0' });
  const version = '1.2.10', directory = Architecture.withArchitecture('x64', () => runtime.core.getInstallDir({ userDataDir: root, version }));
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'libMoltenVK.dylib');
  fs.writeFileSync(file, image({ cpu: X64, installName: '@rpath/libMoltenVK.dylib' }));
  const translator = Description.installationDescription(Description.describeTranslator(directory, { engine: 'moltenvk', version, source: 'upstream' }));
  const sha256 = require('../src/modules/shared/runtime/pinned-native-manager').hashFile(file);
  const asset = { url: 'https://example.test/moltenvk.tar.gz', filename: 'moltenvk.tar.gz', sha256: 'b'.repeat(64) };
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({ version, architecture: 'x64', upstreamRevision: 'scratch-source', source: 'download', binarySha256: sha256,
    catalogEntry: { version, architecture: 'x64', upstreamRevision: 'scratch-source', asset }, executableRelative: 'libMoltenVK.dylib', archiveSha256: asset.sha256,
    installationMetadata: { translator, backend: 'moltenvk', minimumMacOS: '13.0', libraries: [{ file: 'libMoltenVK.dylib', sha256 }] } }));
  const counts = observeReads(t, new Set([file]));
  const selected = Architecture.withArchitecture('x64', () => runtime.core.resolveInstalled({ userDataDir: root, version, verification: 'status' }));
  assert.ok(selected); assert.equal(selected.translatorRoot, directory); assert.equal(selected.executablePath, file);
  assert.deepEqual(selected.architectures, ['x86_64']); assert.equal(selected.sha256, sha256); assert.equal(selected.binarySha256, sha256);
  assert.equal(selected.needsRosetta, true); assert.equal(selected.translator.files[0].path, file);
  assert.deepEqual(counts, { reads: 0, directories: 0 });
});

test('a cold custom Vulkan status uses cached driver and loader facts while full selection still rejects a missing Kosmic loader', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'profile'), component = path.join(root, 'kosmickrisp');
  fs.mkdirSync(component); const driver = path.join(component, 'libvulkan_kosmickrisp.dylib'), loader = path.join(component, 'libvulkan.1.dylib');
  fs.writeFileSync(driver, image({ cpu: X64, installName: '@rpath/libvulkan_kosmickrisp.dylib' }));
  fs.writeFileSync(loader, image({ cpu: X64, installName: '@rpath/libvulkan.1.dylib' }));
  const alias = path.join(root, 'registered-driver.dylib'); fs.symlinkSync(driver, alias);
  const Modules = require('../src/modules/registry');
  t.mock.method(Modules, 'getModule', () => ({ manifest: { runtime: { manager: {} } }, runtimeManagers: [] }));
  const Libraries = require('../src/modules/shared/vulkan/libraries');
  const runtime = Libraries.createManager('kosmickrisp', { hostArch: 'arm64', systemVersionSync: () => '26.0' });
  const registered = await runtime.registerCustomRuntime({ userDataDir, runtimePath: alias });
  assert.equal(registered.version, alias); assert.equal(registered.executablePath, driver);
  assert.deepEqual(new Set(registered.translator.files.map(file => file.path)), new Set([driver, loader]));
  const cold = freshDescription(t), another = Libraries.createManager('kosmickrisp', { hostArch: 'arm64', systemVersionSync: () => '26.0' });
  const counts = observeReads(t, new Set([driver, loader]));
  const inspect = t.mock.method(cold, 'describeTranslator', () => assert.fail('Warm custom status cannot invoke live description inspection'));
  const state = another.getState({ userDataDir }), row = state.installed.find(row => row.version === alias);
  assert.ok(row); assert.equal(row.ready, true); assert.equal(row.executablePath, driver); assert.equal(row.translator.root, component);
  assert.deepEqual(new Set(row.translator.files.map(file => file.path)), new Set([driver, loader]));
  const status = another.resolveSelection(null, {}, userDataDir, { version: alias, architecture: 'x64', verification: 'status' });
  assert.equal(status.ready, true); assert.equal(status.install.executablePath, driver);
  assert.deepEqual(new Set(status.install.translator.files.map(file => file.path)), new Set([driver, loader]));
  assert.deepEqual(counts, { reads: 0, directories: 0 }); assert.equal(inspect.mock.callCount(), 0);
  inspect.mock.restore(); fs.unlinkSync(loader);
  assert.throws(() => another.customRuntime.inspect(alias, { userDataDir, data: { root: component, source: 'custom' }, verification: 'full' }),
    error => error.code === 'ENOENT' && error.path === loader);
  assert.equal(another.resolveSelection(null, {}, userDataDir, { version: alias, architecture: 'x64', verification: 'full' }).ready, false);
});
