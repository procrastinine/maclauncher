// The offline GitHub harness replaces the network functions before any
// MacLauncher module loads.
const { network, githubRoutes } = require('./helpers/future-upstream.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const Update = require('../src/main/app-update');
const SemanticVersion = require('../src/core/semantic-version');

const REPO = Update.REPOSITORY;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
let nextId = 1;

function plist(version, identifier = 'com.maclauncher.launcher') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MacLauncher</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`;
}
// A minimal app: Info.plist and a real Mach-O executable (Apple's universal
// /usr/bin/true), signed ad hoc like the published apps.
function fakeApp(dir, version, { identifier, sign = true, tamper = false } = {}) {
  const app = path.join(dir, 'MacLauncher.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS/MacLauncher'));
  fs.chmodSync(path.join(app, 'Contents/MacOS/MacLauncher'), 0o755);
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plist(version, identifier));
  fs.writeFileSync(path.join(app, 'Contents/Resources/version.txt'), version);
  if (sign) execFileSync('/usr/bin/codesign', ['--force', '-s', '-', app], { stdio: 'pipe' });
  if (tamper) fs.appendFileSync(path.join(app, 'Contents/Info.plist'), '\n');
  return app;
}
function zipApp(dir, version, options) {
  const source = fs.mkdtempSync(path.join(dir, 'zip-source-'));
  const app = fakeApp(source, version, options), archive = path.join(source, 'app.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  const bytes = fs.readFileSync(archive);
  fs.rmSync(source, { recursive: true, force: true });
  return bytes;
}
function installedApp(dir, version = '0.5.1') {
  const folder = path.join(dir, 'Applications');
  fs.mkdirSync(folder, { recursive: true });
  return fakeApp(folder, version, { sign: false });
}

// A GitHub release in API form whose assets carry their real sizes and the
// SHA-256 digests GitHub publishes.
function release(tag, assets, extra = {}) {
  return { id: nextId++, tag_name: tag, name: `MacLauncher ${tag}`, draft: false, prerelease: false,
    html_url: `https://github.com/${REPO}/releases/tag/${tag}`, published_at: '2026-11-01T00:00:00Z',
    assets: Object.entries(assets).map(([name, body]) => ({ id: nextId++, name, size: Buffer.byteLength(body), content_type: 'application/octet-stream',
      digest: `sha256:${sha256(Buffer.from(body))}`, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}` })), ...extra };
}
function manifest(version, arch, appArchive, archive, extra = {}) {
  return JSON.stringify({ schemaVersion: 1, product: 'MacLauncher', version, releaseTag: `v${version}`, arch, appArchive,
    appArchiveSha256: sha256(archive), launcherMinimumMacOS: '13.0', signing: 'Ad hoc signed', ...extra });
}
// The published set for one version: each CPU's archive and build manifest.
function published(version, archives, manifests = {}) {
  const names = { arm64: 'MacLauncher.app.zip', x64: 'MacLauncher-Intel.app.zip' }, assets = {};
  for (const [arch, bytes] of Object.entries(archives)) {
    assets[names[arch]] = bytes;
    assets[`MacLauncher-${arch}.build-manifest.json`] = manifest(version, arch, names[arch], bytes, manifests[arch]);
  }
  return assets;
}
function serve(releases) {
  const routes = githubRoutes(REPO, releases);
  for (const item of releases) for (const asset of item.assets) routes[asset.browser_download_url] = item.__bodies[asset.name];
  network.routes = routes; network.requests.length = 0;
  return routes;
}
function withBodies(item, assets) { return Object.defineProperty(item, '__bodies', { value: Object.fromEntries(Object.entries(assets).map(([name, body]) => [name, Buffer.from(body)])) }); }
function standardReleases(archives) {
  const current = published('0.5.1', { arm64: 'old-arm', x64: 'old-intel' });
  const next = published('0.5.2', archives);
  return [
    withBodies(release('v0.9.0', next, { draft: true }), next),
    withBodies(release('v0.6.0-beta.1', next, { prerelease: true }), next),
    withBodies(release('v0.7.0-rc.1', next), next),
    withBodies(release('nightly', next), next),
    withBodies(release('v0.5.2', next), next),
    withBodies(release('v0.5.1', current), current)
  ];
}
function updater(t, options = {}) {
  const shown = [], opened = [], trashed = [], quits = [];
  const dir = options.dir || temporary(t);
  const respond = options.respond || (() => 0);
  const value = Update.createAppUpdater({ userDataDir: path.join(dir, 'profile'), currentVersion: '0.5.1', packaged: true,
    appPath: options.appPath ?? installedApp(dir), arch: 'arm64', macOSVersion: () => '15.0', launchDelayMs: 0, logger: { info() {}, warn() {}, error() {} },
    showMessage: async (_owner, box) => { shown.push(box); return { response: respond(box) }; },
    openExternal: async url => { opened.push(url); }, trashItem: async target => { trashed.push(target); fs.rmSync(target, { recursive: true, force: true }); },
    quit: () => quits.push(true), ...options });
  return Object.assign(value, { shown, opened, trashed, quits, dir });
}
const button = label => box => Math.max(0, box.buttons.indexOf(label));

test('release tags compare as semantic versions and prereleases are never updates', () => {
  assert.equal(Update.releaseVersion('v0.5.1'), '0.5.1');
  assert.equal(Update.releaseVersion('0.5.10'), '0.5.10');
  for (const tag of ['v0.6.0-beta.1', 'nightly', 'v1.2', 'v01.2.3', '', null]) assert.equal(Update.releaseVersion(tag), null);
  assert.equal(Update.isNewer('0.5.10', '0.5.9'), true);
  assert.equal(Update.isNewer('0.6.0', '0.6.0-beta.2'), true);
  assert.equal(Update.isNewer('1.0.0', '0.99.99'), true);
  assert.equal(Update.isNewer('0.5.1', '0.5.1'), false);
  assert.equal(Update.isNewer('0.5.1+rebuild', '0.5.1'), false);
  assert.equal(Update.isNewer('0.5.0', '0.5.1'), false);
  assert.equal(Update.isNewer('0.5.2', 'not-a-version'), false);
  // Release tags are v<version>; a bare or malformed tag is not a release.
  assert.deepEqual(Update.recognizeRelease({ tag_name: 'v0.5.2', assets: [] }), [{ version: '0.5.2', assets: [] }]);
  for (const tag of ['0.5.2', 'release-0.5.2', 'v0.5', undefined]) assert.deepEqual(Update.recognizeRelease({ tag_name: tag, assets: [] }), []);
  // The release script orders package versions with the same implementation.
  const Release = require('../scripts/release.cjs');
  assert.equal(Release.compareVersions('0.3.0', '0.3.0-rc.1'), SemanticVersion.compare('0.3.0', '0.3.0-rc.1'));
});

test('a check offers the newest stable release and each CPU gets its own archive, including the Intel app under Rosetta', async t => {
  const arm = Buffer.from('arm64 app archive'), intel = Buffer.from('intel app archive');
  serve(standardReleases({ arm64: arm, x64: intel }));
  for (const [arch, name, bytes] of [['arm64', 'MacLauncher.app.zip', arm], ['x64', 'MacLauncher-Intel.app.zip', intel]]) {
    const result = await updater(t, { arch }).check();
    assert.equal(result.outcome, 'available');
    assert.equal(result.version, '0.5.2', 'drafts, prereleases and non-version tags are ignored');
    assert.equal(result.releaseUrl, `https://github.com/${REPO}/releases/tag/v0.5.2`);
    assert.equal(result.download.name, name);
    assert.equal(result.download.sha256, sha256(bytes));
    assert.equal(result.download.manifest, `MacLauncher-${arch}.build-manifest.json`);
    assert.equal(result.reason, null);
  }
  // An Intel build running through Rosetta reports x64 and must not be offered the Apple Silicon app.
  const original = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'arch', { ...original, value: 'x64' });
  try {
    const dir = temporary(t);
    const rosetta = Update.createAppUpdater({ userDataDir: path.join(dir, 'profile'), currentVersion: '0.5.1', packaged: true,
      appPath: installedApp(dir), macOSVersion: () => '15.0', logger: { warn() {} } });
    const result = await rosetta.check();
    assert.equal(result.download.name, 'MacLauncher-Intel.app.zip');
  } finally { Object.defineProperty(process, 'arch', original); }
  assert.ok(!network.requests.some(url => /\.app\.zip$/.test(url)), 'checking downloads no app archive');
});

