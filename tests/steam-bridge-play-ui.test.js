const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { prepareForLaunch } = require('../src/core/runtime-preparation');
const Bridge = require('../src/modules/crossover/runtime/steam-bridge');
const Components = require('../src/modules/crossover/runtime/steam-client-components');

const id = 'maclauncher-steam-bridge', sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-bridge-ui-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A small package in the published bridge format, delivered through local transport callbacks.
function bridgePackage(root, version = '1.0.0') {
  const payload = path.join(root, 'payload-' + version), names = { 'x86_64-unix/lsteamclient.so': 'native x86_64', 'aarch64-unix/lsteamclient.so': 'native arm64',
    'i386-windows/lsteamclient.dll': 'builtin i386', 'x86_64-windows/lsteamclient.dll': 'builtin x86_64', 'i386-windows/mlsteam-bootstrap.dll': 'bootstrap i386',
    'x86_64-windows/mlsteam-bootstrap.dll': 'bootstrap x86_64', 'i386-windows/steam.exe': 'helper i386', 'steam.exe': 'helper x86_64' };
  const files = Object.entries(names).map(([relative, text]) => {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fs.chmodSync(file, 0o755);
    return { path: relative, mode: 0o755, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) };
  });
  const manifest = Buffer.from(JSON.stringify({ steamBridge: { abi: 1, role: 'native-steam-client-bridge',
    native: { x86_64: 'x86_64-unix/lsteamclient.so', aarch64: 'aarch64-unix/lsteamclient.so' },
    windows: { i386: { builtin: 'i386-windows/lsteamclient.dll', bootstrap: 'i386-windows/mlsteam-bootstrap.dll', helper: 'i386-windows/steam.exe' },
      x86_64: { builtin: 'x86_64-windows/lsteamclient.dll', bootstrap: 'x86_64-windows/mlsteam-bootstrap.dll', helper: 'steam.exe' } } },
  schemaVersion: 1, managerId: id, version, platform: 'darwin', arch: 'universal', minimumMacOS: '13.0', executableRelative: 'steam.exe', files, dependencies: [] }));
  fs.writeFileSync(path.join(payload, 'manifest.json'), manifest); fs.chmodSync(path.join(payload, 'manifest.json'), 0o644);
  const archive = Buffer.from('bridge archive ' + version), filename = `${id}-${version}-universal.tar.gz`, tag = `${id}/v${version}/universal`;
  const record = { schemaVersion: 2, id, version, arch: 'universal', launcherArchitectures: ['arm64', 'x64'], minimumMacOS: '13.0',
    manifestRelative: 'manifest.json', manifestSha256: sha(manifest), sourceSha256: sha(Buffer.from('source ' + version)), updatePolicy: 'manual', tag,
    asset: { filename, bytes: archive.length, sha256: sha(archive),
      url: `https://github.com/procrastinine/maclauncher-builds/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  const wrapper = { id, version, arch: 'universal', launcherArchitectures: record.launcherArchitectures, minimumMacOS: '13.0', sourceRelative: null,
    sourceSha256: record.sourceSha256, directoryRelative: `${id}/${version}/universal`, manifestRelative: 'manifest.json', manifestSha256: record.manifestSha256,
    files: [...files, { path: 'manifest.json', mode: 0o644, size: manifest.length, sha256: sha(manifest) }] };
  return { payload, record, archive, wrapper };
}
// Valve's archive layout: steamclient64.dll at the root and the i386 client under legacycompat.
function valveArchive(root) {
  const source = path.join(root, 'valve');
  fs.mkdirSync(path.join(source, 'legacycompat'), { recursive: true });
  fs.writeFileSync(path.join(source, 'steamclient64.dll'), 'genuine x86_64 client');
  fs.writeFileSync(path.join(source, 'legacycompat/steamclient.dll'), 'genuine i386 client');
  const archiveFile = path.join(root, 'bins_misc_ubuntu12.zip');
  execFileSync('/usr/bin/zip', ['-q', '-X', archiveFile, 'steamclient64.dll', 'legacycompat/steamclient.dll'], { cwd: source });
  const filename = 'bins_misc_ubuntu12.zip.' + crypto.createHash('sha1').update(fs.readFileSync(archiveFile)).digest('hex');
  return { archiveFile, resolved: { filename, url: 'https://client-update.akamai.steamstatic.com/' + filename } };
}
function offlineBridge(root, options = {}) {
  const item = bridgePackage(root), valve = valveArchive(root), requests = [];
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '480' }), discoverClient: () => '/Applications/Steam.app/Contents/MacOS', ...options, dependencies: {
    systemVersionSync: () => '26.0',
    fetchUrlBuffer: async url => { requests.push(url); return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: 'manual', packages: [item.record] })) }; },
    downloadToFile: async (url, destination) => { requests.push(url); fs.writeFileSync(destination, item.archive); },
    extractArchive: async (_archive, destination) => {
      fs.writeFileSync(path.join(destination, 'runtime-package.json'), JSON.stringify(item.wrapper));
      fs.cpSync(item.payload, path.join(destination, 'files'), { recursive: true });
    } } });
  // Play and Runtimes pass the same options. The Valve archive is supplied
  // locally here, and `received` records what the bridge passed for it.
  const received = [];
  const install = async (userDataDir, version, extra = {}) => {
    const original = Components.install;
    Components.install = options => { received.push(options); return original({ ...options, resolved: valve.resolved, archiveFile: valve.archiveFile }); };
    try { return await bridge.installRuntime({ userDataDir, version, ...extra }); } finally { Components.install = original; }
  };
  return { bridge, install, received, requests, item };
}
const play = ({ bridge, userDataDir, extra = [], answers = [], installBridge }) => {
  const dialogs = [], installs = [], launches = [];
  const engine = { id: 'engine', label: 'Wine engine', getState: () => ({ installed: [] }), installRuntime() {} };
  const entry = { name: 'Fixture', gamePath: '/Games/Fixture' };
  const run = prepareForLaunch({ entry, info: {},
    mod: { getRuntimeRequirements: async (game, context) => [...extra, ...await bridge.requirements(game, context)], prepareLaunch: async () => { launches.push(entry.name); } },
    context: { runtimeId: 'crossover', settings: { runtimes: {} }, userDataDir,
      confirmRuntimeInstall: async plan => { dialogs.push(plan); return answers.length ? answers.shift() : true; } },
    registry: { listModuleIds: () => [], listSharedRuntimeManagers: () => [bridge, engine] },
    install: async (manager, payload) => { installs.push([manager.id, payload.version]); if (manager.id === id) await installBridge?.(payload.version); } });
  return run.then(result => ({ result, dialogs, installs, launches }));
};
// The exact native dialog options from the launcher's own consent function.
function dialogOptions(plan, entry) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const code = source.slice(source.indexOf('async function confirmRuntimeInstallation('), source.indexOf('\nfunction logRuntimeToolSpawn('));
  const shown = [], context = { path, getLauncherDialogOwner: () => null, dialog: { showMessageBox: async options => { shown.push(options); return { response: 1 }; } } };
  vm.createContext(context); vm.runInContext(code, context);
  return context.confirmRuntimeInstallation(plan, entry).then(() => shown[0]);
}

test('a Windows Steam game without the bridge gets one optional dialog; Play Without It launches normally', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, requests } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const declined = await play({ bridge, userDataDir, answers: [false] });
  assert.equal(declined.result, true);
  assert.deepEqual(declined.launches, ['Fixture'], 'the ordinary launch continues');
  assert.deepEqual(declined.installs, []);
  assert.equal(declined.dialogs.length, 1);
  const [plan] = declined.dialogs;
  assert.equal(plan.label, 'Steam client bridge'); assert.equal(plan.version, '1.0.0'); assert.equal(plan.cancelLabel, 'Play Without It');
  assert.equal(plan.detail, 'Connects Fixture to the Steam client for Mac. The download is the bridge (0.1 MB) and Windows Steam client files from Valve. Fixture also starts without it.');
  const shown = await dialogOptions(plan, { name: 'Fixture' });
  assert.equal(shown.message, 'Download Steam client bridge 1.0.0?');
  assert.deepEqual(Array.from(shown.buttons), ['Download and Play', 'Play Without It']);
  assert.equal(shown.detail, plan.detail);
  const again = await play({ bridge, userDataDir });
  assert.deepEqual([again.dialogs.length, again.launches], [0, ['Fixture']], 'a declined game is not asked again');
  assert.equal(requests.length, 1, 'only the explicit Refresh read the catalog');
});

test('a consented bridge download installs the package and Valve files, then Play continues by itself', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, install } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const accepted = await play({ bridge, userDataDir, installBridge: version => install(userDataDir, version) });
  assert.equal(accepted.result, true);
  assert.deepEqual(accepted.installs, [[id, '1.0.0']]);
  assert.deepEqual(accepted.launches, ['Fixture']);
  assert.ok(Components.current(userDataDir), 'the Valve files are installed with the bridge');
  const next = await play({ bridge, userDataDir });
  assert.deepEqual([next.dialogs.length, next.installs.length, next.launches], [0, 0, ['Fixture']], 'later Plays need no consent');
});

test('with another Play download, the bridge is one line of that dialog', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, item } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const host = { managerId: 'engine', version: '11.0', label: 'Wine engine' };
  const accepted = await play({ bridge, userDataDir, extra: [host] });
  assert.equal(accepted.dialogs.length, 1, 'one dialog');
  assert.deepEqual(accepted.dialogs[0].companions, [{ label: 'Steam client bridge', versionLabel: '1.0.0', bytes: item.record.asset.bytes,
    summary: 'Connects Windows Steam games to the Steam client for Mac. Windows Steam client files are also downloaded from Valve.' }]);
  assert.deepEqual(accepted.installs.map(([manager]) => manager).sort(), ['engine', id]);
  const shown = await dialogOptions(accepted.dialogs[0], { name: 'Fixture' });
  assert.equal(shown.detail, 'Required to run Fixture.\n\nAlso downloads Steam client bridge 1.0.0 (0.1 MB). Connects Windows Steam games to the Steam client for Mac. Windows Steam client files are also downloaded from Valve.');
  const declined = await play({ bridge, userDataDir, extra: [host], answers: [false] });
  assert.deepEqual([declined.result, declined.launches], [false, []], 'declining the required download cancels Play');
});

test('Runtimes lists the bridge as one managed row with its Valve files, and removing its last version removes them', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, install, received, item } = offlineBridge(root);
  assert.deepEqual({ ...bridge.ui }, { groupId: 'steam-bridge', tabLabel: 'Steam client bridge', sectionLabel: 'Steam client bridge',
    management: 'managed', order: 202, category: 'compatibility' });
  const empty = bridge.getState({ userDataDir }).sections[0];
  assert.equal(empty.supportsDefault, false);
  assert.match(empty.description, /^Connects Windows Steam games in CrossOver and Sikarugir to the Steam client for Mac\./);
  assert.deepEqual(empty.components.map(row => [row.id, row.label, row.status, row.available, row.version]),
    [['steam-client-components', 'Windows Steam client files', 'Not installed', false, undefined]]);
  await bridge.refreshCatalog({ userDataDir, force: true });
  bridge.skipOptional({ appId: '480' }, { userDataDir });
  // A Components import passes the bridge package's own archive; the Valve install never receives it.
  const packageArchive = path.join(root, item.record.asset.filename);
  fs.writeFileSync(packageArchive, item.archive);
  await install(userDataDir, '1.0.0', { archiveFile: packageArchive });
  assert.deepEqual(Object.keys(received.at(-1)).sort(), ['onProgress', 'signal', 'userDataDir']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtimes/steam-bridge-skipped.json'))).apps, [],
    'an installation makes a declined game eligible again');
  const ready = bridge.getState({ userDataDir }).sections[0], active = Components.status(userDataDir);
  assert.deepEqual(ready.installed.map(row => row.version), ['1.0.0']);
  assert.deepEqual(ready.components.map(row => [row.status, row.available, row.version]), [['Installed', true, active.archiveSha1.slice(0, 12)]]);
  assert.equal(active.bytes, Buffer.byteLength('genuine x86_64 client') + Buffer.byteLength('genuine i386 client'));
  // Status reads sizes only; a changed size reads as not installed without hashing.
  fs.appendFileSync(path.join(userDataDir, 'runtimes/steam-client-components', active.archiveSha1, 'steamclient.dll'), '!');
  assert.equal(Components.status(userDataDir), null);
  assert.equal(await bridge.uninstallRuntime({ userDataDir, version: '1.0.0' }), true);
  assert.equal(fs.existsSync(path.join(userDataDir, 'runtimes/steam-client-components')), false);
  assert.equal(bridge.getState({ userDataDir }).sections[0].components[0].status, 'Not installed');
  assert.equal(Components.remove(userDataDir), false, 'nothing else is removed');
  // Play uses only managed versions; the registry leaves the row without custom registration.
  require('../src/modules/shared/runtime/custom-runtime').instrumentManagers([bridge]);
  assert.equal(bridge.getState({ userDataDir }).sections[0].customRuntime, false);
  assert.equal(bridge.registerCustomRuntime, undefined);
});

test('the inspector line names the bridge only after a Play that used an installed version', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, install } = offlineBridge(root);
  assert.equal(bridge.inspectorDetail(undefined, userDataDir), null);
  assert.equal(bridge.inspectorDetail({ steamBridge: null }, userDataDir), null, 'a Play without the bridge shows nothing');
  assert.equal(bridge.inspectorDetail({ steamBridge: { version: '1.0.0' } }, userDataDir), null, 'a removed version shows nothing');
  await bridge.refreshCatalog({ userDataDir, force: true });
  await install(userDataDir, '1.0.0');
  assert.deepEqual(bridge.inspectorDetail({ steamBridge: { version: '1.0.0' } }, userDataDir), { label: 'Steam', value: 'Steam client bridge 1.0.0' });
  assert.equal(bridge.inspectorDetail({ steamBridge: { version: '0.9.0' } }, userDataDir), null);
});
