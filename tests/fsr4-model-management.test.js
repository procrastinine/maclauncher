const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Manager = require('../src/modules/shared/reshade/runtime/fsr4-models-manager');
const Releases = require('../src/modules/shared/reshade/temporal/fsr4/model-catalog');
const Library = Manager.core, Legacy = require('../src/modules/shared/reshade/temporal/fsr4/model.json');
const Github = require('../src/modules/shared/runtime/github-releases');
const Provider = require('../src/modules/shared/reshade/temporal/fsr4');
const Custom = require('../src/modules/shared/runtime/custom-runtime');
function context(t) { const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr4-managed-'));t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));return {userDataDir, root: '/selected/graphics'}; }
function source(t) {
  const versions = ['3.3', '3.2'];let requests = 0;
  t.mock.method(Github, 'fetchGithubTags', async () => { requests++;return versions.map(version => ({name: 'crossover-v' + version, commit: {sha: 'a'.repeat(40)}})); });
  t.mock.method(Github, 'fetchGithubReleases', async () => { requests++;return versions.map(version => ({tag_name: 'crossover-v' + version,
    html_url: 'https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos/releases/tag/crossover-v' + version,
    assets: [{name: 'fsr4-mac-v' + version + '-crossover.zip', browser_download_url: 'https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos/releases/download/crossover-v' + version + '/fsr4-mac-v' + version + '-crossover.zip', size: 100,
      digest: 'sha256:' + (version === '3.2' ? Legacy.archiveSha256 : 'b'.repeat(64))}]})); });
  t.mock.method(Provider, 'inspect', () => ({profiles: ['int8-lite']}));return () => requests;
}
function installed(ctx, version, sourceSpec, profiles = ['int8-lite', 'int8-lite-lossy']) {
  const directory = Library.directory(ctx.userDataDir, version), model = path.join(directory, 'build/fsr412_model');
  fs.mkdirSync(model, {recursive: true});
  for (const name of ['initializers-lite.bin', 'initializers-lite-ultraperformance.bin']) fs.writeFileSync(path.join(model, name), Buffer.alloc(27392));
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({version, archiveSha256: sourceSpec.archiveSha256, sourceSpec, preparation: 1, profiles}));
  return Library.read(ctx.userDataDir, version);
}
test('FSR4 Refresh uses live release assets and preserves both current and earlier versions', async t => {
  const ctx = context(t), requests = source(t), catalog = await Manager.refreshCatalog(ctx);
  assert.deepEqual(catalog.versions, ['3.3', '3.2']);assert.equal(requests(), 2);
  assert.equal(Releases.sources(ctx.userDataDir)[0].archiveSha256, 'b'.repeat(64));
  const state = Manager.getState(ctx);assert.equal(state.supportsDefault, true);assert.equal(requests(), 2);
  assert.equal(Manager.launchPlan(ctx, 'int8-lite').automatic, true);
  assert.equal(Manager.launchPlan({...ctx, settings: {defaultVersion: '3.2'}}, 'int8-lite').version, '3.2');
  assert.equal(Manager.launchPlan({...ctx, settings: {defaultVersion: '3.2'}}, 'int8-lite').automatic, false);
  installed(ctx, '3.3', Releases.sources(ctx.userDataDir)[0]);
  assert.equal(Provider.profileOptions({profiles: ['int8-lite']}, ctx.userDataDir, {settings: {defaultVersion: '3.3'}}).find(row => row.id === 'int8-lite').available, true);
});
test('FSR4 install respects an existing saved version, reuses it offline, and never changes preferences', async t => {
  const ctx = context(t), requests = source(t);await Manager.refreshCatalog(ctx);
  let installs = 0;t.mock.method(Library, 'install', async options => { installs++;assert.equal(options.sourceSpec.version, '3.2');return installed(ctx, options.sourceSpec.version, options.sourceSpec); });
  const settings = {defaultVersion: '3.2'}, original = structuredClone(settings);
  assert.equal((await Manager.installRuntime({...ctx, settings})).version, '3.2');
  assert.equal((await Manager.installRuntime({...ctx, settings})).version, '3.2');
  assert.equal(installs, 1);assert.equal(requests(), 2);assert.deepEqual(settings, original);
  assert.equal(Manager.launchPlan({...ctx, settings}, 'int8-lite'), null);
  assert.equal(Manager.applySettingsUpdate('setDefault', {version: '3.2'}, {}).defaultVersion, '3.2');
  assert.equal(Library.environment(ctx.userDataDir, 'int8-lite', '3.2').FSR4_MODEL_ROOT, Library.directory(ctx.userDataDir, '3.2'));
  await Manager.uninstallRuntime({...ctx, version: '3.2'});assert.equal(Library.read(ctx.userDataDir, '3.2'), null);
});
test('FSR4 custom prepared folders use actual model format and reject changed required data', async t => {
  const ctx = context(t);source(t);
  const custom = installed(ctx, '3.2', Legacy), runtimePath = custom.directory;
  const registered = await Custom.register(Manager, {...ctx, runtimePath});assert.equal(registered.ready, true);
  const settings = {customDefaults: {default: runtimePath}};
  assert.equal(Manager.selection({...ctx, settings}).current.directory, runtimePath);
  assert.equal(Manager.launchPlan({...ctx, settings}, 'int8-lite'), null);
  fs.truncateSync(path.join(runtimePath, 'build/fsr412_model/initializers-lite.bin'), 1);
  assert.throws(() => Manager.customRuntime.inspect(runtimePath), /compatible initializer/);
});
test('FSR4 rejects unlisted source changes and failed Refresh leaves installed data untouched', async t => {
  const ctx = context(t);source(t);await Manager.refreshCatalog(ctx);
  installed(ctx, '3.2', Legacy);
  t.mock.method(Github, 'fetchGithubReleases', async () => []);
  await assert.rejects(Manager.refreshCatalog(ctx), /No compatible/);
  assert.deepEqual(Releases.sources(ctx.userDataDir).map(row => row.version), ['3.3', '3.2']);
  assert.equal(Library.read(ctx.userDataDir, '3.2').ready, true);
  await assert.rejects(Manager.installRuntime({...ctx, version: 'not-listed'}), /Refresh/);
  await assert.rejects(Library.importRuntime({...ctx, runtimePath: '/unused.zip', sourceSpec: {...Legacy, url: 'https://elsewhere.invalid/release.zip'}}), /available FSR/);
});
test('FSR4 measures the declared decoder library as a dylib while keeping dxc executable and hash checks', t => {
  const ctx = context(t);installed(ctx, '3.2', Legacy);
  const root = Library.directory(ctx.userDataDir, '3.2'), receipt = path.join(root, 'runtime.json');
  const binary = type => {const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x0100000c,4);bytes.writeUInt32LE(type,12);return bytes;};
  const write = (relative, bytes) => {const file=path.join(root,'tools',relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o755});return{path:relative,bytes:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};};
  const record = JSON.parse(fs.readFileSync(receipt,'utf8'));
  record.helpers=[write('bin/dxc',binary(2)),write('lib/libdxcompiler.dylib',binary(6))];fs.writeFileSync(receipt,JSON.stringify(record));
  assert.deepEqual(Library.read(ctx.userDataDir,'3.2').helperArchitectures,['arm64']);
  record.helpers[0]=write('bin/dxc',binary(6));fs.writeFileSync(receipt,JSON.stringify(record));
  assert.equal(Library.read(ctx.userDataDir,'3.2'),null,'a dylib cannot stand in for the executable');
  record.helpers[0]=write('bin/dxc',binary(2));fs.writeFileSync(receipt,JSON.stringify(record));
  write('lib/libdxcompiler.dylib',binary(2));
  assert.equal(Library.read(ctx.userDataDir,'3.2'),null,'a changed declared library checksum remains rejected');
});
test('FSR4 discovery preserves digest-less publisher assets and computes an observed local hash', async t => {
  const ctx = context(t);source(t);const bytes = Buffer.from('archive data at its actual listed URL');
  t.mock.method(Github,'fetchGithubTags',async()=>[{name:'crossover-v3.4',commit:{sha:'d'.repeat(40)}}]);
  t.mock.method(Github,'fetchGithubReleases',async()=>[{tag_name:'crossover-v3.4',assets:[{id:17,name:'fsr4-mac-v3.4-crossover.zip',size:bytes.length,browser_download_url:'https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos/releases/download/crossover-v3.4/fsr4-mac-v3.4-crossover.zip'}]}]);
  await Manager.refreshCatalog(ctx);const selected=Releases.sources(ctx.userDataDir)[0];
  assert.equal(selected.version,'3.4');assert.equal(selected.assetId,17);assert.equal(selected.archiveSha256,undefined);assert.equal(selected.integrity,'recorded-local');
  t.mock.method(require('../src/modules/shared/runtime/upstream'),'download',async(_listed,file)=>fs.writeFileSync(file,bytes));
  const downloaded=await Library.downloadArchive({filename:'release.zip',url:selected.url,bytes:bytes.length},path.join(ctx.userDataDir,'release.zip'));
  assert.equal(downloaded.sha256,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(Library.downloadArchive({filename:'release.zip',url:selected.url,bytes:bytes.length,sha256:'f'.repeat(64)},path.join(ctx.userDataDir,'wrong.zip')),/differs/);
  const digest={algorithm:'sha512',value:require('node:crypto').createHash('sha512').update(bytes).digest('hex')};
  assert.equal(Releases.validEntry({...selected,integrity:'publisher-digest',digest}),true);
  assert.equal((await Library.downloadArchive({filename:'release.zip',url:selected.url,bytes:bytes.length,digest},path.join(ctx.userDataDir,'sha512.zip'))).sha256,downloaded.sha256);
  await assert.rejects(Library.downloadArchive({filename:'release.zip',url:selected.url,bytes:bytes.length,digest:{algorithm:'sha512',value:'a'.repeat(128)}},path.join(ctx.userDataDir,'bad-sha512.zip')),/differs/);
});
