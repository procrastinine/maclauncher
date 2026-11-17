const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { writeZipArchive } = require('./helpers/zip-fixture');
const Upstream = require('../src/modules/shared/runtime/upstream');
const Custom = require('../src/modules/shared/runtime/custom-runtime');
const Components = require('../src/modules/crossover/runtime/steam-client-components');
const ClientFiles = require('../src/modules/crossover/runtime/steam-client-files');
const Bridge = require('../src/modules/crossover/runtime/steam-bridge');
const { peFixture, versionResource } = require('./helpers/pe-fixture');
const { runRuntimeManagerAction } = require('../src/core/runtime-manager-service');

const sha = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-client-files-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A Windows PE image of one CPU; never loaded.
function client(is64) { const fixture = peFixture({ is64 }); fixture.bytes.writeUInt16LE(0x2102, fixture.peOffset + 22); return fixture.bytes; }
// A Valve archive: with the client DLLs, in Valve's layout, or without them.
function archive(root, name, withClients, marker = name, client64 = client(true)) {
  const source = path.join(root, 'src-' + name);
  fs.mkdirSync(path.join(source, 'legacycompat'), { recursive: true });
  const members = withClients ? ['steamclient64.dll', 'legacycompat/steamclient.dll'] : ['readme.txt'];
  if (withClients) {
    fs.writeFileSync(path.join(source, 'steamclient64.dll'), Buffer.concat([client64, Buffer.from(marker)]));
    fs.writeFileSync(path.join(source, 'legacycompat/steamclient.dll'), Buffer.concat([client(false), Buffer.from(marker)]));
  } else fs.writeFileSync(path.join(source, 'readme.txt'), marker);
  const zip = path.join(root, name + '.zip');
  writeZipArchive(zip, members.map(name => ({ name, data: fs.readFileSync(path.join(source, name)), deflate: true })));
  const bytes = fs.readFileSync(zip), filename = `${name}.zip.${sha(bytes, 'sha1')}`;
  return { zip, bytes, listed: { filename, url: Components.ORIGIN + '/' + filename, sha1: sha(bytes, 'sha1'), sha256: sha(bytes), bytes: bytes.length, manifestVersion: '1792618285' } };
}
// Valve's CDN, served from the local archives: byte ranges and downloads.
function cdn(t, archives) {
  const reads = [], byUrl = new Map(archives.map(item => [item.listed.url, item.bytes]));
  const range = async (listed, start, length) => { reads.push(listed.url); const bytes = byUrl.get(listed.url); return { bytes: bytes.subarray(start, start + length), total: bytes.length }; };
  t.mock.method(Upstream, 'range', range);
  t.mock.method(Upstream, 'download', async (listed, destination) => fs.writeFileSync(destination, byUrl.get(listed.url)));
  return reads;
}
const act = (manager, userDataDir, action, payload, settings = {}) => runRuntimeManagerAction({ manager, action, payload: { sectionId: 'default', ...payload },
  userDataDir, readSettings: () => settings.value || {}, saveSettings: next => { settings.value = next; } });

test('Refresh lists the archive of Valve\'s current client that holds both client DLLs, read in parts without downloading archives', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data');
  const other = archive(root, 'resources_all', false), misc = archive(root, 'bins_misc_ubuntu12', true);
  const reads = cdn(t, [other, misc]);
  const rows = await Components.discover({ userDataDir, resolved: [other.listed, misc.listed] });
  assert.deepEqual(rows.map(row => [row.version, row.filename, row.sha256]), [[misc.listed.sha1, misc.listed.filename, misc.listed.sha256]]);
  assert.ok(reads.every(url => [other.listed.url, misc.listed.url].includes(url)));
  const catalog = ClientFiles.getState({ userDataDir }).sections[0].catalog;
  assert.deepEqual(catalog.installableVersions, [misc.listed.sha1]);
  assert.equal(catalog.versionLabels[misc.listed.sha1], 'Steam client 1792618285');
  assert.equal(catalog.label,'Versions');assert.equal(catalog.sourceLabel,'Valve CDN');
  // The section's description already says what Valve lists; the source row adds no second line (GUI 0877 R27).
  assert.equal(catalog.description,undefined);
  assert.equal(catalog.preferInstalled,true);
  // After an installation, archives of the family it came from are read first.
  await ClientFiles.installRuntime({ userDataDir, version: misc.listed.sha1 });
  reads.length = 0;
  await Components.discover({ userDataDir, resolved: [other.listed, misc.listed] });
  assert.equal(reads[0], misc.listed.url);
});

