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
      steamBridge: { native: {}, windows: {}, clientEnvironment: {}, futureCapability: { enabled: true }, abi: 42, role: 'future-role' } },
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
    const [archive] = Components.resolveManifest('"client" { "bins_misc" { "file" "bins_misc_ubuntu12.zip.' + digest + '" "size" "128" } }');
    assert.equal(archive.sha1, digest);
    assert.equal(archive.url, 'https://client-update.akamai.steamstatic.com/' + archive.filename);
  }
  assert.throws(() => Components.resolveManifest('"client" { "bins_misc" { "file" "latest.zip" } }'));
});

test('managed preparation retains the selected bottle on both launches and writes no prefix files', async t => {
  const { packageFor } = require('./helpers/managed-tool-fixture.cjs');
  const { image } = require('./fixtures/macho-image');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-bridge-managed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = { x86_64: 'x86_64-unix/lsteamclient.so', aarch64: 'aarch64-unix/lsteamclient.so' };
  const windows = Object.fromEntries(['i386', 'x86_64'].map(arch => [arch, {
    builtin: arch + '-windows/lsteamclient.dll', bootstrap: arch + '-windows/mlsteam-bootstrap.dll',
    helper: arch === 'i386' ? 'i386-windows/steam.exe' : 'steam.exe' }]));
  const paths = [...Object.values(native), ...Object.values(windows).flatMap(Object.values)];
  const fixture = packageFor(path.join(root, 'package'), { id: 'maclauncher-steam-bridge', version: '9.0.0', architecture: 'universal',
    manifest: { managerId: 'maclauncher-steam-bridge', executableRelative: 'steam.exe', dependencies: [], steamBridge: { native, windows, clientEnvironment: { i386: 'MACLAUNCHER_STEAM_CLIENT32', x86_64: 'MACLAUNCHER_STEAM_CLIENT64' } } },
    entries: paths.map(name => ({ path: name, bytes: Buffer.from('package inspection input'), mode: 0o644 })) });
  t.mock.method(Components, 'install', async options => { assert.deepEqual(Object.keys(options).sort(), ['onProgress', 'signal', 'userDataDir']); });
  t.mock.method(Components, 'current', () => ({ root: path.join(root, 'components'), clients: { i386: 'steamclient.dll', x86_64: 'steamclient64.dll' } }));
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '123' }), discoverClient: () => '/native-client', isRunning: () => true,
    dependencies: { systemVersionSync: () => '27.0',
      fetchUrlBuffer: async () => ({ status: 200, body: Buffer.from(JSON.stringify(fixture.catalog)) }),
      downloadToFile: async (_url, destination) => fs.copyFileSync(fixture.archive, destination) } });
  const context = { userDataDir: path.join(root, 'data') };
  await bridge.refreshCatalog({ ...context, force: true });
  await bridge.installRuntime({ ...context, version: fixture.record.version });
  for (const architecture of ['x86_64', 'arm64']) {
    const wineRoot = path.join(root, 'wine-' + architecture), unix = path.join(wineRoot, 'lib/wine', architecture === 'arm64' ? 'aarch64-unix' : 'x86_64-unix');
    fs.mkdirSync(unix, { recursive: true }); fs.writeFileSync(path.join(unix, 'ntdll.so'), image({ cpu: architecture === 'arm64' ? 0x0100000c : 0x01000007 }));
    const prefixPath = path.join(root, 'selected-' + architecture); fs.mkdirSync(prefixPath); fs.writeFileSync(path.join(prefixPath, 'save.dat'), 'retained save');
    for (let launch = 0; launch < 2; launch++) {
      const result = await bridge.prepare({}, context, { installation: { wineRoot, architecture }, prefixPath,
        directory: path.join(root, 'game-runtime'), architecture: launch ? 'x86' : 'x86_64', environment: { WINEDLLPATH: '/existing' }, externalEnvironment: { running: false } });
      assert.ok(result); assert.equal(result.environment.WINEPREFIX, prefixPath);
      assert.match(result.helper, /^\\\\\?\\unix\\/); assert.equal(result.environment.WINEDLLPATH.split(path.delimiter).at(-1), '/existing');
      assert.match(result.environment.MACLAUNCHER_STEAM_BUILTIN, launch ? /i386-windows\\lsteamclient.dll$/ : /x86_64-windows\\lsteamclient.dll$/);
      assert.deepEqual(fs.readdirSync(prefixPath), ['save.dat']);
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'game-runtime')), false);
});
