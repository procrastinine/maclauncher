const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Plugins = require('../src/modules/video/plugins');
const Sources = require('../src/modules/video/plugin-sources');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const UOSC_OLD = { version: '5.13.0', revision: 'd124c2c930d69446448022851373e00ae592390d' };
const THUMBFAST_OLD = '0f711de3138c9bd6718209d819ac54022c23ded2';
const revisions = { '5.15.0': 'c'.repeat(40), '5.14.0': 'b'.repeat(40), '5.13.0': UOSC_OLD.revision };

// The smallest Intel macOS executable the uosc helper check accepts: a 64-bit
// header and one LC_BUILD_VERSION command for macOS 11, with no libraries.
function intelHelper() {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(0xfeedfacf, 0); data.writeUInt32LE(0x01000007, 4); data.writeUInt32LE(3, 8); data.writeUInt32LE(2, 12);
  data.writeUInt32LE(1, 16); data.writeUInt32LE(24, 20);
  data.writeUInt32LE(0x32, 32); data.writeUInt32LE(24, 36); data.writeUInt32LE(1, 40); data.writeUInt32LE(11 << 16, 44); data.writeUInt32LE(11 << 16, 48);
  return data;
}
function uoscRelease(tag, { conf = true, archive = Buffer.from(`uosc ${tag} archive`), digest = true } = {}) {
  const base = `https://github.com/tomasklaen/uosc/releases/download/${tag}`;
  return { tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', archive,
    assets: [{ name: 'uosc.zip', browser_download_url: `${base}/uosc.zip`, size: archive.length, ...(digest ? { digest: `sha256:${sha256(archive)}` } : {}) },
      ...(conf ? [{ name: 'uosc.conf', browser_download_url: `${base}/uosc.conf`, size: Buffer.byteLength(`conf ${tag}`) }] : [])] };
}
// Network routes. Every request is recorded so offline paths can assert none.
const API = 'https://api.github.com/repos/', THUMBFAST = 'e'.repeat(40);
function fixture(t, releases = [uoscRelease('5.15.0', { conf: false }), uoscRelease('5.14.0'), uoscRelease('5.13.0', { digest: false })]) {
  const routes = { [`${API}tomasklaen/uosc/releases`]: releases.map(({ archive, ...release }) => release),
    [`${API}tomasklaen/uosc/tags`]: Object.entries(revisions).map(([name, sha]) => ({ name, commit: { sha } })),
    // uosc names its notice LICENSE.LGPL, which GitHub's license lookup finds.
    [`${API}tomasklaen/uosc/license`]: { encoding: 'base64', content: Buffer.from('uosc license').toString('base64'),
      download_url: 'https://raw.githubusercontent.com/tomasklaen/uosc/main/LICENSE.LGPL' },
    [`${API}po5/thumbfast/commits`]: [{ sha: THUMBFAST, commit: { committer: { date: '2026-10-28T23:30:00Z' } } }],
    [`https://raw.githubusercontent.com/po5/thumbfast/${THUMBFAST}/thumbfast.lua`]: 'thumbfast script',
    [`https://raw.githubusercontent.com/po5/thumbfast/${THUMBFAST}/LICENSE`]: 'thumbfast license' };
  for (const release of releases) {
    routes[release.assets[0].browser_download_url] = release.archive;
    routes[`https://github.com/tomasklaen/uosc/releases/download/${release.tag_name}/uosc.conf`] = `conf ${release.tag_name}`;
  }
  Harness.network.routes = routes;
  t.after(() => { Harness.network.routes = null; });
  const start = Harness.network.requests.length, requests = () => Harness.network.requests.slice(start);
  const dependencies = {
    execute: async (command, [, , , destination]) => {
      assert.equal(command, '/usr/bin/ditto');
      const files = { 'scripts/uosc/main.lua': 'uosc', 'scripts/uosc/bin/ziggy-darwin': intelHelper(), 'scripts/uosc/bin/ziggy-linux': 'elf',
        'scripts/uosc/bin/ziggy-windows.exe': 'pe', 'fonts/uosc_icons.otf': 'font' };
      for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
        fs.writeFileSync(path.join(destination, relative), content);
      }
    },
    ensureForExecutable: async () => {}, removeManagedRuntimeQuarantine: async () => {}
  };
  return { dependencies, routes, requests, downloads: () => requests().filter(url => !url.startsWith(API) &&
    !url.startsWith('https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/')) };
}
function offline() {
  const fail = async () => { throw new Error('Offline use ran a tool.'); };
  return { execute: fail, ensureForExecutable: async () => {}, removeManagedRuntimeQuarantine: async () => {} };
}
function temporary(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-plugins-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  return userDataDir;
}
// Installations and receipts written by launchers that installed only the
// former fixed uosc release and thumbfast revision.
function legacyInstall(userDataDir, id, version, upstreamRevision, files) {
  const directory = path.join(userDataDir, 'runtimes', 'mpv-plugins', id, version), inventory = [];
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative), executable = relative.endsWith('ziggy-darwin');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); if (executable) fs.chmodSync(file, 0o755);
    inventory.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha256(content), executable });
  }
  const assets = id === 'uosc'
    ? [{ filename: 'uosc.zip', url: 'https://github.com/tomasklaen/uosc/releases/download/5.13.0/uosc.zip', sha256: '4be9da3289285300fa374496c3f1bfd7bb20ac08e890d25bd5a06b28eebe4882', bytes: 8163987 }]
    : [{ filename: 'thumbfast.lua', url: `https://raw.githubusercontent.com/po5/thumbfast/${THUMBFAST_OLD}/thumbfast.lua`, sha256: 'a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf', bytes: 32495 }];
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ schema: 1, id, version, upstreamRevision, assets,
    installedAt: '2026-07-01T00:00:00.000Z', files: inventory.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2));
  return directory;
}
function legacyUosc(userDataDir) {
  return legacyInstall(userDataDir, 'uosc', UOSC_OLD.version, UOSC_OLD.revision, { 'scripts/uosc/main.lua': 'uosc 5.13', 'scripts/uosc/bin/ziggy-darwin': intelHelper(),
    'fonts/uosc_icons.otf': 'font', 'script-opts/uosc.conf': 'conf', 'LICENSE.LGPL': 'license' });
}
const section = (manager, userDataDir, id) => manager.getState({ userDataDir }).sections.find(item => item.id === id);