test('the current release is up to date and the native dialog says so', async t => {
  const current = published('0.5.1', { arm64: 'a', x64: 'b' });
  serve([withBodies(release('v0.5.1', current), current)]);
  const update = updater(t);
  await update.choose();
  assert.equal(update.shown.length, 1);
  assert.equal(update.shown[0].message, 'MacLauncher is up to date.');
  assert.match(update.shown[0].detail, /0\.5\.1 is the latest version/);
  assert.equal(update.snapshot().lastCheck.outcome, 'current');
  // A check result is kept for Settings after a restart.
  const again = Update.createAppUpdater({ userDataDir: path.join(update.dir, 'profile'), currentVersion: '0.5.1', packaged: true, appPath: null });
  assert.equal(again.snapshot().lastCheck.outcome, 'current');
  // After an update, a result recorded by the previous version is not shown.
  const updated = Update.createAppUpdater({ userDataDir: path.join(update.dir, 'profile'), currentVersion: '0.5.2', packaged: true, appPath: null });
  assert.equal(updated.snapshot().lastCheck, null);
});

test('a failed check names the reason', async t => {
  network.routes = { [`https://api.github.com/repos/${REPO}/releases`]: { status: 500, headers: {}, body: Buffer.from('{}') } };
  const update = updater(t);
  await update.choose();
  assert.equal(update.shown[0].message, 'MacLauncher could not check for updates.');
  assert.match(update.shown[0].detail, /GitHub (?:releases|tags) fetch failed \((?:500|404)\)/);
  assert.equal(update.snapshot().lastCheck.outcome, 'error');
  assert.equal(update.snapshot().phase, 'idle');
});

