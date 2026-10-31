const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPinnedNativeManager } = require('../src/modules/shared/runtime/pinned-native-manager');
const { sourceCatalog } = require('../src/modules/shared/runtime/runtime-sources');
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-refresh-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const fresh = file => { const resolved = require.resolve(file); delete require.cache[resolved]; return require(resolved); };
const row = (state, id) => state.catalog.sources.find(source => source.id === id);
const catalogFile = (root, id, source) => path.join(root, 'runtimes', id, source ? `catalog-${source}.json` : 'catalog.json');

test('native provider refresh is scoped, concurrent and preserves unrelated cached state and installed identities', async t => {
  const userDataDir = temporary(t), id = 'provider-host', repository = 'ExampleOwner/runtime-builds';
  const sourceSha256 = '2'.repeat(64), upstreamRevision = '1'.repeat(40);
  const record = version => { const tag = `${id}/v${version}/${process.arch}`, filename = `${id}-${version}-${process.arch}.tar.gz`; return {
    schemaVersion: 2, id, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: '13.0',
    manifestRelative: 'manifest.json', manifestSha256: '3'.repeat(64), sourceSha256, source: { repository: 'ExampleOwner/engine', revision: upstreamRevision }, updatePolicy: 'manual', tag,
    asset: { filename, bytes: 123, sha256: '4'.repeat(64), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } }; };
  let hosted = [record('build-a')], stock0, stock = [{ version: 'stock-a', upstreamRevision: '5'.repeat(40), asset: {
    filename: 'stock.tar.gz', sha256: '6'.repeat(64), url: 'https://example.test/stock.tar.gz' } }];
  stock0 = stock[0];
  let buildCalls = 0, stockCalls = 0, hostedError, stockError, releaseStock;
  const options = { id, label: 'Provider host', maxEntries: 1, sourceUrl: 'https://github.com/ExampleOwner/engine/releases',
    projectBuilds: { projectId: id, repository, upstreamMacDownloads: true },
    discoverCatalog: async ({ sourceId }) => { assert.equal(sourceId, 'upstream'); stockCalls++; if (releaseStock) await new Promise(resolve => releaseStock.resolve = resolve); if (stockError) throw stockError; return stock; },
    dependencies: { systemVersionSync: () => '26.0', projectBuilds: { fetchUrlBuffer: async () => {
      buildCalls++; if (hostedError) throw hostedError; return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: 'manual', packages: hosted })) }; } } } };
  const manager = createPinnedNativeManager(options);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []); assert.deepEqual([buildCalls, stockCalls], [0, 0]);
  await manager.refreshCatalog({ userDataDir, sourceId: 'builds', force: true });
  assert.deepEqual([buildCalls, stockCalls], [1, 0]); assert.equal(row(manager.getState({ userDataDir }), 'upstream').status, 'idle');
  await manager.refreshCatalog({ userDataDir, sourceId: 'upstream', latestOnly: false, force: true });
  const initial = manager.getState({ userDataDir }), buildBefore = row(initial, 'builds');
  assert.deepEqual(initial.catalog.versions, ['build-a', 'stock-a']);
  assert.equal(buildBefore.supportsLatestOnly, false);
  const cache = catalogFile(userDataDir, id), saved = fs.readFileSync(cache);
  stockError = Error('Stock is offline');
  await assert.rejects(manager.refreshCatalog({ userDataDir, sourceId: 'upstream', latestOnly: true, force: true }), /Stock is offline/);
  const failed = manager.getState({ userDataDir }), oldStock = row(initial, 'upstream'), failedStock = row(failed, 'upstream');
  assert.deepEqual(row(failed, 'builds'), buildBefore); assert.deepEqual(failedStock.versions, oldStock.versions);
  assert.equal(failedStock.mode, oldStock.mode); assert.equal(failedStock.fetchedAt, oldStock.fetchedAt); assert.equal(failedStock.status, 'error');
  assert.deepEqual(fs.readFileSync(cache), saved, 'A failed query preserves the exact successful disk cache');
  stockError = null; releaseStock = {};
  const pending = manager.refreshCatalog({ userDataDir, sourceId: 'upstream', force: true });
  await new Promise(resolve => setImmediate(resolve));
  const pendingState = row(manager.getState({ userDataDir }), 'upstream');
  hosted = [record('build-b')];
  await manager.refreshCatalog({ userDataDir, sourceId: 'builds', force: true });
  assert.deepEqual(row(manager.getState({ userDataDir }), 'upstream'), pendingState, 'A completed Builds refresh does not alter a pending stock provider');
  releaseStock.resolve(); releaseStock = null; await pending;
  const count = [buildCalls, stockCalls], restarted = createPinnedNativeManager(options);
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ['build-b', 'stock-a']);
  assert.deepEqual([buildCalls, stockCalls], count, 'Two provider caches load offline after restart');
  stock = [];
  await assert.rejects(restarted.refreshCatalog({ userDataDir, sourceId: 'upstream', force: true }), /previous list is kept/);
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ['build-b', 'stock-a'], 'An empty answer keeps the last stock list');
  stock = [{ ...stock0, version: 'stock-b' }]; await restarted.refreshCatalog({ userDataDir, sourceId: 'upstream', force: true });
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ['build-b', 'stock-b']);
  assert.equal(row(restarted.getState({ userDataDir }), 'builds').fetchedAt, row(manager.getState({ userDataDir }), 'builds').fetchedAt);
  hostedError = Error('Builds is offline'); const before = row(restarted.getState({ userDataDir }), 'upstream');
  await assert.rejects(restarted.refreshCatalog({ userDataDir, sourceId: 'builds', force: true }), /Builds is offline/);
  assert.deepEqual(row(restarted.getState({ userDataDir }), 'upstream'), before);
});

