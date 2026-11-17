const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Source = require('../src/modules/shared/reshade/steamcmd-source');
const Manager = require('../src/modules/shared/reshade/runtime/steamcmd-manager');
const Transport = require('../src/modules/shared/runtime/upstream-transport');
const Custom = require('../src/modules/shared/runtime/custom-runtime');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function binary(type = 2) { const bytes = Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x0100000c, 4);bytes.writeUInt32LE(type, 12);return bytes; }
function payload(root) { fs.mkdirSync(root, {recursive: true});fs.writeFileSync(path.join(root, 'steamcmd'), Buffer.concat([binary(), Buffer.from(Source.BOOTSTRAP_ARGUMENTS.join('\0') + '\0')]), {mode: 0o755});for (const name of Source.LIBRARIES) fs.writeFileSync(path.join(root, name), binary(6)); }
function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steamcmd-managed-'));t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  let version = '1794537082', requests = 0, downloads = 0;
  const parts = ['steamcmd_osx', 'steamcmd_bins_osx', 'steamcmd_public_all', 'steamcmd_breakpad_osx'];
  const bytes = Object.fromEntries(parts.map(name => [name, Buffer.from(name)]));
  function manifest() { return '"osx" { "version" "' + version + '" ' + parts.map((name, index) => '"' + name + '" { "file" "' + name + '.zip.' + String(index).repeat(40) + '" "size" "' + bytes[name].length + '" "sha2" "' + hash(bytes[name]) + '" ' + (!index ? '"IsBootstrapperPackage" "1"' : '') + ' }').join(' ') + ' }'; }
  t.mock.method(Transport, 'fetchUrlBuffer', async url => { assert.equal(url, Source.location);requests++;return {status: 200, headers: {}, body: Buffer.from(manifest())}; });
  const download = async (listed, destination) => { downloads++;const name = path.basename(listed.url).split('.zip.')[0];fs.writeFileSync(destination, bytes[name]);return {sha256: hash(bytes[name])}; };
  const manager = Manager.create({download, downloadToFile: (url, destination) => download({url}, destination),
    extractArchive: async (archive, root) => { fs.mkdirSync(root, {recursive: true});if (fs.readFileSync(archive, 'utf8') === 'steamcmd_osx') payload(root); }, verifySigner: async () => ({teamIdentifier: 'MXGJJ98X76'})});
  return {userDataDir, manager, manifest, setVersion: value => version = value, counts: () => ({requests, downloads})};
}
test('SteamCMD is a managed Tools entry with real versioned Valve manifest discovery', async t => {
  const f = fixture(t);assert.equal(f.manager.ui.groupId, 'tools');
  assert.deepEqual((await f.manager.refreshCatalog({userDataDir: f.userDataDir})).versions, ['1794537082']);
  f.setVersion('1794537083');
  assert.deepEqual((await f.manager.refreshCatalog({userDataDir: f.userDataDir, force: true})).versions, ['1794537083']);
  assert.equal(f.counts().requests, 2);
  const parsed = Source.parse(f.manifest());assert.equal(parsed.files.length, 1);assert.equal(parsed.details.parts.length, 4);
  assert.throws(() => Source.parse(f.manifest().replace(/"sha2" "[a-f0-9]+"/, '"sha2" "unknown"')), /invalid SteamCMD/);
});
test('SteamCMD install, offline default selection, delete and custom registration use ordinary managers', async t => {
  const f = fixture(t), context = {userDataDir: f.userDataDir};await f.manager.refreshCatalog(context);
  const installed = await f.manager.installRuntime({...context, version: '1794537082'});
  assert.deepEqual(installed.architectures, ['arm64']);assert.equal(f.counts().downloads, 4);
  const settings = f.manager.applySettingsUpdate('setDefault', {version: installed.version}, {});
  assert.equal(f.manager.resolveSelection({}, settings, f.userDataDir).install.version, installed.version);
  await f.manager.installRuntime({...context, version: installed.version});assert.deepEqual(f.counts(), {requests: 1, downloads: 4});
  const customPath = path.join(f.userDataDir, 'custom');payload(customPath);
  const registered = await Custom.register(f.manager, {...context, runtimePath: customPath});assert.equal(registered.ready, true);
  fs.unlinkSync(path.join(customPath, 'steamclient.dylib'));
  assert.throws(() => Source.inspect({runtimePath: customPath, runtimeVersion: 'custom', upstreamRevision: 'custom'}), /ENOENT/);
  await f.manager.uninstallRuntime({...context, version: installed.version});
  assert.equal(f.manager.core.listInstalled(f.userDataDir).some(row => row.version === installed.version), false);assert.equal(fs.existsSync(customPath), true);
});
test('SteamCMD refuses a changed package part before accepting an installation', async t => {
  const f = fixture(t), context = {userDataDir: f.userDataDir};await f.manager.refreshCatalog(context);
  const pin = f.manager.core.listCatalog(context)[0], unpacked = path.join(f.userDataDir, 'unpacked');fs.mkdirSync(unpacked);
  await assert.rejects(Source.prepare({unpacked, pin}, {download: async (_listed, destination) => fs.writeFileSync(destination, 'changed'),
    extractArchive: () => assert.fail('unverified package extracted'), verifySigner: () => assert.fail('unverified package signed')}), /differs/);
});
test('Steam acquisition reuses the installed managed tool without network or a new consent and preserves explicit versions', async t => {
  const f = fixture(t), context = {userDataDir: f.userDataDir};await f.manager.refreshCatalog(context);
  const first = await f.manager.installRuntime({...context, version: '1794537082'});
  f.setVersion('1794537083');await f.manager.refreshCatalog({...context, force: true});
  await f.manager.installRuntime({...context, version: '1794537083'});
  assert.deepEqual(f.manager.core.listInstalled(f.userDataDir).map(row => row.version).sort(), ['1794537082', '1794537083']);
  const counts = f.counts(), settings = {runtimes: {steamcmd: {defaultVersion: first.version}}};
  const original = structuredClone(settings), before = hash(fs.readFileSync(first.executablePath));
  const Consumer = require('../src/modules/shared/reshade/steam-models');
  t.mock.method(Transport, 'downloadToFile', () => assert.fail('an installed managed tool must not use a hidden bootstrap downloader'));
  for (let index = 0; index < 2; index++) {
    const result = await Consumer.acquire({...context, settings, confirmRuntimeInstall: () => assert.fail('installed tool prompted')}, {
      manager: f.manager,
      authenticate: async session => {
        const file = path.join(session, 'tools/steamcmd');assert.equal(hash(fs.readFileSync(file)), before);
        assert.deepEqual(Source.bootstrapArguments(file), ['-skipinitialbootstrap', '-nobootstrapperupdate']);
        fs.writeFileSync(path.join(session, 'content/Lossless.dll'), Buffer.alloc(64));
      }, importModel: async options => { assert.equal(fs.statSync(options.runtimePath).size, 64);return {version: 'actual-imported-content'}; }});
    assert.equal(result.version, 'actual-imported-content');
  }
  assert.deepEqual(f.counts(), counts);assert.deepEqual(settings, original);assert.equal(hash(fs.readFileSync(first.executablePath)), before);
  const script = Consumer.terminalScript('/private/owned-download');
  assert.match(script, /-skipinitialbootstrap -nobootstrapperupdate/);assert.doesNotMatch(script, /while :|status.*42/);
});