test('the archive comes from the build manifest for this CPU and a release without a usable one is not installed in place', async () => {
  const listed = (name, body, digest = true) => ({ name, url: `https://github.com/${REPO}/releases/download/v0.5.2/${name}`, bytes: Buffer.byteLength(body),
    ...(digest ? { digest: { algorithm: 'sha256', value: sha256(Buffer.from(body)) } } : {}) });
  const archives = [listed('MacLauncher.app.zip', 'arm'), listed('MacLauncher-Intel.app.zip', 'intel')];
  const manifests = { 'MacLauncher-arm64.build-manifest.json': JSON.parse(manifest('0.5.2', 'arm64', 'MacLauncher.app.zip', 'arm')),
    'MacLauncher-x64.build-manifest.json': JSON.parse(manifest('0.5.2', 'x64', 'MacLauncher-Intel.app.zip', 'intel')) };
  const row = (files, overrides = {}) => ({ version: '0.5.2', files, ...overrides });
  const read = edit => async file => { const value = manifests[file.name]; return value ? { ...value, ...edit?.(value) } : null; };
  const all = [...archives, listed('MacLauncher-arm64.build-manifest.json', '{}'), listed('MacLauncher-x64.build-manifest.json', '{}')];
  const choose = (files, options = {}) => Update.chooseDownload(row(files), { arch: 'arm64', macOSVersion: '15.0', readManifest: read(), ...options });

  assert.equal((await choose(all)).download.name, 'MacLauncher.app.zip');
  assert.equal((await choose(all, { arch: 'x64' })).download.name, 'MacLauncher-Intel.app.zip');
  // A manifest that names another CPU or version is not used.
  assert.match((await choose(all, { readManifest: read(() => ({ arch: 'x64' })) })).reason, /no Apple Silicon app with a published SHA-256/);
  assert.match((await choose(all, { readManifest: read(() => ({ version: '0.5.3' })) })).reason, /no Apple Silicon app/);
  // GitHub's digest and the manifest must agree.
  assert.match((await choose(all, { readManifest: read(() => ({ appArchiveSha256: 'f'.repeat(64) })) })).reason, /differs from the one in its build manifest/);
  // A release that needs a newer macOS is not offered as a download.
  assert.match((await choose(all, { readManifest: read(() => ({ launcherMinimumMacOS: '26.0' })) })).reason, /requires macOS 26\.0 or later/);
  // Without a manifest, an archive named for this CPU with GitHub's SHA-256 is used.
  const named = [listed('MacLauncher-1.0-arm64.app.zip', 'named'), listed('MacLauncher-1.0-x64.app.zip', 'other')];
  assert.equal((await choose(named)).download.name, 'MacLauncher-1.0-arm64.app.zip');
  assert.equal((await choose(named, { arch: 'x64' })).download.name, 'MacLauncher-1.0-x64.app.zip');
  assert.match((await choose([listed('MacLauncher-1.0-x64.app.zip', 'x')])).reason, /no Apple Silicon app/);
  assert.match((await choose([listed('MacLauncher-1.0-arm64.app.zip', 'x', false)])).reason, /published SHA-256/);
});

