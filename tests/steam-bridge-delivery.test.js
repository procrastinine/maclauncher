const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Bridge = require('../src/modules/crossover/runtime/steam-bridge');
const Components = require('../src/modules/crossover/runtime/steam-client-components');

test('Play chooses and installs a newer catalog bridge with additional manifest fields', async t => {
  const { packageFor } = require('./helpers/managed-tool-fixture.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-bridge-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'maclauncher-steam-bridge', versions = ['2.0.0', '97.3.0', '1.0.0'];
  const packages = versions.map(version => packageFor(path.join(root, version), {
    id, version, architecture: 'universal',
    manifest: { managerId: id, executableRelative: 'steam.exe', dependencies: [],
      steamBridge: { native: {}, windows: {}, futureCapability: { enabled: true }, abi: 42, role: 'future-role' } },
    entries: [{ path: 'steam.exe', bytes: Buffer.from('non-executable package inspection input'), mode: 0o644 }]
  }));
  const oldInstall = Components.install;
  Components.install = async () => null;
  t.after(() => { Components.install = oldInstall; });
  const downloads = [];
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '123' }), discoverClient: () => '/client',
    dependencies: { systemVersionSync: () => '27.0',
      fetchUrlBuffer: async () => ({ status: 200, body: Buffer.from(JSON.stringify({
        schemaVersion: 2, projectId: id, updatePolicy: 'manual', packages: packages.map(item => item.record) })) }),
      downloadToFile: async (url, destination) => {
        const selected = packages.find(item => item.record.asset.url === url);
        downloads.push(selected.record.version); fs.copyFileSync(selected.archive, destination);
      } } });
  const context = { userDataDir: path.join(root, 'profile') };
  await bridge.refreshCatalog({ ...context, force: true });
  const [plan] = await bridge.requirements({}, context);
  assert.equal(plan.version, '97.3.0');
  const installed = await bridge.installRuntime({ ...context, version: plan.version });
  assert.equal(installed.version, '97.3.0');
  assert.equal(bridge.resolveSelection(null, {}, context.userDataDir, { version: plan.version }).ready, true);
  assert.deepEqual(downloads, ['97.3.0']);
});

test('declined optional bridge stays quiet until explicit refresh permits a new offer', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-bridge-consent-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '123' }), discoverClient: () => '/discovered/client' });
  const context = { userDataDir }, [plan] = await bridge.requirements({}, context);
  assert.equal(plan.optional, true); assert.equal(plan.silentFallback, true);
  bridge.skipOptional(plan, context);
  assert.deepEqual(await bridge.requirements({}, context), []);
  bridge.clearSkipped(userDataDir);
  assert.equal((await bridge.requirements({}, context)).length, 1);
});

test('current Valve metadata selects content addresses without a fixed client version', () => {
  for (const digest of ['1'.repeat(40), 'a'.repeat(40)]) {
    const archive = Components.resolveManifest('"client" { "bins_misc" { "file" "bins_misc_ubuntu12.zip.' + digest + '" "size" "128" } }');
    assert.equal(archive.sha1, digest);
    assert.equal(archive.url, 'https://client-update.akamai.steamstatic.com/' + archive.filename);
  }
  assert.throws(() => Components.resolveManifest('"client" { "bins_misc" { "file" "latest.zip" } }'));
});
