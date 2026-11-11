const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { prepareForLaunch } = require('../src/core/runtime-preparation');
const Bridge = require('../src/modules/crossover/runtime/steam-bridge');
const Components = require('../src/modules/crossover/runtime/steam-client-components');
const Upstream = require('../src/modules/shared/runtime/upstream');

const id = 'maclauncher-steam-bridge', sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-bridge-ui-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A small package in the published bridge format, delivered through local transport callbacks.
function bridgePackage(root, version = '1.0.0', managed = true) {
  const payload = path.join(root, 'payload-' + version), names = { 'x86_64-unix/lsteamclient.so': 'native x86_64', 'aarch64-unix/lsteamclient.so': 'native arm64',
    'i386-windows/lsteamclient.dll': 'builtin i386', 'x86_64-windows/lsteamclient.dll': 'builtin x86_64', 'i386-windows/mlsteam-bootstrap.dll': 'bootstrap i386',
    'x86_64-windows/mlsteam-bootstrap.dll': 'bootstrap x86_64', 'i386-windows/steam.exe': 'helper i386', 'steam.exe': 'helper x86_64' };
  const files = Object.entries(names).map(([relative, text]) => {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fs.chmodSync(file, 0o755);
    return { path: relative, mode: 0o755, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) };
  });
  const manifest = Buffer.from(JSON.stringify({ steamBridge: { clientEnvironment: managed ? { i386: 'MACLAUNCHER_STEAM_CLIENT32', x86_64: 'MACLAUNCHER_STEAM_CLIENT64' } : undefined,
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
  const zip = path.join(root, 'bins_misc_ubuntu12.zip');
  execFileSync('/usr/bin/zip', ['-q', '-X', zip, 'steamclient64.dll', 'legacycompat/steamclient.dll'], { cwd: source });
  const filename = 'bins_misc_ubuntu12.zip.' + crypto.createHash('sha1').update(fs.readFileSync(zip)).digest('hex');
  return { zip, resolved: { filename, url: 'https://client-update.akamai.steamstatic.com/' + filename } };
}
function offlineBridge(root, { version, ...options } = {}) {
  const item = bridgePackage(root, version), valve = valveArchive(root), requests = [];
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '480' }), discoverClient: () => '/Applications/Steam.app/Contents/MacOS', isRunning: () => false, ...options, dependencies: {
    systemVersionSync: () => '26.0',
    fetchUrlBuffer: async url => { requests.push(url); return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: 'manual', packages: [item.record] })) }; },
    downloadToFile: async (url, destination) => { requests.push(url); fs.writeFileSync(destination, item.archive); },
    extractArchive: async (_archive, destination) => {
      fs.writeFileSync(path.join(destination, 'runtime-package.json'), JSON.stringify(item.wrapper));
      fs.cpSync(item.payload, path.join(destination, 'files'), { recursive: true });
    } } });
  // Play and Runtimes pass the same options. Valve's download is served from
  // the local archive here, and `received` records what the bridge passed.
  const received = [];
  const install = async (userDataDir, version, extra = {}) => {
    const original = Components.install, download = Upstream.download;
    Components.install = options => { received.push(options); return original({ ...options, resolved: valve.resolved }); };
    Upstream.download = async (_asset, destination) => fs.copyFileSync(valve.zip, destination);
    try { return await bridge.installRuntime({ userDataDir, version, ...extra }); } finally { Components.install = original; Upstream.download = download; }
  };
  return { bridge, install, received, requests, item, valve };
}
const play = ({ bridge, userDataDir, extra = [], answers = [], installBridge }) => {
  const dialogs = [], installs = [], launches = [];
  const engine = { id: 'engine', label: 'Wine engine', getState: () => ({ installed: [] }), installRuntime() {} };
  const entry = { name: 'Fixture', gamePath: '/Games/Fixture' };
  const context = { runtimeId: 'crossover', settings: { runtimes: {} }, userDataDir,
    confirmRuntimeInstall: async plan => { dialogs.push(plan); return answers.length ? answers.shift() : true; } };
  const run = prepareForLaunch({ entry, info: {}, context,
    mod: { getRuntimeRequirements: async (game, context) => [...extra, ...await bridge.requirements(game, context)], prepareLaunch: async () => { launches.push(entry.name); } },
    registry: { listModuleIds: () => [], listSharedRuntimeManagers: () => [bridge, engine] },
    install: async (manager, payload) => { installs.push([manager.id, payload.version]); if (manager.id === id) await installBridge?.(payload.version); } });
  return run.then(result => ({ result, dialogs, installs, launches, grants: [...context.grants || []] }));
};
// The exact native dialog options from the launcher's own consent function,
// and what it returns for one answer.
async function dialogOptions(plan, entry, answer = { response: 1 }) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const code = source.slice(source.indexOf('async function confirmRuntimeInstallation('), source.indexOf('\nfunction logRuntimeToolSpawn('));
  const shown = [], context = { path, getLauncherDialogOwner: () => null, dialog: { showMessageBox: async options => { shown.push(options); return answer; } } };
  vm.createContext(context); vm.runInContext(code, context);
  const result = await context.confirmRuntimeInstallation(plan, entry);
  return Object.assign(shown[0], { result });
}

