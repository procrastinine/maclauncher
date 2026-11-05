const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const Availability = require('../src/core/game-availability');
const GameStore = require('../src/core/game-store');
const Modules = require('../src/modules/registry');
const CrossOver = require('../src/modules/crossover/main');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-cached-actions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64);
  const vendor = path.join(root, 'vendor');
  for (const name of ['wine', 'wineserver', 'wineloader']) put(`vendor/bin/${name}`, image({ cpu: X64, fileType: 2 }));
  put('vendor/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, installName: '@rpath/ntdll.so' }));
  put('vendor/lib/wine/x86_64-unix/wine', image({ cpu: X64, fileType: 2 }));
  put('vendor/lib/wine/x86_64-windows/d3d9.dll', pe.bytes);
  put('vendor/lib/dxvk/x86_64-windows/d3d9.dll', pe.bytes); put('vendor/lib/dxvk/version', '3.1.1');
  put('vendor/lib64/libgstreamer-1.0.0.dylib', image({ cpu: X64, installName: '@rpath/libgstreamer-1.0.0.dylib' }));
  put('vendor/lib64/gstreamer-1.0/libgstfixture.dylib', image({ cpu: X64, installName: '@rpath/libgstfixture.dylib' }));
  return { root, userDataDir: path.join(root, 'profile'), gamePath: path.join(root, 'disconnected-game'), install: {
    version: 'fixture-crossover', upstreamVersion: '26.3', versionLabel: 'CrossOver 26.3', installDir: vendor, crossoverRoot: vendor,
    executablePath: path.join(vendor, 'bin/wine'), serverPath: path.join(vendor, 'bin/wineserver'), loaderPath: path.join(vendor, 'bin/wineloader'),
    architecture: 'x64', architectures: ['x86_64'] } };
}

