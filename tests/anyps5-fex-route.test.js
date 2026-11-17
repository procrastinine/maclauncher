const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Architecture = require('../src/modules/shared/runtime/architecture');
const {fixture} = require('./helpers/anyps5-preparation-fixture.cjs');
const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');

const HOST = 'AnyPS5.app/Contents/MacOS/anyps5-fex-start';

// The AnyPS5 module with its launch collaborators replaced: what the launch
// spawns, which Vulkan CPU it asks for and whether it prepared a converted game.
function launchFixture(t, {appleSilicon = true, fexReady = true, rosettaReady = true} = {}) {
  const f = fixture(t);
  const Vulkan = require('../src/modules/shared/vulkan'), Bundled = require('../src/modules/shared/runtime/bundled-native');
  const Input = require('../src/modules/anyps5/input'), Focus = require('../src/modules/shared/runtime/native-focus');
  const Prepare = require('../src/modules/anyps5/prepare');
  const record = {vulkan: [], launched: [], prepared: 0, rosettaPrompts: 0};
  const fexRoot = path.join(f.root, 'fex-runtime'), host = path.join(fexRoot, HOST);
  fs.mkdirSync(path.dirname(host), {recursive: true}); fs.writeFileSync(host, 'fixture host');
  const converted = path.join(f.root, 'converted', 'game');
  t.mock.method(Prepare, 'prepareGame', async () => { record.prepared++; return {directory: path.dirname(converted), executable: converted}; });
  t.mock.method(Bundled, 'verifyPayload', () => true);
  t.mock.method(Input, 'prepare', () => ({})); t.mock.method(Input, 'routingEnvironment', () => ({}));
  t.mock.method(Vulkan, 'resolve', (_context, value) => { record.vulkan.push(value.architecture); return {library: '/fixture/libvulkan.1.dylib', backend: 'kosmickrisp'}; });
  t.mock.method(Vulkan, 'environment', () => ({}));
  t.mock.method(Vulkan, 'requirements', (_context, value) => [{architecture: value.architecture}]);
  t.mock.method(Focus, 'spawnForegroundNativeGame', async payload => { record.launched.push(payload); return payload; });
  const original = Architecture.requiresRosetta;
  t.mock.method(Architecture, 'requiresRosetta', architecture => appleSilicon && original(architecture, {platform: 'darwin', hardwareArch: 'arm64'}));
  const modulePath = require.resolve('../src/modules/anyps5/main'); delete require.cache[modulePath];
  const anyps5 = require(modulePath); t.after(() => delete require.cache[modulePath]);
  const [manager] = anyps5.runtimeManagers;
  const selection = (ready, executablePath, root, route) => ready
    ? {ready: true, version: route, route, install: {executablePath, installDir: root, root, declaration: {files: []}}}
    : {ready: false, version: 'fixture', reason: 'Not installed.'};
  t.mock.method(manager, 'resolveSelection', entry => {
    const route = !appleSilicon ? 'native' : entry?.runtimeData?.anyps5?.version === 'rosetta' || !fexReady && rosettaReady ? 'rosetta' : 'fex';
    return route === 'fex' ? selection(fexReady,host,fexRoot,route) : selection(rosettaReady,path.join(f.runtime,'relinker'),f.runtime,route);
  });
  const context = () => ({userDataDir: f.profile, settings: {}, runtimeSettings: {},
    ensureRosetta: async () => { record.rosettaPrompts++; }});
  return {f, anyps5, manager, record, host, context};
}