test('a legacy default source key refreshes only the sole upstream provider', async t => {
  const userDataDir = temporary(t), calls = [];
  const manager = createPinnedNativeManager({ id: 'sole-provider', label: 'Sole', discoverCatalog: async options => { calls.push(options.sourceId); return []; } });
  await manager.refreshCatalog({ userDataDir, sourceId: 'default' });
  assert.deepEqual(calls, ['upstream']);
  await assert.rejects(manager.refreshCatalog({ userDataDir, sourceId: 'builds' }), /source is unavailable/);
  assert.deepEqual(calls, ['upstream']);
});

test('ONS native providers refresh separately, retain exact caches on failure and retire removed stock choices', async t => {
  const userDataDir = temporary(t), Runtime = require('../src/modules/shared/onsyuri/runtime/onsyuri-runtime');
  const Manager = fresh('../src/modules/shared/onsyuri/runtime/onsyuri-manager');
  let builds = [], stockVersion = '0.7.6', fail, buildCalls = 0, stockCalls = 0;
  const hostedState = () => ({ installed: [], catalog: { status: buildCalls ? 'success' : 'idle', fetchedAt: buildCalls || null, versions: builds,
    installableVersions: builds, versionRequirements: {}, error: null } });
  t.mock.method(Runtime.hosted, 'getState', hostedState);
  t.mock.method(Runtime.hosted.core, 'listCatalog', () => builds.map(version => ({ version, projectPackage: { arch: 'arm64' } })));
  t.mock.method(Runtime.hosted, 'refreshCatalog', async options => { assert.equal(options.sourceId, 'builds'); buildCalls++; builds = [Runtime.recommendedVersion]; });
  t.mock.method(Runtime, 'fetchAvailableVersions', async options => {
    assert.equal(options.sourceId, 'upstream'); stockCalls++; if (fail) throw fail;
    return { rows: stockVersion ? Runtime.rowsFromReleases([{ tag_name: 'v' + stockVersion, assets: [{ name: 'onsyuri_aarch64_darwin', browser_download_url: 'https://example.test/arm' }] }]) : [],
      macVersions: stockVersion ? [stockVersion] : [], webVersions: [], source: 'https://github.com/YuriSizuku/OnscripterYuri/releases' };
  });
  assert.deepEqual(Manager.getState({ userDataDir }).mac.catalog.versions, []); assert.deepEqual([buildCalls, stockCalls], [0, 0]);
  await Manager.refreshCatalog({ userDataDir, sectionId: 'mac', sourceId: 'builds', force: true });
  assert.deepEqual([buildCalls, stockCalls], [1, 0]); assert.equal(fs.existsSync(catalogFile(userDataDir, 'onsyuri', 'upstream')), false);
  await Manager.refreshCatalog({ userDataDir, sectionId: 'mac', sourceId: 'upstream', force: true });
  const first = Manager.getState({ userDataDir }).mac, saved = fs.readFileSync(catalogFile(userDataDir, 'onsyuri', 'upstream'));
  fail = Error('Stock failed');
  await assert.rejects(Manager.refreshCatalog({ userDataDir, sectionId: 'mac', sourceId: 'upstream', force: true }), /Stock failed/);
  const failed = Manager.getState({ userDataDir }).mac;
  assert.deepEqual(row(failed, 'builds'), row(first, 'builds')); assert.deepEqual(row(failed, 'upstream').versions, ['0.7.6']);
  assert.equal(row(failed, 'upstream').fetchedAt, row(first, 'upstream').fetchedAt);
  assert.deepEqual(fs.readFileSync(catalogFile(userDataDir, 'onsyuri', 'upstream')), saved);
  const count = stockCalls, reopened = fresh('../src/modules/shared/onsyuri/runtime/onsyuri-manager');
  assert.deepEqual(row(reopened.getState({ userDataDir }).mac, 'upstream').versions, ['0.7.6']); assert.equal(stockCalls, count);
  fail = null; stockVersion = null;
  await reopened.refreshCatalog({ userDataDir, sectionId: 'mac', sourceId: 'upstream', force: true });
  assert.deepEqual(row(reopened.getState({ userDataDir }).mac, 'upstream').versions, []);
  assert.deepEqual(row(reopened.getState({ userDataDir }).mac, 'builds').versions, [Runtime.recommendedVersion]);
});

