const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Loader = require('../src/modules/shared/vulkan/loader-manager');
const Libraries = require('../src/modules/shared/vulkan/libraries');
const Architecture = require('../src/modules/shared/runtime/architecture');
const { image } = require('./fixtures/macho-image');

function fixture(t) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wine-driver-loader-')));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const loader = Loader.createManager({ systemVersionSync: () => '26.0', upstream: { discover: async () => assert.fail('No release discovery before consent') } });
  const driver = Libraries.createManager('kosmickrisp', { systemVersionSync: () => '26.0', loaderManager: loader });
  const context = { userDataDir, settings: {}, runtimeId: 'sikarugir', translatorPlan: { layout: { architecture: 'arm64' },
    components: { 'vulkan-driver': { used: { managerId: driver.id, architecture: 'arm64', runtimeVersion: '3.4.0' } } } },
    confirmRuntimeInstall: () => assert.fail('Requirement collection must not prompt') };
  return { userDataDir, loader, driver, context };
}

test('a selected legacy Wine driver includes its managed loader in the first requirement collection', async t => {
  const { driver, loader, context } = fixture(t);
  const expected = Loader.requirements(context, { manager: loader, architecture: 'arm64' });
  assert.equal(expected.length, 1); assert.equal(expected[0].managerId, loader.id);
  assert.deepEqual(await Translators.driverRequirements(context, { managers: [driver] }), expected);
  context.translatorPlan.components['vulkan-driver'] = { selected: { managerId: driver.id }, fallback: true, used: null };
  assert.deepEqual(await Translators.driverRequirements(context, { managers: [driver] }), [], 'a rejected driver does not acquire a loader');
  const managed = require('../src/modules/shared/vulkan/managed').manager;
  context.translatorPlan.components['vulkan-driver'] = { used: { managerId: managed.id, architecture: 'arm64' } };
  assert.deepEqual(await Translators.driverRequirements(context, { managers: [managed] }), [], 'the complete managed package keeps its own closure');
});

test('the ordinary first Wine consent contains both missing driver and loader before discovery or installation', async t => {
  const { driver, loader, context } = fixture(t), questions = [];
  context.confirmRuntimeInstall = async question => { questions.push(question); return false; };
  const mod = { id: 'wine-driver-consent', runtimeManagers: [driver, loader],
    ensureRuntime: () => ({ managerId: driver.id, version: '3.4.0', requiresDownload: true, installOptions: { architecture: 'arm64' } }),
    getRuntimeRequirements: () => Translators.driverRequirements(context, { managers: [driver] }) };
  const registry = { listModuleIds: () => [mod.id], getModule: () => mod };
  const result = await require('../src/core/runtime-preparation').prepareForLaunch({ entry: {}, mod, info: { runtime: {} }, registry, context,
    install: () => assert.fail('Declined consent must not install'), runAction: () => assert.fail('No launch action is requested') });
  assert.equal(result, false); assert.equal(questions.length, 1);
  assert.equal(questions[0].managerId, driver.id);
  assert.ok(questions[0].companions.some(item => item.label === loader.label));
});

test('an installed compatible loader is reused offline and recorded without another request', async t => {
  const { driver, loader, context, userDataDir } = fixture(t), version = '1.4.321';
  const directory = Architecture.withArchitecture('arm64', () => loader.core.getInstallDir({ userDataDir, version }));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'libvulkan.1.dylib'), image({ installName: '@rpath/libvulkan.1.dylib' }), { mode: 0o755 });
  const asset = { url: 'https://example.test/loader.tar.gz', filename: 'loader.tar.gz', sha256: 'a'.repeat(64) };
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({ version, architecture: 'arm64', upstreamRevision: 'declared-loader',
    source: 'download', archiveSha256: asset.sha256, executableRelative: 'libvulkan.1.dylib',
    catalogEntry: { version, architecture: 'arm64', upstreamRevision: 'declared-loader', asset } }));
  const uses = []; context.recordRuntimeUse = value => uses.push(value);
  assert.deepEqual(await Translators.driverRequirements(context, { managers: [driver] }), []);
  assert.equal(uses.length, 1); assert.equal(uses[0].managerId, loader.id); assert.equal(uses[0].version, version);
});