test('on Apple silicon the FEX route runs the start host on the imported programs and a staged app0, without a converted bundle or Rosetta', async t => {
  const {f, anyps5, record, host, context} = launchFixture(t);
  const launch = await anyps5.launchRuntime('anyps5', f.entry, context('auto'));
  const Prepare = require('../src/modules/anyps5/prepare');
  const root = Prepare.gameDirectory(f.entry, {userDataDir: f.profile}), folder = path.join(root, 'fex');
  assert.equal(record.prepared, 0, 'no conversion runs'); assert.equal(record.rosettaPrompts, 0);
  assert.equal(launch.executablePath, host); assert.equal(launch.needsRosetta, false);
  assert.deepEqual(launch.args, [path.join(folder, 'app0'), folder, '0', 'run', fs.realpathSync(f.programs)]);
  // /app0 is writable for the game, as on the converted route, so it is a staged copy: the imported folder never changes.
  const staged = path.join(folder, 'app0', 'assets', 'data.bin'), original = path.join(f.assets, 'assets', 'data.bin');
  assert.equal(fs.readFileSync(staged, 'utf8'), 'original game data');
  fs.writeFileSync(staged, 'written by the game');
  await anyps5.launchRuntime('anyps5', f.entry, context('auto'));
  assert.equal(fs.readFileSync(staged, 'utf8'), 'written by the game', 'a write by the game is kept');
  assert.equal(fs.readFileSync(original, 'utf8'), 'original game data', 'the imported folder is unchanged');
  fs.writeFileSync(path.join(f.assets, 'assets', 'new.bin'), 'added later');
  await anyps5.launchRuntime('anyps5', f.entry, context('auto'));
  assert.equal(fs.readFileSync(path.join(folder, 'app0', 'assets', 'new.bin'), 'utf8'), 'added later', 'a file added to the import is staged');
  assert.equal(launch.options.cwd, folder); assert.equal(launch.options.gameArguments, false);
  assert.equal(launch.options.env.ANYPS5_SHADER_CACHE_DIR, path.join(folder, 'shader_cache'));
  assert.equal(launch.options.env.ANYPS5_VULKAN_LIBRARY, '/fixture/libvulkan.1.dylib');
  assert.equal(launch.options.env.APS5_PLAYGO_UNLISTED_CHUNKS ?? 'installed', process.env.APS5_PLAYGO_UNLISTED_CHUNKS ?? 'installed');
  assert.equal(fs.readlinkSync(path.join(folder, 'data')), path.join(root, 'saves'));
  assert.equal(fs.readlinkSync(path.join(folder, '_sd')), path.join(root, 'saves', '_sd'));
  assert.deepEqual(fs.readdirSync(root).sort(), ['fex', 'saves'], 'nothing else is created for the game: no launch.app, no staged copy');
  assert.deepEqual([...new Set(record.vulkan)], ['arm64']);
  assert.equal(f.entry.defaultSaveDir, path.join(root, 'saves'));
  assert.ok(anyps5.resolveSaveLocations(f.entry, {userDataDir: f.profile}).directories.some(row => row.directory === path.join(folder, '_sd_mem')));
  assert.equal((await anyps5.resolveGraphicsInputs(f.entry, context('auto'))).architecture, 'arm64');
  assert.equal(anyps5.settingsActions.listCpuRoutes, undefined);
});

test('Rosetta stays selectable on Apple silicon with the converted game and Intel Vulkan', async t => {
  const {f, anyps5, record, context} = launchFixture(t);
  f.entry.runtimeData={anyps5:{version:'rosetta'}};
  const launch = await anyps5.launchRuntime('anyps5', f.entry, context());
  assert.equal(record.prepared, 1); assert.equal(record.rosettaPrompts, 1);
  assert.equal(launch.needsRosetta, true); assert.equal(path.basename(launch.executablePath), 'game');
  assert.deepEqual(record.vulkan, ['x64']);
  assert.equal((await anyps5.resolveGraphicsInputs(f.entry, context('rosetta'))).architecture, 'x86_64');
});

test('Automatic prefers FEX and keeps an installed Rosetta route when FEX is not installed', async t => {
  for (const [fexReady, rosettaReady, expected] of [[false, false, 'anyps5'], [true, true, null], [true, false, null], [false, true, null]]) {
    await t.test(`FEX ${fexReady ? 'installed' : 'absent'}, Rosetta route ${rosettaReady ? 'installed' : 'absent'}`, async t => {
      const {f, anyps5, record, context} = launchFixture(t, {fexReady, rosettaReady});
      assert.equal(anyps5.ensureRuntime(f.entry, context('auto'))?.managerId ?? null, expected);
      assert.deepEqual(anyps5.getRuntimeRequirements(f.entry, context('auto')), [{architecture: !fexReady && rosettaReady ? 'x64' : 'arm64'}]);
      if (fexReady || rosettaReady) {
        await anyps5.launchRuntime('anyps5', f.entry, context('auto'));
        assert.equal(record.prepared, fexReady ? 0 : 1);
      }
    });
  }
  const {f, anyps5, context} = launchFixture(t, {fexReady: false, rosettaReady: true});
  f.entry.runtimeData={anyps5:{version:'fex'}};
  t.mock.method(anyps5.runtimeManagers[0], 'resolveSelection', () => ({ready:false,version:'fex',reason:'Not installed.'}));
  assert.equal(anyps5.ensureRuntime(f.entry, context())?.managerId, 'anyps5', 'an explicit version stays in the ordinary manager');
});