test('MKXP Builds and Actions modes, failure and cache stay independent', async t => {
  const userDataDir = temporary(t), Builds = require('../src/modules/rgss/runtime/mkxpz-builds');
  const Core = require('../src/modules/rgss/runtime/mkxpz-runtime-manager'), Manager = fresh('../src/modules/rgss/runtime/mkxpz-manager');
  let buildCalls = 0, actions = [], fail = Error('Actions unavailable');
  const upstream = ['2026-10-24T12-01-02Z_aaaa', '2026-10-23T10-01-02Z_bbbb'];
  const hostedState = () => ({ catalog: { status: buildCalls ? 'success' : 'idle', fetchedAt: buildCalls || null, versions: buildCalls ? [Core.DEFAULT_VERSION] : [],
    installableVersions: buildCalls ? [Core.DEFAULT_VERSION] : [], versionRequirements: {}, error: null } });
  t.mock.method(Builds.manager, 'getState', hostedState);
  t.mock.method(Builds.manager, 'refreshCatalog', async options => { assert.equal(options.sourceId, 'builds'); buildCalls++; });
  const result = latest => { actions.push(latest); if (fail) throw fail; const versions = latest ? upstream.slice(0, 1) : upstream;
    return { versions, entries: versions.map((version, index) => ({ version, artifactId: index + 1, file: { url: `https://nightly.link/mkxp-z/mkxp-z/actions/artifacts/${index + 1}.zip` } })) }; };
  t.mock.method(Core, 'fetchLatestAvailableVersions', async () => result(true));
  t.mock.method(Core, 'fetchAvailableVersions', async () => result(false));
  assert.deepEqual(Manager.getState({ userDataDir }).catalog.versions, []);
  await Manager.refreshCatalog({ userDataDir, sourceId: 'builds', force: true });
  assert.deepEqual([buildCalls, actions.length], [1, 0]);
  await assert.rejects(Manager.refreshCatalog({ userDataDir, sourceId: 'upstream', force: true }), /Actions unavailable/);
  assert.equal(buildCalls, 1); assert.equal(fs.existsSync(catalogFile(userDataDir, 'mkxpz', 'upstream')), false);
  fail = null; actions = [];
  await Manager.refreshCatalog({ userDataDir, sourceId: 'upstream', force: true });
  assert.deepEqual(row(Manager.getState({ userDataDir }), 'upstream').versions, upstream.slice(0, 1));
  await Manager.refreshCatalog({ userDataDir, sourceId: 'upstream', latestOnly: false, force: true });
  assert.deepEqual(actions, [true, false]);
  const first = Manager.getState({ userDataDir }), saved = fs.readFileSync(catalogFile(userDataDir, 'mkxpz', 'upstream'));
  assert.equal(row(first, 'builds').supportsLatestOnly, false); assert.equal(row(first, 'upstream').supportsLatestOnly, true);
  fail = Error('Actions failed');
  await assert.rejects(Manager.refreshCatalog({ userDataDir, sourceId: 'upstream', latestOnly: true, force: true }), /Actions failed/);
  const failed = Manager.getState({ userDataDir });
  assert.deepEqual(row(failed, 'builds'), row(first, 'builds')); assert.deepEqual(row(failed, 'upstream').versions, upstream);
  assert.equal(row(failed, 'upstream').mode, 'all'); assert.equal(row(failed, 'upstream').fetchedAt, row(first, 'upstream').fetchedAt);
  assert.deepEqual(fs.readFileSync(catalogFile(userDataDir, 'mkxpz', 'upstream')), saved);
  const count = [buildCalls, actions.length], reopened = fresh('../src/modules/rgss/runtime/mkxpz-manager');
  assert.deepEqual(row(reopened.getState({ userDataDir }), 'upstream').versions, upstream);
  assert.deepEqual([buildCalls, actions.length], count);
});