test('a Windows Steam game asks Play with Steam? once; Play Without Steam launches and is kept until an installation', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, requests, install } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const declined = await play({ bridge, userDataDir, answers: [false] });
  assert.equal(declined.result, true);
  assert.deepEqual(declined.launches, ['Fixture'], 'the ordinary launch continues');
  assert.deepEqual([declined.installs, declined.grants], [[], []]);
  assert.equal(declined.dialogs.length, 1);
  const [plan] = declined.dialogs;
  assert.deepEqual([plan.label, plan.version, plan.message, plan.confirmLabel, plan.cancelLabel],
    ['Steam client bridge', '1.0.0', 'Play with Steam?', 'Play with Steam', 'Play Without Steam']);
  assert.equal(plan.detail, 'Connects Fixture to the Steam client for Mac. Downloads the Steam client bridge (0.1 MB) and the Windows Steam client files from Valve, then starts Steam.' +
    '\n\nWithout Steam, Fixture runs without the Steam client until the bridge is installed in Runtimes.');
  const shown = await dialogOptions(plan, { name: 'Fixture' });
  assert.equal(shown.message, 'Play with Steam?');
  assert.deepEqual(Array.from(shown.buttons), ['Play with Steam', 'Play Without Steam']);
  assert.equal(shown.detail, plan.detail);
  assert.equal(shown.checkboxLabel, undefined, 'a standalone question has no checkbox');
  const again = await play({ bridge, userDataDir });
  assert.deepEqual([again.dialogs.length, again.launches], [0, ['Fixture']], 'the choice is kept');
  await bridge.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(await bridge.requirements({ name: 'Fixture' }, { userDataDir }), [], 'a Refresh keeps the choice');
  assert.equal(requests.length, 2, 'only the explicit Refreshes read the catalog');
  await install(userDataDir, '1.0.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtimes/steam-bridge-skipped.json'))).apps, [], 'an installation clears it');
});