test('Intel Macs run the selected converted version natively', async t => {
  const {f, anyps5, record, context} = launchFixture(t, {appleSilicon: false, fexReady: true});
  const launch = await anyps5.launchRuntime('anyps5', f.entry, context('fex'));
  assert.equal(record.prepared, 1); assert.equal(launch.needsRosetta, false); assert.deepEqual(record.vulkan, ['x64']);
  assert.equal(anyps5.settingsActions.listCpuRoutes, undefined);
});

test('AnyPS5 versions share one manager and have no per-game CPU control', () => {
  const manifest = require('../src/modules/anyps5/manifest.json');
  assert.equal(manifest.runtime.managerUi.anyps5.management, 'managed');
  assert.equal(manifest.runtime.managerUi['anyps5-fex'], undefined);
  assert.equal(manifest.runtime.entries.anyps5.settings.fields.some(row => row.key === 'cpu'), false);
  assert.equal(manifest.runtime.entries.anyps5.settings.defaults.cpu, undefined);
  const anyps5 = require('../src/modules/anyps5/main');
  assert.deepEqual(anyps5.runtimeManagers.map(manager => manager.id), ['anyps5']);
});

test('execution CPU is measured from the selected host or game library', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'anyps5-execution-role-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const header=(cpu,type)=>{const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(cpu,4);bytes.writeUInt32LE(type,12);return bytes;};
  const write=(name,bytes)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o755});};
  const manager=require('../src/modules/anyps5/runtime/manager');
  write('tools/relinker',header(0x0100000c,2));
  write('libs/libkernel.prx',header(0x01000007,6));
  const legacy={payloadRoot:root,manifest:{arch:'arm64',files:[{path:'tools/relinker'},{path:'libs/libkernel.prx'}]}};
  assert.equal(manager.execution(legacy).executionArchitecture,'x64','the native converter does not determine the game CPU');
  write(HOST,header(0x0100000c,2));
  const fex={payloadRoot:root,manifest:{arch:'arm64',files:[{path:HOST,architectures:['arm64']}]}};
  assert.equal(manager.execution(fex).executionArchitecture,'arm64');
  write(HOST,header(0x01000007,2));
  assert.throws(()=>manager.execution(fex),/unsupported CPU/,'the declaration cannot replace the actual header');
});

// Bounded Mach-O headers exercise source/package admission. Transport,
// extraction and signature-tool I/O are injected; no native program is built or run.
function fexPackage(directory, {version, hostArchitecture = 'arm64', managerId = 'anyps5-fex', host}) {
  const container=path.join(directory,'archive-input'),payload=path.join(container,'files');
  fs.mkdirSync(path.dirname(path.join(payload,HOST)),{recursive:true});
  fs.writeFileSync(path.join(payload,HOST),host,{mode:0o755});
  const source=Buffer.from('{}');fs.writeFileSync(path.join(payload,'source.json'),source);
  const files=[{path:HOST,size:host.length,mode:0o755,sha256:sha(host),architectures:[hostArchitecture]},
    {path:'source.json',size:source.length,mode:0o644,sha256:sha(source)}];
  const manifest={schemaVersion:1,managerId,version,platform:'darwin',arch:'arm64',minimumMacOS:'26.0',
    upstreamRevision:'a'.repeat(40),executableRelative:HOST,dependencies:[],files};
  const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(payload,'runtime.json'),bytes);
  const sourceSha256=sha(source);
  const wrapper={id:'anyps5-fex',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'26.0',
    manifestRelative:'runtime.json',manifestSha256:sha(bytes),sourceRelative:'source.json',sourceSha256,
    files:[...files,{path:'runtime.json',size:bytes.length,mode:0o644,sha256:sha(bytes)}]};
  fs.writeFileSync(path.join(container,'runtime-package.json'),JSON.stringify(wrapper));
  const filename='anyps5-fex-'+version+'-arm64.tar.gz',archive=path.join(directory,filename),data=Buffer.from('injected extraction '+version);
  fs.writeFileSync(archive,data);
  const tag='anyps5-fex/v'+version+'/arm64';
  const record={schemaVersion:2,id:'anyps5-fex',version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'26.0',
    manifestRelative:'runtime.json',manifestSha256:sha(bytes),sourceSha256,updatePolicy:'manual',tag,
    asset:{filename,bytes:data.length,sha256:sha(data),url:'https://github.com/procrastinine/maclauncher-builds/releases/download/'+encodeURIComponent(tag)+'/'+filename}};
  return {container,archive,record,manifest,catalog:{schemaVersion:2,projectId:'anyps5-fex',updatePolicy:'manual',packages:[record]}};
}

