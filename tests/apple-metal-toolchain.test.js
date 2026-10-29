const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Metal = require('../src/modules/shared/runtime/apple-metal-toolchain');
const { nativeTool } = require('./helpers/managed-tool-fixture.cjs');
const archive = Buffer.from('fixture Apple component archive');
const component = { AssetType: 'com.apple.MobileAsset.MetalToolchain', AssetFormat: 'AppleArchive', Build: 'FixtureA1',
  __BaseURL: 'https://updates.cdn-apple.com/fixture/', __RelativePath: 'MetalToolchain.aar', _DownloadSize: archive.length,
  '_Measurement-SHA256': crypto.createHash('sha256').update(archive).digest('base64'), ArchiveDecryptionKey: Buffer.alloc(32, 1).toString('base64') };
function fixture(t, extra = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metal-component-choice-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true })); let queries = 0;
  const manager = Metal.createManager({ systemVersionSync: () => '26.0', readCatalog: async () => { queries++; return [component]; }, ...extra });
  return { userDataDir, manager, queries: () => queries };
}

test('Metal compiler component choices come from the public OS catalog only after Refresh', async t => {
  const f = fixture(t); assert.deepEqual(f.manager.getState({ userDataDir: f.userDataDir }).catalog.versions, []);
  assert.equal(f.manager.resolveSelection(null, {}, f.userDataDir).version, null); assert.equal(f.queries(), 0);
  await f.manager.refreshCatalog({ userDataDir: f.userDataDir, force: true }); assert.equal(f.queries(), 1);
  assert.deepEqual(f.manager.getState({ userDataDir: f.userDataDir }).catalog.versions, [component.Build]);
  assert.equal(f.manager.getState({ userDataDir: f.userDataDir }).catalog.recommendedVersion ?? null, null);
  assert.equal(f.manager.resolveSelection(null, {}, f.userDataDir, { version: 'unavailable-component' }).version, 'unavailable-component');
});
test('a missing Metal compiler asks Apple license consent before catalog lookup or acquisition', async t => {
  const f = fixture(t), plans = [], service = Metal.createService({ manager: f.manager, probeSystem: async () => null,
    run: () => assert.fail('No compiler executes before installation') });
  await assert.rejects(service.ensure({ userDataDir: f.userDataDir, settings: {}, confirmRuntimeInstall: async plan => { plans.push(plan); return false; } },
    { required: true, delivery: 'managed', managerId: Metal.ID, environment: Metal.ENVIRONMENT, version: 'Fixture API' }), { code: 'ABORT_ERR' });
  assert.equal(plans[0].version, null); assert.equal(plans[0].licenseRequired, true); assert.equal(f.queries(), 0);
});
test('an absent OS catalog is unavailable without a fixed archive fallback', async t => {
  const f = fixture(t, { readCatalog: () => { throw Error('The public macOS Metal component catalog is unavailable on this Mac.'); } });
  await assert.rejects(f.manager.refreshCatalog({ userDataDir: f.userDataDir, force: true }), /catalog is unavailable/);
  assert.deepEqual(f.manager.getState({ userDataDir: f.userDataDir }).catalog.versions, []);
  assert.throws(() => Metal.__test.componentEntry({ ...component, '_Measurement-SHA256': 'invalid' }), /identity/);
  assert.throws(() => Metal.__test.componentEntry({ ...component, __BaseURL: 'https://example.org/' }), /identity/);
});
test('OS catalog parser reads observed Apple fields without per-version data', () => {
  const read = (_command, args) => args[1] === 'Assets' ? '1\n' : String(component[args[1].replace(/^Assets\.0\./, '')]) + '\n';
  const records = Metal.__test.readLocalCatalog(read);
  assert.equal(records[0].Build, component.Build); assert.equal(Metal.__test.componentEntry(records[0]).asset.bytes, archive.length);
});
test('managed Metal installation retains catalog integrity, Apple signatures, API requirements and offline receipts',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  let signatures = 0, downloads = 0, offline = false;
  const api = '123.4 (fixture-1)';
  const run = async (command, args) => {
    if (command === '/usr/bin/codesign') { assert.ok(args.includes('=anchor apple')); signatures++; return { stdout: '' }; }
    if (command === '/usr/bin/plutil') return { stdout: 'com.apple.dt.toolchain.Metal.fixture\n' };
    assert.equal(args[0], '--version'); return { stdout: 'Apple metal version ' + api + '\n' };
  };
  const f = fixture(t, { execute: run,
    downloadToFile: async (_url, file) => { assert.equal(offline, false); downloads++; fs.writeFileSync(file, archive); },
    extractArchive: async (_archive, destination) => {
      const tool = nativeTool(path.join(f.userDataDir, 'fixture-native'), '');
      const root = path.join(destination, 'Metal.xctoolchain');
      for (const relative of ['usr/bin/metal', 'usr/bin/metallib', 'usr/metal/current/bin/metal', 'usr/metal/current/bin/air-lld']) {
        const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, tool.binary, { mode: 0o755 });
      }
      fs.mkdirSync(path.join(root, 'usr/metal/current/lib/clang'), { recursive: true });
      fs.writeFileSync(path.join(root, 'ToolchainInfo.plist'), 'fixture toolchain metadata');
    } });
  await f.manager.refreshCatalog({ userDataDir: f.userDataDir, force: true });
  const service = Metal.createService({ manager: f.manager, run, probeSystem: async () => null });
  const requirement = { required: true, delivery: 'managed', managerId: Metal.ID, environment: Metal.ENVIRONMENT, version: api };
  const context = { userDataDir: f.userDataDir, settings: { runtimes: { [Metal.ID]: { defaultVersion: component.Build } } }, confirmRuntimeInstall: async () => true };
  const installed = await service.ensure(context, requirement); assert.equal(installed.version, component.Build); assert.equal(downloads, 1); assert.ok(signatures >= 8);
  assert.equal(installed.install.installationMetadata.compilerVersion, api);
  offline = true;
  const restarted = Metal.createManager({ readCatalog: () => assert.fail('Installed receipts cannot refresh the OS catalog'), execute: run });
  const reused = await Metal.createService({ manager: restarted, run, probeSystem: async () => null }).ensure({ ...context, confirmRuntimeInstall: () => assert.fail('Installed receipts cannot ask to download') }, requirement);
  assert.equal(reused.version, component.Build);
  await assert.rejects(service.ensure(context, { ...requirement, version: 'Different compiler API' }), /different Apple Metal compiler API/);
});