test('a consented bridge download installs the package and Valve files, then Play continues by itself', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, install } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const accepted = await play({ bridge, userDataDir, installBridge: version => install(userDataDir, version) });
  assert.equal(accepted.result, true);
  assert.deepEqual(accepted.installs, [[id, '1.0.0']]);
  assert.deepEqual(accepted.launches, ['Fixture']);
  assert.deepEqual(accepted.grants, ['steam-client-start'], 'Play with Steam also approves starting Steam for this Play');
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
  const detail = 'Connecting to Steam also downloads the Steam client bridge 1.0.0 (0.1 MB) and the Windows Steam client files from Valve, then starts Steam. ' +
    'Without it, Fixture runs without Steam until the bridge is installed in Runtimes.';
  assert.deepEqual(accepted.dialogs[0].companions, [{ label: 'Steam client bridge', versionLabel: '1.0.0', bytes: item.record.asset.bytes, detail, checkboxLabel: 'Also connect to Steam' }]);
  assert.deepEqual(accepted.installs.map(([manager]) => manager).sort(), ['engine', id]);
  assert.deepEqual(accepted.grants, ['steam-client-start']);
  const shown = await dialogOptions(accepted.dialogs[0], { name: 'Fixture' }, { response: 0, checkboxChecked: true });
  assert.equal(shown.detail, 'Required to run Fixture.\n\n' + detail);
  assert.deepEqual([shown.checkboxLabel, shown.checkboxChecked, shown.result], ['Also connect to Steam', true, true]);
  const cleared = await dialogOptions(accepted.dialogs[0], { name: 'Fixture' }, { response: 0, checkboxChecked: false });
  assert.deepEqual({ ...cleared.result }, { approved: true, companionsDeclined: true });
  // A cleared checkbox installs the required download, declines the bridge for this game, and Play continues.
  const without = await play({ bridge, userDataDir, extra: [host], answers: [{ approved: true, companionsDeclined: true }] });
  assert.deepEqual([without.result, without.installs, without.launches, without.grants], [true, [['engine', '11.0']], ['Fixture'], []]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtimes/steam-bridge-skipped.json'))).apps, ['480']);
  fs.rmSync(path.join(userDataDir, 'runtimes/steam-bridge-skipped.json'));
  const declined = await play({ bridge, userDataDir, extra: [host], answers: [false] });
  assert.deepEqual([declined.result, declined.launches], [false, []], 'declining the required download cancels Play');
});

test('Runtimes lists the bridge as one managed row with its Valve files, and removing its last version removes them', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, install, received, item, valve } = offlineBridge(root);
  assert.deepEqual({ ...bridge.ui }, { groupId: 'steam-bridge', tabLabel: 'Steam client bridge', sectionLabel: 'Steam client bridge',
    management: 'managed', order: 203, category: 'compatibility' });
  const empty = bridge.getState({ userDataDir }).sections[0];
  assert.equal(empty.supportsDefault, false);
  assert.match(empty.description, /^Connects Windows Steam games in CrossOver, Sikarugir and WineCX to the Steam client for Mac\./);
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
  assert.equal(await Components.remove(userDataDir), false, 'nothing else is removed');
  // The next offer names the size of the last verified Valve download, offline.
  assert.deepEqual(Components.lastDownload(userDataDir), { filename: valve.resolved.filename, bytes: fs.statSync(valve.zip).size });
  const [offer] = await bridge.requirements({ name: 'Fixture' }, { userDataDir });
  assert.match(offer.detail, /the Steam client bridge \(0\.1 MB\) and the Windows Steam client files from Valve \(about 0\.1 MB\), then starts Steam\./);
  const running = offlineBridge(path.join(root, 'running'), { isRunning: () => true }).bridge;
  assert.doesNotMatch((await running.requirements({ name: 'Fixture' }, { userDataDir }))[0].detail, /starts Steam/, 'a running Steam client is not started again');
  assert.doesNotMatch((await bridge.requirements({ name: 'Fixture', startSteamClient: 'never' }, { userDataDir }))[0].detail, /starts Steam/, "Don't start keeps Steam closed");
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

test('Play sizes use only an earlier complete Valve total without a metadata request', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge, requests } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const record = path.join(userDataDir, 'runtimes/steam-client-download.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  for (const [value, expected] of [[null, false], [{ filename: 'old.zip', bytes: 1048576 }, false],
    [{ filename: 'last.zip', totalBytes: 7340032 }, true]]) {
    if (value) fs.writeFileSync(record, JSON.stringify(value));
    const [plan] = await bridge.requirements({ name: 'Fixture' }, { userDataDir });
    for (const text of [plan.detail, plan.companionDetail]) {
      assert.equal(text.includes('the Windows Steam client files from Valve (about 7.0 MB)'), expected);
      assert.doesNotMatch(text, /unknown|previous download/i);
      if (!expected) assert.doesNotMatch(text, /files from Valve \(/);
    }
    assert.equal(requests.length, 1, 'only the explicit Refresh used the local metadata transport');
  }
});