test('this copy installs in place only when it is packaged, not translocated and its folder is writable', t => {
  const dir = temporary(t), app = installedApp(dir);
  assert.equal(Update.installBlocker({ packaged: true, appPath: app }), null);
  assert.match(Update.installBlocker({ packaged: false, appPath: app }), /source folder/);
  assert.match(Update.installBlocker({ packaged: true, appPath: null }), /could not be located/);
  assert.match(Update.installBlocker({ packaged: true, appPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/MacLauncher.app' }), /App Translocation/);
  assert.match(Update.installBlocker({ packaged: true, appPath: app, access: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }),
    new RegExp(`cannot write to ${path.dirname(app).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

for (const [label, options] of [['running from source', { packaged: false }],
  ['translocated', { appPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/MacLauncher.app' }],
  ['in an unwritable folder', { access: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }]]) {
  test(`a copy ${label} is offered the release page instead of a download`, async t => {
    serve(standardReleases({ arm64: Buffer.from('arm'), x64: Buffer.from('intel') }));
    const update = updater(t, { ...options, respond: button('Open Release Page') });
    await update.choose();
    const box = update.shown[0];
    assert.equal(box.message, 'MacLauncher 0.5.2 is available (current 0.5.1).');
    assert.deepEqual(box.buttons, ['Open Release Page', 'Later']);
    assert.equal(box.cancelId, 1);
    assert.deepEqual(update.opened, [`https://github.com/${REPO}/releases/tag/v0.5.2`]);
    assert.ok(!network.requests.some(url => /\.app\.zip$|build-manifest/.test(url)), 'nothing is downloaded');
    assert.equal(update.snapshot().phase, 'idle');
  });
}

async function downloadScenario(t, archive, { manifests, digest = true, respond = button('Later'), ...options } = {}) {
  const next = published('0.5.2', { arm64: archive, x64: 'intel' }, manifests);
  const item = withBodies(release('v0.5.2', next), next);
  if (!digest) for (const asset of item.assets) delete asset.digest;
  if (options.serve) options.serve(item);
  serve([item]);
  const update = updater(t, { respond: box => box.buttons.includes('Download and Restart') ? 0 : respond(box), ...options });
  await update.choose();
  return update;
}
function stages(update) {
  const folder = path.join(update.dir, 'Applications');
  return fs.readdirSync(folder).filter(name => name.startsWith(Update.STAGE_PREFIX));
}

test('a download whose SHA-256 differs from the published one is refused and nothing beside the app changes', async t => {
  const good = zipApp(temporary(t), '0.5.2');
  // GitHub lists no digest; the build manifest's SHA-256 is for other bytes.
  const update = await downloadScenario(t, good, { digest: false, manifests: { arm64: { appArchiveSha256: 'a'.repeat(64) } } });
  const failure = update.shown.at(-1);
  assert.equal(failure.message, 'MacLauncher 0.5.2 could not be installed.');
  assert.match(failure.detail, /does not match the SHA-256 published for MacLauncher 0\.5\.2 \(Apple Silicon\)/);
  assert.match(failure.detail, /The installed app was not changed/);
  assert.deepEqual(stages(update), []);
  assert.equal(fs.readFileSync(path.join(update.dir, 'Applications/MacLauncher.app/Contents/Resources/version.txt'), 'utf8'), '0.5.1');
  assert.ok(!fs.existsSync(path.join(update.dir, 'profile/updates/staged.json')));
  assert.deepEqual(fs.readdirSync(path.join(update.dir, 'profile/updates/downloads')), [], 'the rejected archive is removed');
  assert.equal(update.snapshot().phase, 'idle');
  assert.match(update.snapshot().error, /does not match/);

  // Bytes replaced behind the same URL fail GitHub's published digest too.
  const swapped = await downloadScenario(t, good, { serve: item => {
    const name = 'MacLauncher.app.zip', bytes = Buffer.from(item.__bodies[name]); bytes[bytes.length - 1] ^= 1; item.__bodies[name] = bytes;
  } });
  assert.match(swapped.shown.at(-1).detail, /does not match the checksum its publisher lists/);
  assert.deepEqual(stages(swapped), []);
});

test('the extracted app must report the release version, the same bundle identifier and a valid signature', async t => {
  for (const [options, reason] of [[{ version: '0.5.3' }, /reports version 0\.5\.3 instead of 0\.5\.2/],
    [{ identifier: 'com.example.other' }, /bundle identifier differs from com\.maclauncher\.launcher/],
    [{ tamper: true }, /code signature is not valid/]]) {
    const update = await downloadScenario(t, zipApp(temporary(t), options.version || '0.5.2', options));
    assert.match(update.shown.at(-1).detail, reason);
    assert.deepEqual(stages(update), [], 'a rejected app is removed from beside the installed app');
  }
  // An installed app whose identifier cannot be read gives nothing to compare, so the update is refused.
  const dir = temporary(t), appPath = fakeApp(path.join(dir, 'Applications'), '0.5.1', { identifier: '', sign: false });
  const unreadable = await downloadScenario(t, zipApp(temporary(t), '0.5.2'), { dir, appPath });
  assert.match(unreadable.shown.at(-1).detail, /installed app's bundle identifier could not be read/);
  assert.deepEqual(stages(unreadable), []);
});

test('a verified update stages beside the app and Restart to Update hands it to the helper', async t => {
  const update = await downloadScenario(t, zipApp(temporary(t), '0.5.2'), { respond: button('Later'), runningGames: () => 0 });
  const ready = update.shown.at(-1);
  assert.equal(ready.message, 'MacLauncher 0.5.2 is ready to install.');
  assert.deepEqual(ready.buttons, ['Restart to Update', 'Later']);
  const record = JSON.parse(fs.readFileSync(path.join(update.dir, 'profile/updates/staged.json'), 'utf8'));
  assert.equal(path.dirname(record.stage), path.join(update.dir, 'Applications'));
  assert.equal(fs.readFileSync(path.join(record.app, 'Contents/Resources/version.txt'), 'utf8'), '0.5.2');
  assert.equal(update.snapshot().phase, 'ready');
  assert.equal(update.snapshot().version, '0.5.2');
  assert.deepEqual(fs.readdirSync(path.join(update.dir, 'profile/updates/downloads')), [], 'the archive is removed after staging');

  // Running games keep the update waiting.
  const blocked = Update.createAppUpdater({ userDataDir: path.join(update.dir, 'profile'), currentVersion: '0.5.1', packaged: true,
    appPath: path.join(update.dir, 'Applications/MacLauncher.app'), runningGames: () => 2,
    showMessage: async (_owner, box) => { update.shown.push(box); return { response: 0 }; }, spawnProcess: () => assert.fail('no helper while games run') });
  assert.equal(await blocked.restart(), false);
  assert.match(update.shown.at(-1).detail, /2 running games use/);

  const spawned = [];
  const restarting = Update.createAppUpdater({ userDataDir: path.join(update.dir, 'profile'), currentVersion: '0.5.1', packaged: true,
    appPath: path.join(update.dir, 'Applications/MacLauncher.app'), quit: () => spawned.push('quit'), helper: { open: '/usr/bin/true', trash: '' },
    spawnProcess: (command, args, options) => { spawned.push({ command, args, options }); return { unref() {} }; } });
  assert.equal(restarting.snapshot().phase, 'ready', 'a staged update survives a restart of the launcher');
  assert.equal(await restarting.restart(), true);
  assert.equal(await restarting.restart(), true, 'a repeated Restart to Update only quits again');
  const [helper, quit, again] = spawned;
  assert.equal(quit, 'quit');
  assert.equal(again, 'quit');
  assert.equal(spawned.length, 3, 'one helper per launcher process');
  assert.equal(helper.command, '/bin/sh');
  assert.equal(helper.options.detached, true);
  assert.deepEqual(helper.args.slice(1), [String(process.pid), path.join(update.dir, 'Applications/MacLauncher.app'), record.app, record.stage, '/usr/bin/true', '']);
  assert.equal(fs.readFileSync(helper.args[0], 'utf8'), Update.HELPER_SCRIPT);
});

test('Restart to Update checks the waiting app again and discards one that changed since it was prepared', async t => {
  const update = await downloadScenario(t, zipApp(temporary(t), '0.5.2'), { respond: button('Later') });
  const record = JSON.parse(fs.readFileSync(path.join(update.dir, 'profile/updates/staged.json'), 'utf8'));
  fs.appendFileSync(path.join(record.app, 'Contents/Info.plist'), '\n');
  const shown = [], trashed = [];
  const restarting = Update.createAppUpdater({ userDataDir: path.join(update.dir, 'profile'), currentVersion: '0.5.1', packaged: true,
    appPath: path.join(update.dir, 'Applications/MacLauncher.app'), quit: () => assert.fail('no quit'), logger: { info() {}, warn() {} },
    showMessage: async (_owner, box) => { shown.push(box); return { response: 0 }; },
    trashItem: async target => { trashed.push(target); fs.rmSync(target, { recursive: true, force: true }); },
    spawnProcess: () => assert.fail('no helper for a changed app') });
  assert.equal(restarting.snapshot().phase, 'ready');
  assert.equal(await restarting.restart(), false);
  assert.match(shown.at(-1).detail, /code signature is not valid[\s\S]*Check for Updates downloads it again/);
  assert.deepEqual(trashed, [record.stage]);
  assert.ok(!fs.existsSync(path.join(update.dir, 'profile/updates/staged.json')));
  assert.equal(restarting.snapshot().phase, 'idle');
  assert.equal(fs.readFileSync(path.join(update.dir, 'Applications/MacLauncher.app/Contents/Resources/version.txt'), 'utf8'), '0.5.1');
});

// --- Helper script on a fake installation ----------------------------------------

function helperFixture(t) {
  const dir = temporary(t), app = installedApp(dir);
  const stage = fs.mkdtempSync(path.join(dir, 'Applications', Update.STAGE_PREFIX));
  const newApp = fakeApp(stage, '0.5.2', { sign: false });
  const tools = path.join(dir, 'tools'); fs.mkdirSync(tools);
  const open = path.join(tools, 'open'), trash = path.join(tools, 'trash');
  fs.writeFileSync(open, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$(dirname "$0")/opened.txt"\n', { mode: 0o755 });
  fs.writeFileSync(trash, '#!/bin/sh\nmkdir -p "$(dirname "$0")/trashed" && mv "$1" "$(dirname "$0")/trashed/"\n', { mode: 0o755 });
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.Trash'), { recursive: true });
  const exited = spawnSync('/usr/bin/true').pid;
  return { dir, app, stage, newApp, tools, open, trash, home, exited, opened: () => fs.readFileSync(path.join(tools, 'opened.txt'), 'utf8').trim().split('\n') };
}
function runHelper(fixture, overrides = {}) {
  const script = path.join(fixture.dir, 'install-update.sh');
  fs.writeFileSync(script, Update.HELPER_SCRIPT);
  const args = Update.helperArguments({ pid: fixture.exited, appPath: fixture.app, newApp: fixture.newApp, stage: fixture.stage, open: fixture.open, trash: fixture.trash, ...overrides });
  return spawnSync('/bin/sh', [script, ...args], { env: { ...process.env, HOME: fixture.home }, encoding: 'utf8', timeout: 30000 });
}
const versionOf = app => fs.readFileSync(path.join(app, 'Contents/Resources/version.txt'), 'utf8');

test('the helper replaces the app, moves the previous one to the Trash, removes the staging folder and opens the app', t => {
  const fixture = helperFixture(t);
  const result = runHelper(fixture);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(versionOf(fixture.app), '0.5.2');
  assert.equal(versionOf(path.join(fixture.tools, 'trashed/MacLauncher.app')), '0.5.1');
  assert.ok(!fs.existsSync(fixture.stage));
  assert.deepEqual(fixture.opened(), [fixture.app]);
  assert.match(result.stdout, /Installed the new version/);
});

test('without a trash command the previous app moves into the user Trash folder', t => {
  const fixture = helperFixture(t);
  const result = runHelper(fixture, { trash: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(versionOf(fixture.app), '0.5.2');
  const trashed = fs.readdirSync(path.join(fixture.home, '.Trash'));
  assert.equal(trashed.length, 1);
  assert.match(trashed[0], /^MacLauncher \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.app$/);
  assert.equal(versionOf(path.join(fixture.home, '.Trash', trashed[0])), '0.5.1');
});

test('a missing new app leaves the installed app untouched and reopens it', t => {
  const fixture = helperFixture(t);
  fs.rmSync(fixture.newApp, { recursive: true });
  const result = runHelper(fixture);
  assert.equal(result.status, 1);
  assert.equal(versionOf(fixture.app), '0.5.1');
  assert.deepEqual(fixture.opened(), [fixture.app]);
  assert.match(result.stdout, /nothing was changed/);
});

test('the helper waits for the launcher process to exit before touching the app', async t => {
  const fixture = helperFixture(t);
  const launcher = spawn('/bin/sleep', ['1']);
  const cache = path.join(fixture.dir, 'cache');
  let helper;
  Update.startHelper({ cacheDir: cache, args: Update.helperArguments({ pid: launcher.pid, appPath: fixture.app, newApp: fixture.newApp, stage: fixture.stage, open: fixture.open, trash: fixture.trash }),
    spawnProcess: (command, args, options) => (helper = spawn(command, args, { ...options, detached: false, env: { ...process.env, HOME: fixture.home } })) });
  const finished = new Promise(resolve => helper.once('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(versionOf(fixture.app), '0.5.1', 'the app is unchanged while the launcher runs');
  assert.equal(await finished, 0);
  assert.equal(versionOf(fixture.app), '0.5.2');
  assert.match(fs.readFileSync(path.join(cache, 'install.log'), 'utf8'), /Moved the previous version to the Trash/);
});

test('the next launch clears an installed update and keeps one still waiting', async t => {
  const dir = temporary(t), app = installedApp(dir, '0.5.2'), profile = path.join(dir, 'profile');
  const stage = fs.mkdtempSync(path.join(dir, 'Applications', Update.STAGE_PREFIX));
  const staged = { version: '0.5.2', arch: 'arm64', appPath: app, stage, app: fakeApp(stage, '0.5.2', { sign: false }) };
  fs.mkdirSync(path.join(profile, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'updates/staged.json'), JSON.stringify(staged));
  // Still waiting: the running version is older.
  const waiting = updater(t, { dir, appPath: app });
  await waiting.launch({});
  assert.equal(waiting.snapshot().phase, 'ready');
  assert.deepEqual(waiting.trashed, []);
  // Installed: the staging folder and record go.
  const installed = updater(t, { dir, appPath: app, currentVersion: '0.5.2' });
  await installed.launch({});
  assert.deepEqual(installed.trashed, [stage]);
  assert.ok(!fs.existsSync(path.join(profile, 'updates/staged.json')));
  assert.equal(installed.snapshot().phase, 'idle');
  // A record naming a folder elsewhere is dropped without touching that folder.
  const elsewhere = fs.mkdtempSync(path.join(dir, Update.STAGE_PREFIX));
  fs.writeFileSync(path.join(profile, 'updates/staged.json'), JSON.stringify({ ...staged, stage: elsewhere, app: path.join(elsewhere, 'MacLauncher.app') }));
  const foreign = updater(t, { dir, appPath: app, currentVersion: '0.5.2' });
  await foreign.launch({});
  assert.deepEqual(foreign.trashed, []);
  assert.ok(fs.existsSync(elsewhere));
  assert.ok(!fs.existsSync(path.join(profile, 'updates/staged.json')));
});

// --- Network policy ------------------------------------------------------------------

test('nothing contacts GitHub except an explicit check or the launch setting', async t => {
  network.routes = null; network.requests.length = 0;
  const update = updater(t, { respond: button('Later') });
  update.snapshot();
  for (const settings of [undefined, {}, { checkForUpdatesAtLaunch: false }, { checkForUpdatesAtLaunch: 'true' }, { checkForUpdatesAtLaunch: 1 }])
    assert.equal(await update.launch(settings), null);
  update.cancel();
  assert.deepEqual(network.requests, []);
  assert.deepEqual(update.shown, []);

  serve(standardReleases({ arm64: Buffer.from('arm'), x64: Buffer.from('intel') }));
  const result = await update.launch({ checkForUpdatesAtLaunch: true });
  assert.equal(result.outcome, 'available');
  assert.ok(network.requests.some(url => url.startsWith(`https://api.github.com/repos/${REPO}/releases`)));
  assert.equal(update.shown.at(-1).message, 'MacLauncher 0.5.2 is available (current 0.5.1).');
});

test('the launcher calls the updater only from its menu command, the Settings action and the opt-in launch check', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const calls = [...main.matchAll(/appUpdater\.(\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(calls.sort(), ['act', 'cancel', 'choose', 'launch', 'snapshot']);
  assert.match(main, /label: "Check for Updates…", click: \(_item, win\) => void appUpdater\.choose\(/);
  assert.match(main, /ipcMain\.handle\("launcher:appUpdate"[\s\S]{0,400}appUpdater\.act\(action/);
  assert.match(main, /checkForUpdatesAtLaunch: false,/);
  assert.match(main, /checkForUpdatesAtLaunch: current\.checkForUpdatesAtLaunch === true/);
  // In the menu, Check for Updates… follows About.
  assert.ok(main.indexOf('{ role: "about" },') < main.indexOf('label: "Check for Updates…"'));
  assert.ok(main.indexOf('label: "Check for Updates…"') < main.indexOf('{ label: "Credits"'));
  const source = fs.readFileSync(path.join(__dirname, '../src/main/app-update.js'), 'utf8');
  assert.equal(source.match(/source\.discover\(/g).length, 1, 'release discovery happens only in check()');
  assert.equal(source.match(/Upstream\.download\(/g).length, 2, 'only the manifest read and the offered download transfer files');
});
