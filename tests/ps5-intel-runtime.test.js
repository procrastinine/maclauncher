const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const Host = require('../src/modules/shared/runtime/host-capabilities');
const Architecture = require('../src/modules/shared/runtime/architecture');
const Requirements = require('../src/modules/shared/runtime/feature-requirements');
const {nativeTool, packageFor, sha} = require('./helpers/managed-tool-fixture.cjs');

test('AnyPS5 dual-CPU catalogs choose the shared native build and enforce the package macOS floor', {skip: process.platform !== 'darwin'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5-cpu-catalog-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const intel = nativeTool(path.join(root, 'intel'), '', {architecture: 'x64'}).binary;
  const packages = ['arm64', 'x64'].map(architecture => {
    const binary = architecture === 'x64' ? intel : nativeTool(path.join(root, 'arm'), '', {architecture}).binary;
    const fixture = packageFor(path.join(root, architecture), {id: 'anyps5', version: 'future-MCLv2', architecture,
      manifest: {managerId: 'anyps5', upstreamRevision: 'a'.repeat(40), gameArchitecture: 'x86_64', minimumMacOS: '26.0',
        runtimeFiles: {libraries: 'libs', unwrap: 'tools/unwrap-self.cjs'}},
      entries: [{path: 'tools/relinker', bytes: binary, mode: 0o755, architectures: [architecture === 'x64' ? 'x86_64' : 'arm64']},
        {path: 'libs/libkernel.prx', bytes: intel, mode: 0o755, architectures: ['x86_64']},
        {path: 'tools/unwrap-self.cjs', bytes: Buffer.from('module.exports = {};'), mode: 0o644},
        {path: 'source.json', bytes: Buffer.from('{}'), mode: 0o644}]});
    const container = path.join(root, architecture, 'archive-input'), payload = path.join(container, 'files');
    fixture.manifest.files.find(row => row.path === 'libs/libkernel.prx').executionArchitecture = 'x86_64';
    fs.rmSync(path.join(payload, 'manifest.json'));
    const bytes = Buffer.from(JSON.stringify(fixture.manifest)); fs.writeFileSync(path.join(payload, 'runtime.json'), bytes);
    Object.assign(fixture.record, {manifestRelative: 'runtime.json', manifestSha256: sha(bytes)});
    const wrapper = JSON.parse(fs.readFileSync(path.join(container, 'runtime-package.json')));
    wrapper.files.find(row => row.path === 'libs/libkernel.prx').executionArchitecture = 'x86_64';
    Object.assign(wrapper.files.find(row => row.path === 'manifest.json'), {path: 'runtime.json', sha256: sha(bytes), size: bytes.length});
    Object.assign(wrapper, {manifestRelative: 'runtime.json', manifestSha256: sha(bytes), sourceRelative: 'source.json'});
    fs.writeFileSync(path.join(container, 'runtime-package.json'), JSON.stringify(wrapper));
    execFileSync('/usr/bin/tar', ['-czf', fixture.archive, '-C', container, 'runtime-package.json', 'files']);
    const archive = fs.readFileSync(fixture.archive); Object.assign(fixture.record.asset, {sha256: sha(archive), bytes: archive.length});
    return fixture;
  });
  let offline = false;
  const create = macOS => require('../src/modules/anyps5/runtime/manager').createManager({systemVersionSync: () => macOS,
    fetchUrlBuffer: async () => {assert.equal(offline, false); return {status: 200, body: Buffer.from(JSON.stringify({...packages[0].catalog, packages: packages.map(item => item.record)}))};},
    downloadToFile: async (url, destination) => {assert.equal(offline, false); const item = packages.find(item => item.record.asset.url === url); assert.ok(item); fs.copyFileSync(item.archive, destination);}});
  for (const architecture of ['arm64', 'x64']) await Architecture.withArchitecture(architecture, async () => {
    const userDataDir = path.join(root, 'profile-' + architecture), manager = create('26.0');
    await manager.refreshCatalog({userDataDir, force: true});
    const selected = manager.resolveSelection({}, {}, userDataDir); assert.equal(selected.version, 'future-MCLv2');
    await manager.installRuntime({userDataDir, downloads: new (require('../src/modules/shared/runtime/download-manager').DownloadManager)()});
    const ready = manager.resolveSelection({}, {}, userDataDir);
    assert.equal(ready.ready, true, ready.reason); assert.equal(ready.install.manifest.arch, architecture);
    assert.equal(ready.install.manifest.gameArchitecture, 'x86_64');
    offline = true; assert.equal(create('26.0').resolveSelection({}, {}, userDataDir).ready, true);
    assert.equal(create('25.9').resolveSelection({}, {}, userDataDir).ready, false); offline = false;
  });
});