test('an incompatible installed bridge is marked unusable and consent replaces it before resuming Play', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data');
  const { bridge, install, item, requests } = offlineBridge(root, { version: '9.7.0' });
  const older = bridgePackage(path.join(root, 'older'), '1.0.0', false);
  const retained = path.join(userDataDir, 'runtimes', id, 'universal', older.record.version);
  fs.mkdirSync(retained, { recursive: true }); fs.cpSync(older.payload, path.join(retained, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(retained, 'project-package.json'), JSON.stringify(older.wrapper));
  fs.writeFileSync(path.join(retained, 'runtime.json'), JSON.stringify({ version: older.record.version, architecture: 'universal',
    upstreamRevision: older.record.asset.sha256, archiveSha256: older.record.asset.sha256,
    binarySha256: sha(fs.readFileSync(path.join(older.payload, 'steam.exe'))), executableRelative: 'payload/steam.exe',
    source: 'download', catalogEntry: { version: older.record.version, upstreamRevision: older.record.asset.sha256,
      architecture: 'universal', hostArchitectures: ['arm64', 'x64'], localBuild: false, projectPackage: older.record, asset: older.record.asset } }));
  const protectedBytes = fs.readFileSync(path.join(retained, 'payload/manifest.json'));
  await bridge.refreshCatalog({ userDataDir, force: true });
  const row = bridge.getState({ userDataDir }).sections[0].installed.find(row => row.version === '1.0.0');
  assert.equal(row.ready, false); assert.equal(row.status, 'incompatible');
  assert.match(row.error, /managed loader paths.*needs replacement/);
  const [plan] = await bridge.requirements({ name: 'Fixture' }, { userDataDir });
  assert.equal(plan.version, item.record.version); assert.equal(plan.silentFallback, undefined);
  assert.match(plan.detail, /Installed bridge 1\.0\.0 cannot be used:.*needs replacement/);
  const accepted = await play({ bridge, userDataDir, installBridge: version => install(userDataDir, version) });
  assert.equal(accepted.result, true);
  assert.deepEqual(accepted.installs, [[id, '9.7.0']]); assert.deepEqual(accepted.launches, ['Fixture']);
  assert.equal(bridge.resolveSelection(null, {}, userDataDir, { version: '9.7.0' }).ready, true);
  assert.equal(requests.length, 2, 'one explicit catalog read and the consented package acquisition');
  assert.deepEqual(await bridge.requirements({ name: 'Fixture' }, { userDataDir }), []);
  assert.deepEqual(fs.readFileSync(path.join(retained, 'payload/manifest.json')), protectedBytes);
});

test('consented bridge failures surface their actual error without launching or saving a refusal', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), { bridge } = offlineBridge(root);
  await bridge.refreshCatalog({ userDataDir, force: true });
  const failure = new Error('Valve archive HTTP 503');
  await assert.rejects(play({ bridge, userDataDir, installBridge: async () => { throw failure; } }), error => error === failure);
  assert.equal(fs.existsSync(path.join(userDataDir, 'runtimes/steam-bridge-skipped.json')), false);
  assert.equal((await bridge.requirements({ name: 'Fixture' }, { userDataDir })).length, 1, 'a failed download can be tried again');
  const Catalog = require('../src/modules/shared/runtime/maclauncher-builds');
  const unavailable = Bridge.create({ identifyGame: () => ({ appId: '480' }), discoverClient: () => '/client',
    dependencies: { systemVersionSync: () => '26.0', fetchUrlBuffer: async () => ({ status: 404, body: Buffer.from('404: Not Found') }) } });
  await assert.rejects(play({ bridge: unavailable, userDataDir: path.join(root, 'unavailable') }), error => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.url, Catalog.catalogUrl({ projectId: id, repository: 'procrastinine/maclauncher-builds' }));
    assert.match(error.message, /HTTP 404.*catalogs\/maclauncher-steam-bridge\.json/);
    return true;
  });
});