test('first uosc Install with an empty catalog discovers releases and installs the newest compatible one', async t => {
  const userDataDir = temporary(t), { dependencies, requests, downloads } = fixture(t), manager = Plugins.createManager(dependencies);
  const before = section(manager, userDataDir, 'uosc');
  assert.equal(before.plugin.version, null);
  assert.deepEqual(before.catalog.versions, []);
  assert.equal(before.catalog.installable, true);
  assert.deepEqual(requests(), []);

  // The Install action is the consent; discovery runs inside it and installation resumes.
  const result = await manager.installRuntime({ sectionId: 'uosc', version: '', userDataDir });
  assert.equal(result.version, '5.14.0');
  assert.equal(result.upstreamRevision, revisions['5.14.0']);
  assert.ok(requests().some(url => url.startsWith(`${API}tomasklaen/uosc/releases`)));
  assert.deepEqual(downloads(), ['https://github.com/tomasklaen/uosc/releases/download/5.14.0/uosc.zip',
    'https://github.com/tomasklaen/uosc/releases/download/5.14.0/uosc.conf',
    `https://raw.githubusercontent.com/tomasklaen/uosc/${revisions['5.14.0']}/LICENSE`]);
  const receipt = JSON.parse(fs.readFileSync(path.join(result.installDir, 'plugin.json'), 'utf8'));
  assert.deepEqual(receipt.assets.map(asset => [asset.filename, asset.sha256]), [
    ['uosc.zip', sha256('uosc 5.14.0 archive')], ['script-opts/uosc.conf', sha256('conf 5.14.0')], ['LICENSE', sha256('uosc license')]]);
  assert.equal(fs.readFileSync(path.join(result.installDir, 'LICENSE'), 'utf8'), 'uosc license');
  assert.equal(fs.existsSync(path.join(result.installDir, 'scripts/uosc/bin/ziggy-linux')), false);

  const after = section(manager, userDataDir, 'uosc');
  assert.deepEqual(after.catalog.versions, ['5.14.0', '5.13.0'], 'a release without uosc.conf is not listed');
  assert.equal(after.plugin.version, '5.14.0');
  assert.equal(after.plugin.updateAvailable, false);
  assert.equal(after.installed[0].ready, true);
  assert.equal(Plugins.status(userDataDir, 'uosc').version, '5.14.0');

  const added = await Sources.resolveKnownSource(Sources.UOSC_SOURCE);
  assert.equal(added.versionLabel, '5.14.0');
  assert.equal(added.archive, true);
  assert.equal(added.sha256, sha256('uosc 5.14.0 archive'));
  assert.deepEqual(added.extraAssets.map(asset => asset.relative), ['script-opts/uosc.conf']);
  assert.equal(added.licenseRepository, 'tomasklaen/uosc');
  assert.equal(Plugins.manager.upstream.length, 2);
});

