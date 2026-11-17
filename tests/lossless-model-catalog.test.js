const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Manager = require('../src/modules/shared/reshade/runtime/models-manager');
const Releases = require('../src/modules/shared/reshade/lossless-catalog');
const Steam = require('../src/modules/shared/reshade/steam-client-models');
const Models = require('../src/modules/shared/reshade/models');
const Transport = require('../src/modules/shared/runtime/upstream-transport');
const manifest = '1234567890123456789', selected = 'steam-manifest-' + manifest;
function context(t) { const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-catalog-'));t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));return {userDataDir}; }
function catalog(t) {
  let requests = 0;
  t.mock.method(Transport, 'fetchUrlBuffer', async url => {
    requests++;assert.equal(url, Releases.sourceUrl);
    return {status: 200, headers: {}, body: Buffer.from('<h2>Previously seen manifests</h2><table><tr data-manifest="' + manifest + '"></tr></table>')};
  });
  return () => requests;
}
test('Lossless Refresh discovers real manifest identities without downloading model bytes', async t => {
  const ctx = context(t), requests = catalog(t);
  t.mock.method(Steam, 'findClient', () => '/installed/steam_osx');
  t.mock.method(Models, 'inspectionAvailable', () => true);
  const state = await Manager.refreshCatalog(ctx);
  assert.equal(requests(), 1);assert.deepEqual(state.versions, [selected]);
  assert.equal(state.installable, true);assert.equal(state.versionLabels[selected], 'Steam manifest ' + manifest);
  Manager.getState(ctx);assert.equal(requests(), 1, 'ordinary state remains offline');
});
test('exact Steam manifest install reuses verified installed bytes offline and leaves defaults unchanged', async t => {
  const ctx = context(t), requests = catalog(t), rows = [];
  t.mock.method(Steam, 'findClient', () => '/installed/steam_osx');
  t.mock.method(Models, 'listInstalled', () => rows);
  t.mock.method(Models, 'listManaged', () => rows);
  t.mock.method(Models, 'inspectionAvailable', () => true);
  let downloads = 0;
  t.mock.method(Steam, 'downloadWithClient', async options => {
    downloads++;assert.equal(options.manifestId, manifest);
    const installDir = path.join(ctx.userDataDir, 'installed');fs.mkdirSync(installDir);
    const row = {version: 'sha256-' + 'a'.repeat(64), installDir, ready: true};rows.push(row);return row;
  });
  await Manager.refreshCatalog(ctx);
  const settings = {defaultVersion: 'sha256-' + 'b'.repeat(64)}, original = structuredClone(settings);
  const first = await Manager.installRuntime({...ctx, version: selected, settings});
  assert.equal((await Manager.installRuntime({...ctx, version: selected, settings})).version, first.version);
  assert.equal(downloads, 1);assert.equal(requests(), 1);assert.deepEqual(settings, original);
  assert.equal(Manager.applySettingsUpdate('setDefault', {version: first.version}, settings).defaultVersion, first.version);
  let removed;
  t.mock.method(Models, 'removeModel', (_root, version) => { removed = version; });
  await Manager.uninstallRuntime({...ctx, version: first.version});assert.equal(removed, first.version);
  assert.equal(typeof Manager.customRuntime.inspect, 'function');
  await assert.rejects(Manager.installRuntime({...ctx, version: 'steam-manifest-999'}), /Refresh/);
});
test('Steam manifest arguments are bounded and authenticated Steam receives the exact selected manifest', async t => {
  const ctx = context(t), home = ctx.userDataDir, steam = path.join(home, 'Library/Application Support/Steam');
  const log = path.join(steam, 'logs/console_log.txt'), directory = path.join(steam, 'steamapps/content/app_993090/depot_993091');
  fs.mkdirSync(path.dirname(log), {recursive: true});fs.writeFileSync(log, '');
  const row = await Steam.acquire({...ctx, home, manifestId: manifest}, {executable: '/installed/steam_osx',
    execute: async (_file, args) => {
      assert.deepEqual(args, ['-console', '+download_depot', '993090', '993091', manifest]);
      fs.appendFileSync(log, 'Depot download complete : "' + directory + '"\n');
    }, importModel: async options => { assert.equal(options.runtimePath, path.join(directory, 'Lossless.dll'));return {version: 'actual-model-hash'}; }});
  assert.equal(row.version, 'actual-model-hash');
  await assert.rejects(Steam.acquire({...ctx, manifestId: '1 +quit'}, {executable: '/installed/steam_osx', execute: () => assert.fail('unsafe manifest executed')}), /valid Steam/);
});
test('custom model registration retains resource and content checks, and failed Refresh preserves the catalog', async t => {
  const ctx = context(t);catalog(t);await Manager.refreshCatalog(ctx);
  t.mock.method(Transport, 'fetchUrlBuffer', async () => ({status: 200, headers: {}, body: Buffer.from('<html>No manifest table</html>')}));
  await assert.rejects(Manager.refreshCatalog(ctx), /No Lossless Scaling manifests/);
  assert.deepEqual(Releases.read(ctx.userDataDir).entries.map(row => row.version), [selected]);
  const runtimePath = path.join(ctx.userDataDir, 'Lossless.dll'), bytes = Buffer.alloc(128, 7);
  fs.writeFileSync(runtimePath, bytes);
  const inspection = {schema: 1, version: '3.0', size: bytes.length,
    contentHash: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    resourceLayoutHash: 'b'.repeat(64), resourceCount: 1,
    capabilities: Object.fromEntries(Models.CAPABILITIES.map(key => [key, {compatible: true, reason: ''}]))};
  assert.equal(Manager.customRuntime.inspect(runtimePath, {data: {inspection}}).modelPath, runtimePath);
  fs.writeFileSync(runtimePath, Buffer.alloc(128, 8));
  assert.throws(() => Manager.customRuntime.inspect(runtimePath, {data: {inspection}}), /changed/);
  assert.throws(() => Manager.customRuntime.inspect(runtimePath, {data: {inspection: {...inspection, capabilities: {}}}}), /invalid/);
});