test('the FEX package installs, becomes ready, is removable and refuses other layouts', {skip: process.platform !== 'darwin'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyps5-fex-package-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const host=Buffer.alloc(32);host.writeUInt32LE(0xfeedfacf);host.writeUInt32LE(0x0100000c,4);host.writeUInt32LE(2,12);
  const packages = [fexPackage(path.join(root, 'good'), {version: 'fixture-MCLv1', host}),
    fexPackage(path.join(root, 'intel'), {version: 'fixture-MCLv2', host, hostArchitecture: 'x86_64'}),
    fexPackage(path.join(root, 'other'), {version: 'fixture-MCLv3', host, managerId: 'unrelated-runtime'})];
  let offered=packages,acquisitions=0;
  const manager = require('../src/modules/anyps5/runtime/manager').createManager({systemVersionSync: () => '26.0',
    fetchUrlBuffer: async url => ({status:200,body:Buffer.from(JSON.stringify(String(url).includes('anyps5-fex')
      ? {...packages[0].catalog,packages:offered.map(item=>item.record)} : {schemaVersion:2,projectId:'anyps5',updatePolicy:'manual',packages:[]}))}),
    downloadToFile: async (url, destination) => {acquisitions++;fs.copyFileSync(packages.find(item => item.record.asset.url === url).archive, destination);},
    extractArchive:async(archive,destination)=>{const item=packages.find(item=>sha(fs.readFileSync(item.archive))===sha(fs.readFileSync(archive)));fs.cpSync(item.container,destination,{recursive:true});},
    execute:async()=>({stdout:'',stderr:''})});
  const downloads = () => new (require('../src/modules/shared/runtime/download-manager').DownloadManager)();
  await Architecture.withArchitecture('arm64', async () => {
    const userDataDir = path.join(root, 'profile');
    await manager.refreshCatalog({userDataDir, force: true});
    await manager.installRuntime({userDataDir, version: 'fixture-MCLv1', downloads: downloads()});
    const ready = manager.resolveSelection({}, {}, userDataDir);
    assert.equal(ready.ready, true, ready.reason); assert.equal(ready.version, 'fixture-MCLv1');
    assert.equal(ready.install.executablePath.endsWith(HOST), true);
    const saved=manager.applySettingsUpdate('setDefault',{version:ready.version},{},{userDataDir});
    assert.equal(manager.resolveSelection({}, {runtimes:{anyps5:saved}}, userDataDir).version,ready.version);
    const external=path.join(packages[0].container,'files'),before=fs.readFileSync(path.join(external,HOST));
    await manager.registerCustomRuntime({userDataDir,runtimePath:external});
    const custom=manager.resolveSelection({runtimeData:{anyps5:{version:external}}},{},userDataDir);
    assert.equal(custom.ready,true,custom.reason);assert.equal(custom.route,'fex');
    await manager.uninstallRuntime({userDataDir,version:external});
    assert.deepEqual(fs.readFileSync(path.join(external,HOST)),before,'removing a custom registration preserves external bytes');
    for (const version of ['fixture-MCLv2', 'fixture-MCLv3'])
      await assert.rejects(manager.installRuntime({userDataDir, version, downloads: downloads()}), /unsupported.*runtime layout/);
    await manager.uninstallRuntime({userDataDir, version: 'fixture-MCLv1'});
    assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, false);
    offered=[packages[0]];
    await manager.refreshCatalog({userDataDir,force:true});
    const settings={};
    await manager.installRuntime({userDataDir,automatic:true,settings,downloads:downloads()});
    assert.deepEqual(settings,{},'automatic preparation does not save a user default');
    const origin=require('../src/core/runtime-install-origins').read(userDataDir);
    assert.ok(origin.some(row=>row.managerId==='anyps5'&&row.version==='fixture-MCLv1'),'the unified facade records automatic ownership');
    const downloaded=acquisitions;
    assert.equal(manager.resolveSelection({}, {}, userDataDir).ready,true);
    assert.equal(acquisitions,downloaded,'ready installed selection is offline');
  });
});