test('uosc downloads that differ from the published release digest are rejected', async t => {
  const userDataDir = temporary(t), { dependencies, routes } = fixture(t, [uoscRelease('5.14.0')]);
  routes['https://github.com/tomasklaen/uosc/releases/download/5.14.0/uosc.zip'] = Buffer.from('uosc 5.14.0 archivX');
  const manager = Plugins.createManager(dependencies);
  await assert.rejects(manager.installRuntime({ sectionId: 'uosc', userDataDir }), /checksum/);
  assert.equal(Plugins.status(userDataDir, 'uosc'), null);
});

test('uosc installation stages a native managed helper and its notices before recording plugin integrity', {skip: process.platform !== 'darwin'}, async t => {
  const {dependencies, routes} = fixture(t, [uoscRelease('5.14.0'), uoscRelease('5.13.0', {digest: false})]);
  const Helper = require('../src/modules/video/runtime/uosc-helper-manager');
  const {nativeTool, packageFor} = require('./helpers/managed-tool-fixture.cjs');
  const Native = require('../src/modules/shared/runtime/local-native');
  const userDataDir = temporary(t);
  const helpers = ['arm64', 'x64'].map(architecture => {
    const binary = nativeTool(path.join(userDataDir, 'fixture-native-' + architecture), '', {architecture}).binary;
    const helper = packageFor(path.join(userDataDir, 'fixture-package-' + architecture), {id: 'uosc-helper', version: '5.13.0-MCLv1', architecture,
      filesPrefix: 'files/', manifest: {managerId: 'uosc-helper', platform: 'darwin', upstreamRevision: UOSC_OLD.revision,
        executableRelative: 'bin/ziggy-darwin', provenance: {sourceRevision: UOSC_OLD.revision}, dependencies: []},
      entries: [{path: 'bin/ziggy-darwin', bytes: binary, mode: 0o755, architectures: [architecture === 'x64' ? 'x86_64' : 'arm64']},
        {path: 'licenses/helper.txt', bytes: Buffer.from('helper license'), mode: 0o644}]});
    helper.record.source = {repository: 'tomasklaen/uosc', revision: UOSC_OLD.revision};
    return helper;
  });
  const helper = helpers.find(item => item.record.arch === process.arch);
  routes['https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/uosc-helper.json'] = {...helper.catalog, packages: helpers.map(item => item.record)};
  for (const selected of helpers) routes[selected.record.asset.url] = fs.readFileSync(selected.archive);
  const helperManager = Helper;
  const cpuChecks = [];
  const manager = Plugins.createManager({...dependencies,
    execute: async (...args) => {
      await dependencies.execute(...args);
      fs.unlinkSync(path.join(args[1][3], 'scripts/uosc/bin/ziggy-darwin'));
    },
    ensureForExecutable: async file => cpuChecks.push(Native.readMachOArchitectures(file))});
  const warnings = [];
  const installed = await manager.installRuntime({sectionId: 'uosc', userDataDir, logger: {warn: message => warnings.push(message)}});
  assert.deepEqual(cpuChecks, [[process.arch === 'x64' ? 'x86_64' : 'arm64']], warnings.join('\n'));
  const receipt = JSON.parse(fs.readFileSync(path.join(installed.installDir, 'plugin.json')));
  assert.equal(receipt.nativeHelper.version, helper.record.version);
  assert.equal(fs.readFileSync(path.join(installed.installDir, 'licenses/uosc-helper/helper.txt'), 'utf8'), 'helper license');
  assert.ok(receipt.files.some(file => file.path === 'licenses/uosc-helper/helper.txt'));
  await helperManager.refreshCatalog({userDataDir, force: true});
  const state = helperManager.getState({userDataDir});
  assert.equal(state.defaultVersion, helper.record.version, 'Shared native preference wins over newer upstream helper metadata with unknown CPU');
  assert.ok(state.catalog.sources.find(source => source.id === 'upstream').versions.includes('5.14.0'));
  assert.ok(state.catalog.architectureCatalogs[process.arch === 'arm64' ? 'x64' : 'arm64'].versions.includes(helper.record.version));
  const saved = {runtimes: {'uosc-helper': {defaultVersion: '5.14.0'}}};
  // A saved default that is not installed yields to the installed helper.
  const preferred = helperManager.resolveSelection({}, saved, userDataDir);
  assert.deepEqual([preferred.version, preferred.ready, preferred.preferredVersion], [helper.record.version, true, '5.14.0']);
  const requests = Harness.network.requests.length;
  assert.equal(Plugins.createManager(offline()).getState({userDataDir}).sections.find(section => section.id === 'uosc').installed[0].ready, true);
  assert.equal(Harness.network.requests.length, requests);
});