test('pure Builds managers request discovery without a package choice while cold catalogs stay empty', t => {
  const root = temporary(t), calls = [];
  const dependencies = { fetchUrlBuffer: async () => { calls.push('network'); assert.fail('Local state and selection cannot discover packages'); }, systemVersionSync: () => '26.0' };
  const managers = [
    [require('../src/modules/android/runtime-manager').createManager(dependencies), '0.1.0'],
    [require('../src/modules/android/art/runtime-manager').createManager(dependencies), '0.1.0'],
    [require('../src/modules/android/providers/aim/manager').createManager(dependencies), 'MCLv1-1022'],
    [require('../src/modules/flash/runtime/projector-manager').__test.createManager({ dependencies }), '35.0.0.60-MCLv1'],
    [require('../src/modules/shared/vulkan/managed').createManager(dependencies), 'MCLv1-1024']
  ];
  for (const [manager, version] of managers) {
    const userDataDir = path.join(root, manager.id);
    const state = manager.getState({ userDataDir });
    assert.deepEqual(state.catalog.versions, []); assert.deepEqual(state.catalog.installableVersions, []); assert.deepEqual(state.installed, []);
    const selection = manager.resolveSelection({}, {}, userDataDir);
    assert.equal(selection.version, null); assert.equal(selection.ready, false); assert.equal(selection.install, null);
    assert.equal(selection.discoveryRequired, true);
    const chosen = manager.resolveSelection({}, { runtimes: { [manager.id]: { defaultVersion: version } } }, userDataDir);
    assert.equal(chosen.version, version); assert.equal(chosen.ready, false);
    assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, [], 'Preparing a consent plan does not seed download choices');
  }
  assert.deepEqual(calls, []);
});