test('warm actual backend translator choices and recorded status stay available without game files or binary preparation', async t => {
  const f = fixture(t), runtimeSettings = { translatorRenderer: 'included:d3d-renderer:dxvk' }, context = {
    userDataDir: f.userDataDir, settings: {}, runtimeSettings, logger: { warn() {} } };
  const inventory = await Translators.optionsInventory(f.install, 'crossover', context, { managers: [] });
  const plan = Translators.optionsPlan(inventory, context), recordedRows = Translators.inspectorRows(plan);
  assert.ok(inventory.included.some(item => item.engine === 'dxvk' && item.apis.includes('Direct3D 9')));
  assert.ok(recordedRows.some(row => row.component === 'd3d9' && /DXVK 3\.1\.1/.test(row.used)));
  const host = CrossOver.runtimeManagers.find(manager => manager.id === 'crossover');
  t.mock.method(host, 'resolveSelection', () => ({ ready: true, install: f.install, architecture: 'x64', version: f.install.version }));
  const mod = { ...CrossOver, runtimeManagers: [host], prepareInput: () => assert.fail('Settings and recorded status must not prepare game input') };
  const info = mod.manifest;
  const registry = { listModuleIds: () => [mod.id], listModules: () => [info], getModule: id => id === mod.id ? mod : null,
    getModuleInfo: id => id === mod.id ? info : null, getModuleDir: () => f.root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  for (const method of ['listModuleIds', 'getModule', 'listSharedRuntimeManagers']) t.mock.method(Modules, method, registry[method]);
  const entry = { schemaVersion: GameStore.CURRENT_RECORD_SCHEMA_VERSION, gameId: 'disconnected', moduleId: 'crossover', runtimeId: 'crossover', gamePath: f.gamePath, importPath: f.gamePath,
    runtimeSettings: { crossover: runtimeSettings }, runtimeData: { crossover: { translatorRows: recordedRows, graphicsInputs: { architecture: 'x86_64' } } } };
  GameStore.writeGameRecord(f.userDataDir, entry);
  const recordPath = path.join(f.userDataDir, 'games/disconnected/game.json'), before = fs.readFileSync(recordPath, 'utf8');
  const forbidden = [
    [Binary, 'wineCompatibilityRecord'], [Description, 'inspectFile'], [Description, 'describeTranslator'],
    [Translators, 'resolve'], [Availability, 'checkGameAvailability'], [Availability, 'checkGameAvailabilitySync']
  ].map(([owner, method]) => t.mock.method(owner, method, () => assert.fail(method + ' is launch/preparation work')));
  const { createBackendOperations } = require('../src/core/backend-operations');
  const backend = createBackendOperations({ userDataDir: f.userDataDir, registry });
  t.after(() => backend.beginShutdown());
  const choices = await backend.moduleAction(entry, 'listTranslatorOptions', { runtimeSettings }, {}, { runtimeId: 'crossover' });
  assert.ok(choices && typeof choices === 'object' && !Array.isArray(choices));
  assert.ok(choices.translatorD3D9Options.some(option => option.value === runtimeSettings.translatorRenderer && /DXVK 3\.1\.1/.test(option.label)));
  const settingsChoices = await backend.moduleSettingsAction('crossover', 'listTranslatorOptions', { runtimeId: 'crossover', runtimeSettings });
  assert.deepEqual(settingsChoices.translatorD3D9Options, choices.translatorD3D9Options);
  const status = await backend.moduleAction(entry, 'runtimeStatus', {}, {}, { runtimeId: 'crossover' });
  assert.equal(status.ready, true); assert.deepEqual(status.translatorRows, recordedRows); assert.equal(status.graphicsInputs.architecture, 'x86_64');
  assert.ok(status.details.some(row => row.label === 'Direct3D 9' && /DXVK 3\.1\.1/.test(row.value)));
  assert.equal(fs.existsSync(f.gamePath), false); assert.equal(fs.readFileSync(recordPath, 'utf8'), before);
  assert.ok(forbidden.every(method => method.mock.callCount() === 0));
});

test('Play completes compact native import facts before checking the selected Wine', async t => {
  const f = fixture(t), native = path.join(f.install.crossoverRoot, 'lib/dxvk/x86_64-unix/d3d9.so');
  fs.writeFileSync(path.join(f.install.crossoverRoot, 'lib/wine/x86_64-unix/ntdll.so'), image({ cpu: X64, installName: '@rpath/ntdll.so', symbols: ['different_export'] }));
  fs.mkdirSync(path.dirname(native), { recursive: true });
  const bytes = image({ cpu: X64, dependencies: ['@rpath/ntdll.so'], symbols: ['required_missing_import'] });
  bytes.writeUInt32LE(0x80, 24);
  let cursor = 32;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(cursor) === 2) {
      const symbols = bytes.readUInt32LE(cursor + 8);
      bytes[symbols + 4] = 1; bytes[symbols + 5] = 0; bytes.writeUInt16LE(1 << 8, symbols + 6);
    }
    cursor += bytes.readUInt32LE(cursor + 4);
  }
  fs.writeFileSync(native, bytes);
  const context = { userDataDir: f.userDataDir, settings: {}, runtimeSettings: { translatorRenderer: 'included:d3d-renderer:dxvk' }, logger: { warn() {} } };
  await Translators.optionsInventory(f.install, 'crossover', context, { managers: [] });
  delete require.cache[require.resolve('../src/modules/shared/runtime/translator-description')];
  const cold = require('../src/modules/shared/runtime/translator-description');
  t.mock.method(Description, 'cachedTranslator', cold.cachedTranslator);
  const input = await Translators.optionsInventory(f.install, 'crossover', context, { managers: [] });
  assert.equal(input.included.find(item => item.engine === 'dxvk').files.find(file => file.path === native).slices[0].importsComplete, false);
  const plan = await Translators.resolve(f.install, 'crossover', context, { managers: [], executableArchitecture: 'x86_64', host: { macOSVersion: '26.0' } });
  const actual = plan.compatibility['included:d3d-renderer:dxvk'];
  assert.equal(actual.compatible, false); assert.match(actual.reason, /required_missing_import/);
});
