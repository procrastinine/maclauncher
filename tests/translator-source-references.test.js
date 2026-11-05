const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Component = require('../src/modules/shared/runtime/component-runtime');
const Description = require('../src/modules/shared/runtime/translator-description');
const Wine = require('../src/modules/shared/runtime/wine-translators');
const Managers = require('../src/modules/shared/runtime/translator-managers');
const { createArchitectureManager } = require('../src/modules/shared/runtime/architecture-manager');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-source-reference-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const dll = marker => {
    const f = peFixture({ is64: true }); f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); f.bytes.write('Wine builtin DLL\0', 64);
    return Buffer.concat([f.bytes, Buffer.from(marker)]);
  };
  function host(relative, architecture, version, templateVersion, damaged = false) {
    const installDir = path.join(root, relative), engineRoot = path.join(installDir, 'wine');
    const executablePath = put(relative + '/wine/bin/wine', image({ cpu: X64, fileType: 2 }));
    put(relative + '/wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
    const renderer = relative + '/support/Frameworks/renderer/dxvk';
    put(renderer + '/d3d11.dll', dll(version)); put(renderer + '/version', version);
    return { installDir, engineRoot, executablePath, architecture, version, templateVersion,
      templateRoot: path.join(installDir, 'support'), ready: !damaged, ...(damaged ? { status: 'damaged', variant: 'legacy' } : {}) };
  }
  const older = host('legacy-flat-host', 'x64', '2.4', '1.0.20', true), newer = host('arm64-host', 'arm64', '3.1.1', '1.0.24');
  const capabilities = { platform: 'darwin', hardwareArch: 'arm64', rosettaAvailable: true };
  const facade = createArchitectureManager({ id: 'sikarugir', dependencies: { hostCapabilities: capabilities } }, ({ installationArchitecture }) => {
    const installed = [older, newer].filter(row => row.architecture === installationArchitecture);
    return { id: 'sikarugir', core: { listInstalled() { assert.fail('Source references must use ordinary facade installed rows'); } },
      getState: () => ({ installed, versionLabels: Object.fromEntries(installed.map(row => [row.version, 'Wine fixture · Template ' + row.templateVersion])) }),
      normalizeSettings: settings => settings || {}, offersBuild: () => true };
  });
  const vendor = path.join(root, 'CrossOver.app/Contents/SharedSupport/CrossOver');
  const executablePath = put('CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine', image({ cpu: X64, fileType: 2 }));
  put('CrossOver.app/Contents/SharedSupport/CrossOver/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
  put('CrossOver.app/Contents/SharedSupport/CrossOver/lib/dxvk/d3d11.dll', dll('cross'));
  const cross = { appPath: path.join(root, 'CrossOver.app'), crossoverRoot: vendor, installDir: vendor, executablePath,
    version: 'local-fixture', upstreamVersion: '26.3', architecture: 'x64', ready: true };
  const Main = require('../src/modules/crossover/main'), registry = require('../src/modules/registry'), original = registry.getModule;
  const owner = { ...Main, runtimeManagers: [facade, { id: 'crossover', getState: () => ({ installed: [cross] }) }] };
  t.mock.method(registry, 'getModule', id => id === 'crossover' ? owner : original(id));
  return { root, put, dll, older, newer, facade, cross, Main, userDataDir: path.join(root, 'profile') };
}

test('source-owned component choices reuse ordinary facade rows across CPUs and preserve damaged-host component identities', async t => {
  const f = fixture(t), manager = Managers.createManager('dxvk'), options = { userDataDir: f.userDataDir, logger: { warn() {} } };
  let liveInspections = 0;
  const inspect = Description.describeTranslator;
  t.mock.method(Description, 'describeTranslator', (...args) => { liveInspections++; return inspect(...args); });
  assert.equal((manager.getState(options).references || []).length, 0);
  assert.equal(liveInspections, 0, 'a cold state request does not synchronously inspect component payloads');
  await manager.prepareLocalState(options);
  const before = liveInspections, records = Component.referencedComponents('dxvk', options), state = manager.getState(options);
  assert.equal(liveInspections, before, 'prepared getters reuse cached component facts');
  assert.equal(records.length, 3); assert.equal(state.references.length, 3); assert.equal(state.installed.length, 0);
  const legacy = records.find(row => row.install.version === f.older.version);
  assert.equal(legacy.install.ready, false); assert.equal(legacy.install.architecture, 'x64');
  assert.equal(legacy.reference.managerId, 'sikarugir'); assert.equal(legacy.reference.version, f.older.version);
  assert.equal(legacy.description.files[0].format, 'pe'); assert.equal(legacy.install.variant, 'legacy');
  assert.ok(state.references.every(row => row.readOnly && row.removable === false && row.supportsDefault === false));
  const hostState = f.facade.getState;
  let hostQueries = 0;
  t.mock.method(f.facade, 'getState', (...args) => { hostQueries++; return hostState(...args); });
  const referenceStates = new Map();
  Component.referencedComponents('dxvk', { ...options, referenceStates });
  Component.referencedComponents('dxmt', { ...options, referenceStates });
  assert.equal(hostQueries, 1, 'one query reuses ordinary host state across component engines');
  const context = { userDataDir: f.userDataDir, settings: {}, runtimeSettings: {}, logger: { warn() {} } };
  const inventory = await Wine.optionsInventory(f.cross, 'crossover', context, { managers: [manager] });
  const borrowed = inventory.choices.filter(row => row.reference?.managerId === 'sikarugir');
  assert.equal(borrowed.length, 2); assert.ok(borrowed.every(row => row.included === false));
  const selected = borrowed.find(row => row.reference.version === f.older.version);
  assert.equal(selected.managerId, 'sikarugir'); assert.equal(selected.runtimeVersion, f.older.version);
  assert.equal(selected.architecture, f.older.architecture); assert.equal(selected.variant, f.older.variant);
  assert.equal(borrowed.find(row => row.reference.version === f.newer.version).architecture, f.newer.architecture,
    'runtime-use identity retains the source package CPU, independently of the selected Wine consumer');
  assert.ok(inventory.included.every(row => row.source.runtime === 'crossover'), 'borrowed copies never enter the selected Wine fallback set');
  for (const runtime of ['crossover', 'sikarugir']) {
    const install = runtime === 'crossover' ? f.cross : f.newer;
    const result = await f.Main.__test.translatorOptions({ runtimeId: runtime }, {}, { ...context, runtimeId: runtime }, {
      runtimeManager: { resolveSelection: () => ({ ready: true, install }) }, managers: [manager]
    });
    const choices = result.translatorD3D11Options;
    assert.ok(choices.some(row => row.value === selected.id), 'an independent component in a legacy damaged host remains selectable');
    assert.ok(choices.some(row => /3\.1\.1/.test(row.label)), 'the other CPU host component is also offered');
    if (runtime === 'sikarugir') assert.equal(choices.some(row => row.value.startsWith('reference:') && row.value.includes('CrossOver.app')), false,
      'CrossOver-owned copies retain their existing runtime restriction');
  }
  assert.equal(f.facade.getState(options).installed.find(row => row.version === f.older.version).ready, false);
});

test('custom component status is cache-only while legacy preparation and default full verification keep actual source inspection', async t => {
  const f = fixture(t), manager = Managers.createManager('dxvk'), input = path.join(f.root, 'PublisherSDK');
  const dll = f.put('PublisherSDK/dxvk/d3d11.dll', f.dll('registered'));
  f.put('PublisherSDK/dxvk/version', '3.1.1');
  const registration = path.join(f.userDataDir, 'runtimes', manager.id, 'custom-runtimes.json');
  fs.mkdirSync(path.dirname(registration), { recursive: true });
  fs.writeFileSync(registration, JSON.stringify({ schemaVersion: 1, runtimes: [{ path: input, sectionId: 'default', registeredAt: '2026-11-05T00:00:00Z', data: {} }] }));
  let inspections = 0;
  const inspect = Description.describeTranslator;
  t.mock.method(Description, 'describeTranslator', (...args) => { inspections++; return inspect(...args); });
  const options = { userDataDir: f.userDataDir, logger: { warn() {} } };
  const pending = manager.getState(options).installed.find(row => row.custom);
  assert.equal(pending.ready, false); assert.match(pending.reason, /being prepared/);
  assert.equal(manager.resolveSelection({}, {}, f.userDataDir, { version: input, verification: 'status' }).ready, false);
  assert.equal(inspections, 0, 'cold registered status does not scan or parse its payload');
  const bytes = fs.readFileSync(dll);
  await manager.prepareLocalState(options);
  const before = inspections, ready = manager.getState(options).installed.find(row => row.custom);
  assert.equal(ready.ready, true); assert.equal(ready.translatorRoot, path.dirname(dll));
  assert.equal(manager.resolveSelection({}, {}, f.userDataDir, { version: input, verification: 'status' }).ready, true);
  assert.equal(inspections, before, 'prepared status uses the persistent description facts');
  assert.equal(manager.resolveSelection({}, {}, f.userDataDir, { version: input }).ready, true);
  assert.ok(inspections > before, 'default full verification retains the actual source inspector');
  await manager.registerCustomRuntime({ runtimePath: input, userDataDir: f.userDataDir });
  const record = JSON.parse(fs.readFileSync(registration, 'utf8')).runtimes[0];
  assert.equal(record.data.root, path.dirname(dll)); assert.equal(record.data.source, 'custom');
  assert.equal(record.data.files, undefined, 'registration data stores only its ordinary root/source metadata');
  assert.deepEqual(fs.readFileSync(dll), bytes);
  fs.writeFileSync(dll, 'not a PE library');
  assert.equal(manager.resolveSelection({}, {}, f.userDataDir, { version: input }).ready, false, 'invalid source bytes are not accepted by full verification');
});
