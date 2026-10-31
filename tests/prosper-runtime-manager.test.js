const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const {nativeTool, packageFor, sha} = require('./helpers/managed-tool-fixture.cjs');
const {createManager} = require('../src/modules/prosper/runtime/manager');
const {DownloadManager} = require('../src/modules/shared/runtime/download-manager');
const {prepareForLaunch} = require('../src/core/runtime-preparation');
const {composeRuntimeProviders} = require('../src/modules/shared/runtime/providers');
const {createProvider} = require('../src/modules/prosper/provider');

test('Prosper managed Play obtains consent, resumes and preserves offline local choices', {skip: process.platform !== 'darwin'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-distribution-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const binary = nativeTool(path.join(root, 'native'), '', {architecture: 'x64'}).binary;
  const source = Buffer.from(JSON.stringify({upstreamRevision: 'a'.repeat(40)}));
  function fixture(name, redistribution) {
    const directory = path.join(root, name);
    const result = packageFor(directory, {id: 'prosper', version: name, architecture: 'x64',
      manifest: {managerId: 'prosper', gameArchitecture: 'x86_64', upstreamRevision: 'a'.repeat(40),
        ...(redistribution ? {redistribution} : {})},
      entries: [{path: 'bin/prosper-app', bytes: binary, mode: 0o755, architectures: ['x86_64']},
        {path: 'source.json', bytes: source, mode: 0o644}]});
    const container = path.join(directory, 'archive-input'), payload = path.join(container, 'files');
    fs.renameSync(path.join(payload, 'manifest.json'), path.join(payload, 'runtime.json'));
    result.record.manifestRelative = 'runtime.json';
    result.record.launcherArchitectures = ['arm64', 'x64'];
    const wrapper = JSON.parse(fs.readFileSync(path.join(container, 'runtime-package.json')));
    Object.assign(wrapper, {manifestRelative: 'runtime.json', launcherArchitectures: result.record.launcherArchitectures,
      sourceRelative: 'source.json'});
    wrapper.files.find(file => file.path === 'manifest.json').path = 'runtime.json';
    fs.writeFileSync(path.join(container, 'runtime-package.json'), JSON.stringify(wrapper));
    execFileSync('/usr/bin/tar', ['-czf', result.archive, '-C', container, 'runtime-package.json', 'files']);
    const archive = fs.readFileSync(result.archive);
    Object.assign(result.record.asset, {sha256: sha(archive), bytes: archive.length});
    return {...result, payload};
  }
  const ordinary = fixture('future-MCLv2'), legacy = fixture('legacy-local', 'local-only');
  const userDataDir = path.join(root, 'profile');
  let offline = false, requests = 0;
  const dependencies = {systemVersionSync: () => '27.0',
    fetchUrlBuffer: async () => {assert.equal(offline, false); requests++; return {status: 200, body: Buffer.from(JSON.stringify(ordinary.catalog))};},
    downloadToFile: async (_url, destination) => {assert.equal(offline, false); requests++; fs.copyFileSync(ordinary.archive, destination);}};
  const manager = createManager(dependencies);
  await manager.refreshCatalog({userDataDir, force: true, architecture: 'x64'});
  const installed = await manager.installRuntime({userDataDir, version: ordinary.record.version, architecture: 'x64', downloads: new DownloadManager()});
  assert.equal(installed.version, ordinary.record.version);
  assert.equal(manager.resolveSelection({}, {}, userDataDir, {version: ordinary.record.version, architecture: 'x64'}).ready, true);
  const local = await manager.registerCustomRuntime({userDataDir, runtimePath: legacy.payload});
  assert.equal(local.ready, true);
  offline = true; const count = requests;
  const reopened = createManager(dependencies);
  assert.equal(reopened.resolveSelection({}, {}, userDataDir, {version: ordinary.record.version, architecture: 'x64'}).ready, true);
  assert.equal(reopened.resolveSelection({}, {}, userDataDir, {version: local.version, architecture: 'x64'}).ready, true);
  assert.equal(requests, count);

  const packages = [fixture('3.0-MCLv1'), fixture('4.0-MCLv1')], events = [];
  const playData = path.join(root, 'first-play'), game = path.join(root, 'game');
  fs.mkdirSync(game);
  const elf = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1, 1, 9]).copy(elf);
  elf.writeUInt16LE(0xfe00, 16); elf.writeUInt16LE(62, 18);
  elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56);
  fs.writeFileSync(path.join(game, 'eboot.elf'), elf);
  const entry = {moduleId: 'anyps5', gameId: 'prosper-fixture', runtimeId: 'prosper', gameType: 'ps5', gamePath: game,
    moduleData: {format: 'elf', executablePath: path.join(game, 'eboot.elf')}};
  const playDependencies = {systemVersionSync: () => '27.0',
    fetchUrlBuffer: async () => {events.push('catalog'); return {status: 200, body: Buffer.from(JSON.stringify({...packages[0].catalog, packages: packages.map(item => item.record)}))};},
    downloadToFile: async (url, destination) => {
      events.push('download'); const selected = packages.find(item => item.record.asset.url === url);
      assert.ok(selected); fs.copyFileSync(selected.archive, destination);
    }};
  const playManager = createManager(playDependencies);
  const launches = [], driver = path.join(root, 'managed-vulkan.dylib');
  fs.writeFileSync(driver, 'selected driver fixture');
  const provider = createProvider({manager: playManager, vulkan: {requirements: () => [], resolve: () => ({library: driver}), environment: () => ({})},
    spawn: async payload => {launches.push(payload); return {pid: 1234};}});
  const base = require('../src/modules/anyps5/main');
  const mod = composeRuntimeProviders({...base, runtimeManagers: [playManager]}, [provider]);
  const registry = {listModules: () => [mod.manifest], getModule: () => mod};
  const context = {runtimeId: 'prosper', userDataDir: playData, settings: {},
    ensureRosetta: async () => events.push('rosetta'),
    confirmRuntimeInstall: async () => {events.push('consent'); return false;}};
  const play = async () => {
    const prepared = await prepareForLaunch({entry, mod, info: mod.manifest, context, registry,
      runAction: () => assert.fail('No preparation action'),
      install: (target, payload) => target.installRuntime({...payload, userDataDir: playData, downloads: new DownloadManager()})});
    if (!prepared) return false;
    events.push('resume'); return mod.launchRuntime('prosper', entry, context);
  };
  await t.test('declined Play does not discover, download or stage the game', async () => {
    assert.equal(await play(), false);
    assert.deepEqual(events, ['consent']); assert.equal(launches.length, 0);
    assert.equal(fs.existsSync(path.join(playData, 'games')), false);
  });
  await t.test('consented Play uses the shared newest version and resumes provider dispatch', async () => {
    events.length = 0; context.confirmRuntimeInstall = async () => {events.push('consent'); return true;};
    assert.deepEqual(await play(), {pid: 1234});
    assert.deepEqual(events, ['consent', 'catalog', 'download', 'resume', 'rosetta']);
    assert.match(launches[0].executablePath, /4\.0-MCLv1/);
    assert.equal(launches[0].needsRosetta, true);
    assert.deepEqual(launches[0].args.slice(2, 4), ['--guest-executable', '/app0/eboot.elf']);
    assert.deepEqual(fs.readFileSync(path.join(game, 'eboot.elf')), elf);
  });
  await t.test('installed Play reuses the selected package offline without consent', async () => {
    events.length = 0; context.confirmRuntimeInstall = () => assert.fail('Installed Play asks no consent');
    assert.deepEqual(await play(), {pid: 1234});
    assert.deepEqual(events, ['resume', 'rosetta']);
  });
  await t.test('a saved older managed version is installed instead of the newest version', async () => {
    events.length = 0; entry.runtimeData = {prosper: {version: '3.0-MCLv1'}};
    context.confirmRuntimeInstall = async plan => {assert.equal(plan.version, '3.0-MCLv1'); events.push('consent'); return true;};
    assert.deepEqual(await play(), {pid: 1234});
    assert.deepEqual(events, ['consent', 'download', 'resume', 'rosetta']);
    assert.match(launches.at(-1).executablePath, /3\.0-MCLv1/);
    assert.equal(entry.runtimeData.prosper.version, '3.0-MCLv1');
  });
  await t.test('a registered local build remains a usable offline Play choice', async () => {
    const localPlay = await playManager.registerCustomRuntime({userDataDir: playData, runtimePath: legacy.payload});
    entry.runtimeData = {prosper: {version: localPlay.version}};
    events.length = 0; context.confirmRuntimeInstall = () => assert.fail('Local builds ask no consent');
    assert.deepEqual(await play(), {pid: 1234});
    assert.deepEqual(events, ['resume', 'rosetta']);
    assert.equal(launches.at(-1).executablePath, path.join(legacy.payload, 'bin/prosper-app'));
  });
  fs.writeFileSync(path.join(installed.installDir, 'payload/bin/prosper-app'), Buffer.alloc(binary.length, 1));
  assert.equal(reopened.resolveSelection({}, {}, userDataDir, {version: ordinary.record.version, architecture: 'x64'}).ready, false);
});
