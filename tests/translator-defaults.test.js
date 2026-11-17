const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createManager } = require('../src/modules/shared/runtime/translator-managers');
const Architecture = require('../src/modules/shared/runtime/architecture');
const Description = require('../src/modules/shared/runtime/translator-description');
const { peFixture } = require('./helpers/pe-fixture');

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-defaults-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function installed(manager, userDataDir, version, catalogSourceId = 'upstream') {
  const directory = Architecture.withArchitecture('x64', () => manager.core.getInstallDir({ userDataDir, version }));
  const component = path.join(directory, 'dxvk'); fs.mkdirSync(component, { recursive: true });
  const fixture = peFixture({ is64: true }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
  fs.writeFileSync(path.join(component, 'd3d11.dll'), fixture.bytes);
  const translator = Description.installationDescription(Description.describeTranslator(component, {
    engine: 'dxvk', version, source: { kind: 'upstream', id: catalogSourceId, label: 'DXVK' }
  }));
  const asset = { url: 'https://example.test/dxvk.tar.gz', filename: 'dxvk.tar.gz', sha256: 'a'.repeat(64) };
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({
    version, architecture: 'x64', upstreamRevision: 'declared-source', source: 'download', archiveSha256: asset.sha256,
    catalogEntry: { version, releaseVersion: version, architecture: 'x64', upstreamRevision: 'declared-source', catalogSourceId, asset },
    executableRelative: 'dxvk/d3d11.dll', installationMetadata: { translator, translatorRelative: 'dxvk' }
  }));
  return directory;
}

test('installed translator managers expose explicit defaults while included Wine references remain read-only', t => {
  const userDataDir = scratch(t);
  for (const engine of ['dxvk', 'vkd3d-proton', 'd3dmetal', 'gstreamer', 'mullion', 'dxmt']) {
    const manager = createManager(engine), state = manager.getState({ userDataDir });
    assert.equal(state.supportsDefault, true, engine);
    assert.ok(state.sections.every(section => section.supportsDefault === true), engine);
    assert.deepEqual(manager.applySettingsUpdate('setDefault', { version: '1.2.3' }, {}), { defaultVersion: '1.2.3' }, engine);
  }
  assert.equal(createManager('vkd3d').getState({ userDataDir }).supportsDefault, false);
});

test('a real installed translator default resolves offline and explicit game choices retain precedence', t => {
  const userDataDir = scratch(t), manager = createManager('dxvk');
  installed(manager, userDataDir, '1.10.3'); installed(manager, userDataDir, '2.7');
  const chosen = manager.applySettingsUpdate('setDefault', { version: '1.10.3' }, {});
  const settings = { runtimes: { [manager.id]: chosen } }, snapshot = structuredClone(settings);
  const read = options => Architecture.withArchitecture('x64', () => manager.resolveSelection({}, settings, userDataDir, { verification: 'status', ...options }));
  const state = Architecture.withArchitecture('x64', () => manager.getState({ userDataDir, settings: chosen }));
  assert.equal(state.supportsDefault, true); assert.equal(state.defaultVersion, '1.10.3'); assert.equal(state.defaultSource, 'saved');
  assert.deepEqual(new Set(state.installed.map(row => row.version)), new Set(['1.10.3', '2.7']));
  assert.equal(read().install.version, '1.10.3');
  assert.equal(Architecture.withArchitecture('x64', () => manager.resolveSelection({ runtimeData: { [manager.id]: { version: '2.7' } } }, settings, userDataDir, { verification: 'status' })).install.version, '2.7');
  assert.equal(read({ version: '2.7' }).install.version, '2.7');
  assert.deepEqual(settings, snapshot, 'resolution never writes preferences');
});

test('translator defaults retain CPU and caller compatibility admission', t => {
  const userDataDir = scratch(t), manager = createManager('dxvk');
  installed(manager, userDataDir, '1.10.3'); installed(manager, userDataDir, '2.7');
  const settings = { runtimes: { [manager.id]: { defaultVersion: '1.10.3' } } };
  const compatible = pin => pin.version === '2.7';
  const selected = Architecture.withArchitecture('x64', () => manager.resolveSelection({}, settings, userDataDir, { verification: 'status', compatible }));
  assert.equal(selected.install.version, '2.7', 'an incompatible preference leaves the compatible installed fallback');
  const mismatch = manager.resolveSelection({}, settings, userDataDir, { architecture: 'arm64', verification: 'status',
    compatible: pin => Architecture.matchesArchitecture(pin, 'arm64') });
  assert.equal(mismatch.ready, false); assert.equal(mismatch.install, null);
});

test('translator install and removal never assign a new default preference', t => {
  const userDataDir = scratch(t), manager = createManager('dxvk'), settings = { defaultVersion: '1.10.3' };
  assert.equal(manager.updateSettingsAfterInstall({}, { version: '2.7' }), undefined);
  assert.equal(manager.updateSettingsAfterInstall(settings, { version: '2.7' }), undefined);
  assert.equal(manager.updateSettingsAfterUninstall(settings, { version: '1.10.3' }, { userDataDir }), undefined);
  assert.deepEqual(settings, { defaultVersion: '1.10.3' });
});
