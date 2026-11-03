const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const {packageFor, sha} = require('./helpers/managed-tool-fixture.cjs');
const Native = require('../src/modules/shared/runtime/local-native');
const {prepareGame, resolveSaveLocations, gameDirectory, resolveSaveIdentity} = require('../src/modules/prosper/prepare');
const {createManager} = require('../src/modules/prosper/runtime/manager');
const {DownloadManager} = require('../src/modules/shared/runtime/download-manager');
const {prepareForLaunch} = require('../src/core/runtime-preparation');
const {composeRuntimeProviders} = require('../src/modules/shared/runtime/providers');
const {createProvider} = require('../src/modules/prosper/provider');
const {legacyGameMirrors} = require('../src/modules/prosper/backcompat');

function originalGame(root, name = 'selected.elf') {
  const game = path.join(root, 'game'); fs.mkdirSync(game, {recursive: true});
  const elf = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1, 1, 9]).copy(elf);
  elf.writeUInt16LE(0xfe00, 16); elf.writeUInt16LE(62, 18);
  elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56);
  const executablePath = path.join(game, name); fs.mkdirSync(path.dirname(executablePath), {recursive: true});
  fs.writeFileSync(executablePath, elf);
  return {moduleId: 'anyps5', gameId: 'original', gamePath: game, runtimeId: 'prosper', moduleData: {format: 'elf', executablePath}};
}

test('Prosper shared save identity uses only actual collisions and preserves explicit choices', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-save-facts-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const environment = {HOME: path.join(root, 'home')}, first = {...originalGame(path.join(root, 'first')), gameId: 'first'};
  const second = {...originalGame(path.join(root, 'second')), gameId: 'second'};
  const {applySaveIdentity} = require('../src/core/save-identity');
  const provider = createProvider(), describe = entry => provider.resolveSaveIdentity(entry, {}, environment);
  assert.equal(provider.resolveSaveIdentity, resolveSaveIdentity);
  assert.equal(provider.onImport, undefined); assert.equal(provider.onRuntimeChange, undefined);
  const alone = JSON.stringify(second), originalFirst = JSON.stringify(first);
  assert.deepEqual(applySaveIdentity(second, {games: [], describe}), second, 'One unknown title does not justify an automatic override');
  assert.equal(JSON.stringify(second), alone);
  const fact = describe(second);
  assert.equal(fact.namespace, 'prosper-save-data'); assert.equal(fact.scope, 'game');
  assert.equal(fact.hostSubstitution, false);
  assert.ok(JSON.parse(fact.identity).every(directory => directory.endsWith('/_unknown-title')));
  const separated = applySaveIdentity(second, {games: [first], describe});
  const expected = path.join(environment.HOME, '.local', 'share', 'prosper', 'games', 'second');
  assert.equal(separated.saveDirOverride, expected);
  assert.equal(separated.runtimeData.prosper.saveDirOverride, expected);
  assert.equal(separated.runtimeSettings?.prosper?.configPath, undefined, 'Intentional upstream player preferences are not blanket-isolated');
  assert.equal(JSON.stringify(first), originalFirst, 'Fact gathering never modifies another loaded record');
  assert.equal(JSON.stringify(second), alone, 'The shared core returns a patch rather than mutating the imported record');
  first.moduleData.titleId = 'PPSA12345'; second.moduleData.titleId = 'PPSA54321';
  assert.deepEqual(applySaveIdentity(second, {games: [first], describe}), second, 'Distinct authored IDs retain upstream save roots');
  const explicit = {...second, saveDirOverride: path.join(root, 'chosen'), runtimeData: {prosper: {version: 'keep'}}};
  const sameExplicit = {...first, saveDirOverride: explicit.saveDirOverride, moduleData: {...first.moduleData, titleId: second.moduleData.titleId}};
  assert.equal(describe(explicit).explicit, true);
  assert.deepEqual(applySaveIdentity(explicit, {games: [sameExplicit], describe}), explicit, 'An explicit shared user location stays explicit');
  delete first.moduleData.titleId; delete second.moduleData.titleId;
  const inactive = {...second, runtimeId: 'anyps5', saveDirOverride: '/chosen-anyps5', runtimeData: {anyps5: {version: 'kept'}, prosper: {version: 'also-kept'}}};
  const scoped = applySaveIdentity(inactive, {games: [first], describe});
  assert.equal(scoped.saveDirOverride, '/chosen-anyps5');
  assert.equal(scoped.runtimeData.anyps5.version, 'kept'); assert.equal(scoped.runtimeData.prosper.version, 'also-kept');
  assert.equal(scoped.runtimeData.prosper.saveDirOverride, expected);
  const prepared = await prepareGame(second, {userDataDir: path.join(root, 'profile')});
  assert.equal(prepared.environment.PROSPER_APP_CONFIG, undefined, 'Current ordinary preparation inherits upstream config');
  const chosen = {...second, runtimeSettings: {prosper: {configPath: path.join(root, 'chosen.conf')}}};
  assert.equal((await prepareGame(chosen, {userDataDir: path.join(root, 'profile')})).environment.PROSPER_APP_CONFIG, path.join(root, 'chosen.conf'));
  assert.equal(fs.existsSync(environment.HOME), false, 'Facts and shared patch construction write no runtime or user directories');
});