test('each listed Valve version installs beside the others, one is the default, and removing one keeps the rest', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), settings = {};
  const older = archive(root, 'bins_misc_ubuntu12', true, 'older'), newer = archive(path.join(root, 'n'), 'bins_misc_ubuntu12', true, 'newer');
  fs.mkdirSync(path.join(root, 'n'), { recursive: true });
  cdn(t, [older, newer]);
  await Components.discover({ userDataDir, resolved: [older.listed] });
  await act(ClientFiles, userDataDir, 'install', { version: older.listed.sha1 }, settings);
  await Components.discover({ userDataDir, resolved: [newer.listed] });
  await act(ClientFiles, userDataDir, 'install', { version: newer.listed.sha1 }, settings);
  const state = () => ClientFiles.getState({ userDataDir, settings: settings.value }).sections[0];
  assert.deepEqual(state().installed.map(row => row.version).sort(), [older.listed.sha1, newer.listed.sha1].sort());
  await act(ClientFiles, userDataDir, 'setDefault', { version: older.listed.sha1 }, settings);
  assert.deepEqual([state().defaultVersion, state().defaultSource], [older.listed.sha1, 'saved']);
  const selected = ClientFiles.resolveSelection(null, { runtimes: { [ClientFiles.id]: settings.value } }, userDataDir);
  assert.equal(selected.ready, true);
  assert.equal(selected.install.root, path.join(userDataDir, 'runtimes/steam-client-components', older.listed.sha1));
  await act(ClientFiles, userDataDir, 'uninstall', { version: older.listed.sha1 }, settings);
  assert.deepEqual(state().installed.map(row => row.version), [newer.listed.sha1]);
  assert.equal(settings.value.defaultVersion, null, 'removing the default version clears it');
  assert.equal(ClientFiles.resolveSelection(null, {}, userDataDir).install.version, newer.listed.sha1);
});

test('a later automatic copy of the client files replaces the earlier automatic copy, and an explicit installation stays', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), settings = {};
  const older = archive(root, 'bins_misc_ubuntu12', true, 'older'), newer = archive(path.join(root, 'n'), 'bins_misc_ubuntu12', true, 'newer');
  const kept = archive(path.join(root, 'k'), 'bins_misc_ubuntu12', true, 'kept');
  cdn(t, [older, newer, kept]);
  await Components.discover({ userDataDir, resolved: [kept.listed] });
  await act(ClientFiles, userDataDir, 'install', { version: kept.listed.sha1 }, settings);
  fs.rmSync(path.join(userDataDir, 'runtimes/steam-client-components', kept.listed.sha1, 'steamclient64.dll'));
  await Components.discover({ userDataDir, resolved: [older.listed] });
  await ClientFiles.ensure({ userDataDir });
  // The automatic copy stops being usable, and the next Play installs Valve's current client.
  fs.rmSync(path.join(userDataDir, 'runtimes/steam-client-components', older.listed.sha1, 'steamclient64.dll'));
  await Components.discover({ userDataDir, resolved: [newer.listed] });
  await ClientFiles.ensure({ userDataDir });
  const Origins = require('../src/core/runtime-install-origins');
  const { removed } = await Origins.pruneSuperseded({ userDataDir, managers: [ClientFiles],
    remove: ({ managerId, ...payload }) => act(ClientFiles, userDataDir, 'uninstall', payload, settings) });
  assert.deepEqual(removed.map(row => row.version), [older.listed.sha1]);
  assert.deepEqual(ClientFiles.getState({ userDataDir }).sections[0].installed.map(row => row.version).sort(), [kept.listed.sha1, newer.listed.sha1].sort());
});

