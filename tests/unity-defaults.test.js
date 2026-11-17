const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createManager } = require('../src/modules/unity/runtime/manager').__test;
const Package = require('../src/modules/unity/runtime/package');
const Launch = require('../src/modules/unity/launch');
const Native = require('../src/modules/shared/runtime/local-native');
const Architecture = require('../src/modules/shared/runtime/architecture');
const { image } = require('./fixtures/macho-image');

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unity-defaults-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function installed(manager, userDataDir, version) {
  const directory = Architecture.withArchitecture('arm64', () => manager.core.getInstallDir({ userDataDir, version }));
  const player = path.join(directory, 'player'), executable = path.join(player, 'UnityPlayer.app/Contents/MacOS/UnityPlayer');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, image({ fileType: 2 }), { mode: 0o755 });
  const revision = '9957aee8edc2', profile = { schemaVersion: 1, version, revision, scriptingBackend: 'mono',
    templateRelative: 'UnityPlayer.app', architectures: ['arm64'], ...Package.inventory(player) };
  const file = path.join(directory, 'player-profile.json'); fs.writeFileSync(file, JSON.stringify(profile));
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({ version, architecture: 'arm64', upstreamRevision: revision,
    source: 'local', runtimePath: executable, binarySha256: Native.hashFile(executable),
    catalogEntry: { version, architecture: 'arm64', upstreamRevision: revision },
    installationMetadata: { profileSha256: Native.hashFile(file) }
  }));
  return executable;
}

test('Unity Mono exposes explicit defaults without choosing one during install or removal', t => {
  const userDataDir = scratch(t), manager = createManager(), state = manager.getState({ userDataDir });
  assert.equal(state.supportsDefault, true); assert.equal(state.sections[0].supportsDefault, true);
  assert.deepEqual(manager.applySettingsUpdate('setDefault', { version: '2020.1.17f1' }, {}), { defaultVersion: '2020.1.17f1' });
  assert.equal(manager.updateSettingsAfterInstall({}, { version: '2020.1.17f1' }), undefined);
  assert.equal(manager.updateSettingsAfterUninstall({ defaultVersion: '2020.1.17f1' }, { version: '2020.1.17f1' }, { userDataDir }), undefined);
});

test('Unity defaults use only the exact detected compatible player and preserve explicit mismatch refusal', t => {
  const userDataDir = scratch(t), manager = createManager(), exact = '2020.1.17f1', other = '2020.1.18f1';
  installed(manager, userDataDir, exact); installed(manager, userDataDir, other);
  const entry = { moduleData: { detectedVersion: exact } };
  const selected = version => manager.resolveSelection(entry, { runtimes: { unity: { defaultVersion: version } } }, userDataDir);
  assert.equal(selected(exact).ready, true); assert.equal(selected(exact).version, exact);
  assert.equal(selected(other).ready, true); assert.equal(selected(other).version, exact);
  assert.equal(Launch.validateSelection({ detectedVersion: exact }, selected(other)).version, exact);
  const mismatch = manager.resolveSelection({ ...entry, runtimeData: { unity: { version: other } } }, { runtimes: { unity: { defaultVersion: exact } } }, userDataDir);
  assert.equal(mismatch.ready, false); assert.match(mismatch.reason, /different player version/);
  assert.throws(() => Launch.validateSelection({ detectedVersion: exact }, { ...selected(exact), version: other }), /different version/);
  const missing = manager.resolveSelection({}, { runtimes: { unity: { defaultVersion: exact } } }, userDataDir);
  assert.equal(missing.ready, false); assert.equal(missing.version, null); assert.match(missing.reason, /exact Unity player version/);
});

test('an exact Unity preference still verifies its complete player profile', t => {
  const userDataDir = scratch(t), manager = createManager(), version = '2020.1.17f1';
  const file = installed(manager, userDataDir, version), settings = { runtimes: { unity: { defaultVersion: version } } };
  const entry = { moduleData: { detectedVersion: version } }, before = structuredClone(settings);
  assert.equal(manager.resolveSelection(entry, settings, userDataDir).ready, true);
  fs.appendFileSync(file, Buffer.from('changed'));
  const changed = manager.resolveSelection(entry, settings, userDataDir);
  assert.equal(changed.ready, false); assert.equal(changed.profile, null);
  assert.deepEqual(settings, before);
});

test('registered Unity defaults retain exact detection and explicit game compatibility', async t => {
  const userDataDir = scratch(t), manager = createManager(), exact = '2020.1.17f1', other = '2020.1.18f1';
  const file = installed(manager, userDataDir, exact); installed(manager, userDataDir, other);
  const directory = path.resolve(file, '../../../../../');
  const Custom = require('../src/modules/shared/runtime/custom-runtime'); Custom.instrumentManagers([manager]);
  await manager.registerCustomRuntime({ userDataDir, runtimePath: directory, sectionId: 'default' });
  const preference = manager.applySettingsUpdate('setDefault', { version: directory }, {});
  const settings = { runtimes: { unity: preference } };
  const selected = manager.resolveSelection({ moduleData: { detectedVersion: exact } }, settings, userDataDir);
  assert.equal(selected.ready, true); assert.equal(selected.version, exact);
  assert.equal(Launch.validateSelection({ detectedVersion: exact }, selected).profile.templatePath, selected.profile.templatePath);
  const different = manager.resolveSelection({ moduleData: { detectedVersion: other } }, settings, userDataDir);
  assert.equal(different.ready, true); assert.equal(different.version, other);
  const missing = manager.resolveSelection({}, settings, userDataDir);
  assert.equal(missing.ready, false); assert.match(missing.reason, /exact Unity player version/);
  const explicit = manager.resolveSelection({ moduleData: { detectedVersion: other }, runtimeData: { unity: { version: directory } } }, settings, userDataDir);
  assert.equal(explicit.ready, false); assert.match(explicit.reason, /selected player provides/);
});