test('Prosper ordinary preparation uses the original dump without enumerating or staging it', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-original-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = originalGame(root, 'bin/selected.elf'), context = {userDataDir: path.join(root, 'profile')};
  const readdir = fs.promises.readdir;
  fs.promises.readdir = async () => assert.fail('Ordinary preparation must not walk the game tree');
  t.after(() => { fs.promises.readdir = readdir; });
  const before = fs.readFileSync(entry.moduleData.executablePath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const prepared = await prepareGame(entry, context);
    assert.equal(prepared.dump, fs.realpathSync(entry.gamePath));
    assert.equal(prepared.cwd, prepared.dump);
    assert.equal(prepared.executable, '/app0/bin/selected.elf');
    assert.deepEqual(prepared.environment, {PROSPER_GUEST_FS: '1'});
  }
  assert.equal(fs.existsSync(context.userDataDir), false, 'No private tree or receipt is produced');
  assert.deepEqual(fs.readFileSync(entry.moduleData.executablePath), before);
  entry.saveDirOverride = path.join(root, 'chosen-saves');
  const explicit = await prepareGame(entry, context);
  assert.deepEqual(explicit.environment, {PROSPER_GUEST_FS: '1', PROSPER_SAVE0: path.join(entry.saveDirOverride, 'savedata0'),
    PROSPER_SAVEDATA_DIR: path.join(entry.saveDirOverride, 'memory')});
  assert.equal(fs.existsSync(entry.saveDirOverride), false, 'The runtime creates explicit saves when needed');
});

test('Prosper save locations follow upstream environment defaults and explicit overrides', () => {
  assert.deepEqual(resolveSaveLocations({}, {}, {HOME: '/Users/example'}).directories.map(row => row.directory),
    ['/Users/example/.local/share/prosper/savedata0', '/Users/example/.local/share/prosper/savedata-mem']);
  assert.deepEqual(resolveSaveLocations({}, {}, {HOME: '/Users/example', XDG_DATA_HOME: '/data'}).directories.map(row => row.directory),
    ['/data/prosper/savedata0', '/data/prosper/savedata-mem']);
  assert.deepEqual(resolveSaveLocations({}, {}, {PROSPER_SAVE0: '/save', PROSPER_SAVEDATA_DIR: '/memory'}).directories.map(row => row.directory), ['/save', '/memory']);
  assert.deepEqual(resolveSaveLocations({saveDirOverride: '/chosen'}, {}, {}).directories.map(row => row.directory), ['/chosen/savedata0', '/chosen/memory']);
  assert.throws(() => resolveSaveLocations({saveDirOverride: 'relative'}, {}, {}), /absolute local/);
});

test('Prosper retains only the required split-input bridge and declares obsolete ordinary app0 separately', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-split-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = originalGame(root, 'source/selected.elf'), context = {userDataDir: path.join(root, 'profile')};
  fs.mkdirSync(path.join(entry.gamePath, 'app0')); fs.writeFileSync(path.join(entry.gamePath, 'app0', 'data.bin'), 'assets');
  entry.moduleData.inputLayout = 'anyps5-prepared';
  const prepared = await prepareGame(entry, context);
  assert.notEqual(prepared.dump, entry.gamePath);
  assert.equal(prepared.cwd, entry.gamePath);
  assert.equal(fs.readFileSync(path.join(prepared.dump, 'data.bin'), 'utf8'), 'assets');
  assert.deepEqual(fs.readFileSync(path.join(prepared.dump, 'eboot.elf')), fs.readFileSync(entry.moduleData.executablePath));
  assert.deepEqual(prepared.environment, {PROSPER_GUEST_FS: '1'});
  assert.equal(legacyGameMirrors(entry, context).some(row => row.mirrorRoot === prepared.dump), false, 'The live bridge is not retired');
  delete entry.moduleData.inputLayout;
  const descriptors = legacyGameMirrors(entry, context);
  assert.ok(descriptors.some(row => row.mirrorRoot === prepared.dump && row.sourceRoot === entry.gamePath));
  entry.saveDirOverride = prepared.dump;
  assert.equal(legacyGameMirrors(entry, context).some(row => row.mirrorRoot === prepared.dump), false, 'Explicit save targets remain live');
  assert.ok(fs.existsSync(path.join(prepared.dump, 'data.bin')), 'Descriptor generation never removes old bytes');
  entry.moduleData.executablePath = path.join(entry.gamePath, 'selected.self');
  delete entry.saveDirOverride;
  assert.equal(legacyGameMirrors(entry, context).some(row => row.mirrorRoot === prepared.dump), false, 'Required SELF aliases remain live');
});

test('Prosper managed Play obtains consent, resumes and preserves offline local choices', {skip: process.platform !== 'darwin'}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-distribution-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  // The provider spawn is stubbed; reuse signed system bytes without compiling
  // or executing a fixture merely to exercise package architecture checks.
  const binary = fs.readFileSync('/usr/bin/true'), binaryArchitectures = Native.readMachOArchitectures('/usr/bin/true');
  const source = Buffer.from(JSON.stringify({upstreamRevision: 'a'.repeat(40)}));
  function fixture(name, redistribution) {
    const directory = path.join(root, name);
    const result = packageFor(directory, {id: 'prosper', version: name, architecture: 'x64',
      manifest: {managerId: 'prosper', gameArchitecture: 'x86_64', upstreamRevision: 'a'.repeat(40),
        ...(redistribution ? {redistribution} : {})},
        entries: [{path: 'bin/prosper-app', bytes: binary, mode: 0o755, architectures: binaryArchitectures},
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
    assert.deepEqual(launches[0].args.slice(0, 2), ['--dump', game]);
    assert.equal(launches[0].options.cwd, game);
    assert.equal(launches[0].options.env.HOME, process.env.HOME);
    assert.equal(launches[0].options.env.XDG_DATA_HOME, process.env.XDG_DATA_HOME);
    assert.equal(fs.existsSync(path.join(gameDirectory(entry, context), 'app0')), false);
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