test('direct automatic installs record ownership while a saved default and explicit client version survive shared pruning', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), settings = {};
  const copies = ['explicit', 'older', 'newer'].map(marker => archive(path.join(root, marker), 'bins_misc_ubuntu12', true, marker));
  cdn(t, copies);
  await Components.discover({ userDataDir, resolved: [copies[0].listed] });
  await act(ClientFiles, userDataDir, 'install', { version: copies[0].listed.sha1 }, settings);
  await act(ClientFiles, userDataDir, 'setDefault', { version: copies[0].listed.sha1 }, settings);
  for (const copy of copies.slice(1)) {
    await Components.discover({ userDataDir, resolved: [copy.listed] });
    await ClientFiles.installRuntime({ userDataDir, version: copy.listed.sha1, automatic: true });
  }
  const Origins = require('../src/core/runtime-install-origins');
  assert.deepEqual(Origins.read(userDataDir).map(row => row.version), copies.slice(1).map(copy => copy.listed.sha1));
  const result = await Origins.pruneSuperseded({ userDataDir, managers: [ClientFiles], settings: { runtimes: { [ClientFiles.id]: settings.value } },
    remove: ({ managerId, ...payload }) => act(ClientFiles, userDataDir, 'uninstall', payload, settings) });
  assert.deepEqual(result.removed.map(row => row.version), [copies[1].listed.sha1]);
  assert.deepEqual(ClientFiles.getState({ userDataDir }).installed.map(row => row.version).sort(), [copies[0], copies[2]].map(copy => copy.listed.sha1).sort());
  assert.equal(settings.value.defaultVersion, copies[0].listed.sha1, 'automatic acquisition does not write a user default');
});

test('a content-addressed Valve download refuses an actual wrong-CPU client before publishing a managed version', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data');
  const wrong = archive(root, 'bins_misc_ubuntu12', true, 'wrong-cpu', client(false));
  cdn(t, [wrong]);
  await Components.discover({ userDataDir, resolved: [wrong.listed] });
  await assert.rejects(ClientFiles.installRuntime({ userDataDir, version: wrong.listed.sha1 }), /steamclient64\.dll has the wrong Windows CPU/);
  assert.deepEqual(ClientFiles.getState({ userDataDir }).installed, []);
  assert.equal(Components.current(userDataDir), null);
});

test('an installed client record must retain both required CPU members', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), copy = archive(root, 'bins_misc_ubuntu12', true);
  cdn(t, [copy]);
  await Components.discover({ userDataDir, resolved: [copy.listed] });
  await ClientFiles.installRuntime({ userDataDir, version: copy.listed.sha1 });
  const directory = path.join(userDataDir, 'runtimes/steam-client-components'), recordPath = path.join(directory, copy.listed.sha1 + '.json');
  const record = JSON.parse(fs.readFileSync(recordPath));
  delete record.clients.i386;
  record.files = record.files.filter(row => row.path !== 'steamclient.dll');
  for (const name of [recordPath, path.join(directory, 'active.json')]) fs.writeFileSync(name, JSON.stringify(record));
  assert.equal(Components.current(userDataDir, copy.listed.sha1), null);
  assert.equal(Components.status(userDataDir, copy.listed.sha1), null);
  assert.equal(ClientFiles.resolveSelection(null, {}, userDataDir).ready, false);
});

// Valve's 64-bit client names its build in a language-neutral version resource beside a fixed 3.0.0.1 one.
function valveClient64() {
  const fixture = peFixture({ is64: true, version: versionResource({ fileVersion: [3, 0, 0, 1], strings: { ProductName: 'Steam' } }),
    alternate: versionResource({ fileVersion: [10, 96, 30, 42], strings: { ProductName: 'Steam' } }) });
  fixture.bytes.writeUInt16LE(0x2102, fixture.peOffset + 22);
  return fixture.bytes;
}
test('client files without a Valve manifest version, from an earlier record or a registered folder, are named by the client build', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data'), copy = archive(root, 'bins_misc_ubuntu12', true, 'legacy', valveClient64());
  cdn(t, [copy]);
  await Components.discover({ userDataDir, resolved: [copy.listed] });
  await ClientFiles.installRuntime({ userDataDir, version: copy.listed.sha1 });
  const label = () => ClientFiles.getState({ userDataDir }).catalog.versionLabels[copy.listed.sha1];
  assert.equal(label(), 'Steam client 1792618285', 'a record with a manifest version keeps it');
  // Earlier launchers kept one active.json without the manifest version.
  const directory = path.join(userDataDir, 'runtimes/steam-client-components'), recordPath = path.join(directory, copy.listed.sha1 + '.json');
  const { manifestVersion, installedAt, ...legacy } = JSON.parse(fs.readFileSync(recordPath));
  fs.rmSync(recordPath); fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ schemaVersion: 1, rows: [] }));
  assert.equal(label(), 'Steam client 10.96.30.42');
  Custom.instrumentManagers([ClientFiles]);
  const folder = path.join(root, copy.listed.sha1);
  fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'steamclient64.dll'), valveClient64()); fs.writeFileSync(path.join(folder, 'steamclient.dll'), client(false));
  const registered = await act(ClientFiles, userDataDir, 'registerCustom', { runtimePath: folder });
  assert.equal(registered.versionLabel, 'Steam client 10.96.30.42', 'a folder named by its content address reads as the client build');
});