test('PS5 launch uses shared physical-host translation policy and keeps Intel Vulkan selection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5-native-launch-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const executable = path.join(root, 'game'); fs.writeFileSync(executable, require('./fixtures/macho-image').image({cpu: 0x01000007, fileType: 2, installName: null}));
  const Vulkan = require('../src/modules/shared/vulkan'), Bundled = require('../src/modules/shared/runtime/bundled-native');
  const Input = require('../src/modules/anyps5/input'), Focus = require('../src/modules/shared/runtime/native-focus');
  const Prepare = require('../src/modules/anyps5/prepare'), ProsperPrepare = require('../src/modules/prosper/prepare');
  const options = [], launched = [], selected = {ready: true, version: 'fixture', install: {executablePath: executable, installDir: root, root, declaration: {files: []}}};
  t.mock.method(Prepare, 'prepareGame', async () => ({directory: root, executable}));
  t.mock.method(ProsperPrepare, 'prepareGame', async () => ({root, dump: root, executable: '/app0/eboot.elf', environment: {}}));
  t.mock.method(Bundled, 'verifyPayload', () => true);
  t.mock.method(Input, 'prepare', () => ({})); t.mock.method(Input, 'routingEnvironment', () => ({}));
  t.mock.method(Vulkan, 'resolve', (_context, value) => {options.push(value); return {library: executable};});
  t.mock.method(Vulkan, 'environment', () => ({}));
  t.mock.method(Focus, 'spawnForegroundNativeGame', async payload => {launched.push(payload); return payload;});
  const modulePath = require.resolve('../src/modules/anyps5/main'); delete require.cache[modulePath];
  const anyps5 = require(modulePath); t.after(() => delete require.cache[modulePath]);
  t.mock.method(anyps5.runtimeManagers[0], 'resolveSelection', () => selected);
  const providerPath = require.resolve('../src/modules/prosper/provider'); delete require.cache[providerPath];
  const prosper = require(providerPath).createProvider({manager: {resolveSelection: () => selected}, spawn: async payload => {launched.push(payload); return payload;}});
  t.after(() => delete require.cache[providerPath]);
  const entry = {moduleId: 'anyps5', runtimeId: 'anyps5', gameType: 'ps5', moduleData: {format: 'elf'}};
  const {composeRuntimeProviders} = require('../src/modules/shared/runtime/providers');
  const composed = composeRuntimeProviders(anyps5, [prosper]);
  const {canLaunchEntry} = require('../src/core/launch-capability');
  const original = Architecture.requiresRosetta;
  for (const hardwareArch of ['x64', 'arm64']) await t.test(hardwareArch, async () => {
    const host = Host.getHostCapabilities({platform: 'darwin', launcherArch: 'x64', hardwareArch, macOSVersion: '26.0', rosettaAvailable: false});
    assert.equal(Host.architectureSupport('x64', host).supported, true);
    assert.equal(Host.architectureSupport('x64', host).installRosetta, hardwareArch === 'arm64');
    assert.equal(Requirements.requirementSupport({platform: 'darwin', minimumMacOS: '26.0'}, host).supported, true);
    t.mock.method(Architecture, 'requiresRosetta', architecture => original(architecture, host));
    let prompts = 0;
    for (const runtimeId of ['anyps5', 'prosper']) {
      assert.equal(canLaunchEntry({mod: composed, info: composed.manifest, entry, runtimeId, context: {arch: hardwareArch}}), true);
      await composed.launchRuntime(runtimeId, entry, {runtimeId, userDataDir: root, settings: {}, runtimeSettings: {}, ensureRosetta: async () => {prompts++;}});
      assert.equal(launched.at(-1).needsRosetta, hardwareArch === 'arm64');
      if(runtimeId==='anyps5')assert.equal(launched.at(-1).options.cwd,root);
      assert.equal(options.at(-1).architecture, 'x64');
    }
    assert.equal(prompts, hardwareArch === 'arm64' ? 2 : 0);
    Architecture.requiresRosetta.mock.restore();
  });
});