test('optional uosc helper acquisition cancellation preserves the old plugin', async t => {
  const userDataDir = temporary(t), {dependencies} = fixture(t), old = legacyUosc(userDataDir);
  const canceled = Object.assign(new Error('Canceled native helper'), {name: 'AbortError', code: 'ABORT_ERR'});
  t.mock.method(require('../src/modules/video/runtime/uosc-helper-manager'), 'refreshCatalog', async () => {throw canceled;});
  const manager = Plugins.createManager(dependencies);
  await assert.rejects(manager.installRuntime({sectionId: 'uosc', version: '5.14.0', userDataDir}), {name: 'AbortError'});
  assert.equal(Plugins.status(userDataDir, 'uosc').installDir, old);
  assert.equal(fs.existsSync(path.join(userDataDir, 'runtimes/mpv-plugins/uosc/5.14.0')), false);
});

test('first thumbfast Install discovers the current commit and records commit-addressed downloads', async t => {
  const userDataDir = temporary(t), { dependencies, downloads } = fixture(t), manager = Plugins.createManager(dependencies);
  const result = await manager.installRuntime({ sectionId: 'thumbfast', userDataDir });
  const revision = THUMBFAST;
  assert.equal(result.version, revision);
  assert.equal(result.versionLabel, '2026-10-28 snapshot');
  assert.deepEqual(downloads(), [`https://raw.githubusercontent.com/po5/thumbfast/${revision}/thumbfast.lua`,
    `https://raw.githubusercontent.com/po5/thumbfast/${revision}/LICENSE`]);
  const receipt = JSON.parse(fs.readFileSync(path.join(result.installDir, 'plugin.json'), 'utf8'));
  assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256) && asset.url.includes(revision)));
  assert.equal(section(manager, userDataDir, 'thumbfast').plugin.versionLabel, '2026-10-28 snapshot');
});