test('a folder with both Windows Steam clients is registered in place; a wrong or missing client is refused', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data');
  Custom.instrumentManagers([ClientFiles]);
  const folder = path.join(root, 'clients');
  fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'SteamClient64.dll'), client(true)); fs.writeFileSync(path.join(folder, 'steamclient.dll'), client(false));
  const before = fs.readdirSync(folder).map(name => [name, fs.statSync(path.join(folder, name)).mtimeMs]);
  const registered = await act(ClientFiles, userDataDir, 'registerCustom', { runtimePath: folder });
  assert.deepEqual(registered.clients, { x86_64: 'SteamClient64.dll', i386: 'steamclient.dll' });
  assert.deepEqual(fs.readdirSync(folder).map(name => [name, fs.statSync(path.join(folder, name)).mtimeMs]), before, 'Valve files are not changed');
  const settings = { runtimes: { [ClientFiles.id]: ClientFiles.applySettingsUpdate('setDefault', { sectionId: 'default', version: folder }, {}) } };
  const selected = ClientFiles.resolveSelection(null, settings, userDataDir, { verification: 'status' });
  assert.equal(selected.ready, true);
  assert.equal(selected.install.root, folder);
  t.mock.method(Components, 'install', () => assert.fail('A usable registered client folder must not download another copy'));
  const uses = [], reused = await ClientFiles.ensure({ userDataDir, settings, recordRuntimeUse: identity => uses.push(identity) });
  assert.equal(reused.root, folder);
  assert.ok(uses.some(identity => identity.managerId === ClientFiles.id && identity.version === folder && identity.sourcePath === folder));
  const swapped = path.join(root, 'swapped');
  fs.mkdirSync(swapped); fs.writeFileSync(path.join(swapped, 'steamclient64.dll'), client(false)); fs.writeFileSync(path.join(swapped, 'steamclient.dll'), client(false));
  await assert.rejects(act(ClientFiles, userDataDir, 'registerCustom', { runtimePath: swapped }), /steamclient64\.dll is not the 64-bit Windows Steam client/);
  fs.rmSync(path.join(swapped, 'steamclient.dll'));
  fs.writeFileSync(path.join(swapped, 'steamclient64.dll'), client(true));
  await assert.rejects(act(ClientFiles, userDataDir, 'registerCustom', { runtimePath: swapped }), /steamclient\.dll is missing/);
});