test('uosc 5.13.0 and the former thumbfast revision stay usable offline with their original receipts', async t => {
  const userDataDir = temporary(t), manager = Plugins.createManager(offline()), before = Harness.network.requests.length;
  const uosc = legacyUosc(userDataDir);
  const thumbfast = legacyInstall(userDataDir, 'thumbfast', THUMBFAST_OLD, THUMBFAST_OLD, { 'thumbfast.lua': 'thumbfast', LICENSE: 'license' });
  // A catalog written before versions carried their downloads lists nothing.
  fs.writeFileSync(path.join(userDataDir, 'runtimes', 'mpv-plugins', 'catalog-uosc.json'), JSON.stringify({ schemaVersion: 1, managerId: 'mpv-plugins',
    sourceId: 'uosc', fetchedAt: 1, source: null, entries: [{ version: '5.13.0', upstreamRevision: UOSC_OLD.revision }] }));

  const status = Plugins.status(userDataDir, 'uosc', { verification: 'full' });
  assert.equal(status.version, '5.13.0');
  assert.equal(status.installDir, uosc);
  assert.equal(status.helperPath, path.join(uosc, 'scripts/uosc/bin/ziggy-darwin'));
  assert.equal(Plugins.playbackStatus(userDataDir, 'thumbfast').scriptPath, path.join(thumbfast, 'thumbfast.lua'));

  const state = section(manager, userDataDir, 'uosc');
  assert.deepEqual(state.catalog.versions, []);
  assert.equal(state.plugin.version, '5.13.0');
  assert.equal(state.installed[0].ready, true);
  assert.equal(section(manager, userDataDir, 'thumbfast').plugin.versionLabel, THUMBFAST_OLD.slice(0, 12));
  // Install with or without the version resolves to the existing installation.
  assert.equal((await manager.installRuntime({ sectionId: 'uosc', version: '5.13.0', userDataDir })).installDir, uosc);
  assert.equal((await manager.installRuntime({ sectionId: 'uosc', userDataDir })).installDir, uosc);
  assert.equal((await manager.installRuntime({ sectionId: 'thumbfast', userDataDir })).installDir, thumbfast);
  assert.equal(Harness.network.requests.length, before);
});

test('Update installs the newest uosc release and replaces the earlier copy after verification', async t => {
  const userDataDir = temporary(t), { dependencies } = fixture(t), manager = Plugins.createManager(dependencies);
  const previous = legacyUosc(userDataDir);
  const updated = await manager.updatePlugin({ id: 'uosc', userDataDir });
  assert.equal(updated.updated, true);
  assert.equal(updated.version, '5.14.0');
  assert.equal(fs.existsSync(previous), false);
  assert.equal(Plugins.status(userDataDir, 'uosc').version, '5.14.0');
  assert.equal((await manager.updatePlugin({ id: 'uosc', userDataDir })).updated, false);
});

test('a failed Refresh keeps the last plugin catalog', async t => {
  const userDataDir = temporary(t), { dependencies, routes } = fixture(t);
  await Plugins.createManager(dependencies).refreshCatalog({ userDataDir, sectionId: 'uosc' });
  routes[`${API}tomasklaen/uosc/releases`] = { status: 503, headers: {}, body: Buffer.alloc(0) };
  const failing = Plugins.createManager(dependencies);
  await assert.rejects(failing.refreshCatalog({ userDataDir, sectionId: 'uosc' }), /503/);
  const state = section(failing, userDataDir, 'uosc');
  assert.deepEqual(state.catalog.versions, ['5.14.0', '5.13.0']);
  assert.equal(state.catalog.status, 'error');
  assert.equal(state.plugin.version, '5.14.0');
});