// A bridge package folder in the published format: the package record and
// its files, as the Builds archive unpacks.
function bridgeFolder(root) {
  const folder = path.join(root, 'bridge'), payload = path.join(folder, 'files'), names = { 'x86_64-unix/lsteamclient.so': 'native x86_64', 'aarch64-unix/lsteamclient.so': 'native arm64',
    'i386-windows/lsteamclient.dll': 'builtin i386', 'x86_64-windows/lsteamclient.dll': 'builtin x86_64', 'i386-windows/mlsteam-bootstrap.dll': 'bootstrap i386',
    'x86_64-windows/mlsteam-bootstrap.dll': 'bootstrap x86_64', 'i386-windows/steam.exe': 'helper i386', 'steam.exe': 'helper x86_64' };
  const files = Object.entries(names).map(([relative, text]) => {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fs.chmodSync(file, 0o755);
    return { path: relative, mode: 0o755, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) };
  });
  const manifest = Buffer.from(JSON.stringify({ steamBridge: { clientEnvironment: { i386: 'MACLAUNCHER_STEAM_CLIENT32', x86_64: 'MACLAUNCHER_STEAM_CLIENT64' },
    native: { x86_64: 'x86_64-unix/lsteamclient.so', aarch64: 'aarch64-unix/lsteamclient.so' },
    windows: { i386: { builtin: 'i386-windows/lsteamclient.dll', bootstrap: 'i386-windows/mlsteam-bootstrap.dll', helper: 'i386-windows/steam.exe' },
      x86_64: { builtin: 'x86_64-windows/lsteamclient.dll', bootstrap: 'x86_64-windows/mlsteam-bootstrap.dll', helper: 'steam.exe' } } },
  schemaVersion: 1, managerId: 'maclauncher-steam-bridge', version: '7.0.0', platform: 'darwin', arch: 'universal', minimumMacOS: '13.0', executableRelative: 'steam.exe', files, dependencies: [] }));
  fs.writeFileSync(path.join(payload, 'manifest.json'), manifest); fs.chmodSync(path.join(payload, 'manifest.json'), 0o644);
  fs.writeFileSync(path.join(folder, 'runtime-package.json'), JSON.stringify({ id: 'maclauncher-steam-bridge', version: '7.0.0', arch: 'universal',
    launcherArchitectures: ['arm64', 'x64'], minimumMacOS: '13.0', sourceRelative: null, sourceSha256: sha(Buffer.from('source')),
    directoryRelative: 'maclauncher-steam-bridge/7.0.0/universal', manifestRelative: 'manifest.json', manifestSha256: sha(manifest),
    files: [...files, { path: 'manifest.json', mode: 0o644, size: manifest.length, sha256: sha(manifest) }] }));
  return folder;
}

test('a complete bridge package folder is a custom bridge, and with usable client files Play asks nothing', async t => {
  const root = scratch(t), userDataDir = path.join(root, 'data');
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '480' }), discoverClient: () => '/Applications/Steam.app/Contents/MacOS', isRunning: () => true,
    dependencies: { systemVersionSync: () => '26.0' } });
  Custom.instrumentManagers([bridge, ClientFiles]);
  const folder = bridgeFolder(root);
  const registered = await act(bridge, userDataDir, 'registerCustom', { runtimePath: folder });
  assert.equal(registered.version, folder);
  assert.equal(registered.manifest.steamBridge.clientEnvironment.x86_64, 'MACLAUNCHER_STEAM_CLIENT64');
  const clients = path.join(root, 'clients');
  fs.mkdirSync(clients); fs.writeFileSync(path.join(clients, 'steamclient64.dll'), client(true)); fs.writeFileSync(path.join(clients, 'steamclient.dll'), client(false));
  await act(ClientFiles, userDataDir, 'registerCustom', { runtimePath: clients });
  const settings = { runtimes: {
    'maclauncher-steam-bridge': bridge.applySettingsUpdate('setDefault', { sectionId: 'default', version: folder }, {}),
    [ClientFiles.id]: ClientFiles.applySettingsUpdate('setDefault', { sectionId: 'default', version: clients }, {}) } };
  assert.deepEqual(await bridge.requirements({ name: 'Fixture' }, { userDataDir, settings }), [], 'usable local versions need no download consent');
  // Registered folders are usable versions, so they serve Play without a saved default too.
  assert.deepEqual(await bridge.requirements({ name: 'Fixture' }, { userDataDir, settings: {} }), [], 'registered folders serve Play without defaults');
  assert.equal((await bridge.requirements({ name: 'Fixture' }, { userDataDir: path.join(root, 'empty'), settings: {} })).length, 1,
    'without a usable version Play offers the download');
  // With usable client files and no bridge, the question names only the bridge.
  const clientsOnly = path.join(root, 'clients-only');
  await act(ClientFiles, clientsOnly, 'registerCustom', { runtimePath: clients });
  const [offer] = await bridge.requirements({ name: 'Fixture' }, { userDataDir: clientsOnly, settings: {} });
  assert.match(offer.detail, /Downloads the Steam client bridge[,.]/);
  assert.doesNotMatch(offer.detail, /client files from Valve/);
  // A part missing from the folder makes it incomplete.
  fs.rmSync(path.join(folder, 'files/i386-windows/mlsteam-bootstrap.dll'));
  await assert.rejects(act(bridge, userDataDir, 'registerCustom', { runtimePath: folder }), /missing i386-windows\/mlsteam-bootstrap\.dll/);
});
