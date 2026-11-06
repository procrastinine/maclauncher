const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Components = require('../src/modules/crossover/runtime/steam-client-components');
const Upstream = require('../src/modules/shared/runtime/upstream');
function archive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-components-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // These bytes test archive discovery/integrity only; they are never loaded.
  for (const name of ['new-layout/SteamClient64.dll', 'other-layout/SteamClient.dll']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'archive inspection input: ' + name);
  }
  fs.mkdirSync(path.join(root, 'duplicate'));
  fs.copyFileSync(path.join(root, 'other-layout/SteamClient.dll'), path.join(root, 'duplicate/steamclient.dll'));
  const zip = path.join(root, 'input.zip');
  execFileSync('/usr/bin/zip', ['-qr', zip, 'new-layout', 'other-layout', 'duplicate'], { cwd: root });
  const sha1 = crypto.createHash('sha1').update(fs.readFileSync(zip)).digest('hex');
  const [resolved] = Components.resolveManifest('"client" { "any_asset" { "file" "changed-name.zip.' + sha1 + '" } }');
  return { root, zip, resolved, userDataDir: path.join(root, 'data') };
}
// Valve's download is served from the fixture archive.
function offline(t, fixture) {
  t.mock.method(Upstream, 'download', async (_asset, destination) => fs.copyFileSync(fixture.zip, destination));
  return { userDataDir: fixture.userDataDir, resolved: fixture.resolved };
}
test('consented Valve install discovers client DLL names in renamed assets and nested paths', async t => {
  const fixture = archive(t);
  const installed = await Components.install(offline(t, fixture));
  assert.equal(installed.archiveSha1, fixture.resolved.sha1);
  assert.equal(fs.readFileSync(path.join(installed.root, installed.clients.i386), 'utf8'), 'archive inspection input: other-layout/SteamClient.dll');
  assert.equal(Components.current(fixture.userDataDir).root, installed.root);
});
test('a damaged content-addressed directory rolls back on failure and leaves no backup after repair', async t => {
  const fixture = archive(t), options = offline(t, fixture);
  const installed = await Components.install(options);
  const file = path.join(installed.root, installed.clients.x86_64);
  fs.writeFileSync(file, 'damaged bytes');
  assert.equal(Components.current(fixture.userDataDir), null);
  const root = path.dirname(installed.root), active = path.join(root, 'active.json');
  const previousRecord = fs.readFileSync(active);
  const previousFiles = installed.files.map(item => [item.path, fs.readFileSync(path.join(installed.root, item.path))]);
  const backups = () => fs.readdirSync(root).filter(name => name.startsWith(installed.archiveSha1 + '.damaged-'));
  const rename = fs.renameSync;
  for (const failure of ['replacement', 'active record']) {
    let injected = false;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (!injected && (failure === 'replacement' ? path.basename(from) === 'payload' && to === installed.root : to === active)) {
        injected = true;
        throw new Error('Injected ' + failure + ' failure');
      }
      return rename(from, to);
    });
    try { await assert.rejects(Components.install(options), /Injected .* failure/); }
    finally { mock.mock.restore(); }
    assert.equal(injected, true);
    for (const [name, bytes] of previousFiles) assert.deepEqual(fs.readFileSync(path.join(installed.root, name)), bytes);
    assert.deepEqual(fs.readFileSync(active), previousRecord);
    assert.deepEqual(backups(), [], 'rollback restores the prior directory');
  }
  const repaired = await Components.install(options);
  assert.equal(repaired.root, installed.root);
  assert.match(fs.readFileSync(file, 'utf8'), /^archive inspection input:/);
  assert.equal(Components.current(fixture.userDataDir).root, installed.root);
  assert.deepEqual(backups(), [], 'successful repair removes its temporary backup');
});

test('the offline download record totals every archive before the client DLLs are found', async t => {
  const fixture = archive(t);
  const unrelated = path.join(fixture.root, 'unrelated.zip');
  fs.writeFileSync(path.join(fixture.root, 'unrelated.txt'), 'not the client files');
  execFileSync('/usr/bin/zip', ['-q', unrelated, 'unrelated.txt'], { cwd: fixture.root });
  const filename = 'first.zip.' + crypto.createHash('sha1').update(fs.readFileSync(unrelated)).digest('hex');
  const first = { filename, url: 'https://client-update.akamai.steamstatic.com/' + filename };
  const requests = [];
  t.mock.method(Upstream, 'download', async (asset, destination) => {
    requests.push(asset.url);
    fs.copyFileSync(asset.url === first.url ? unrelated : fixture.zip, destination);
  });
  const recordPath = path.join(fixture.userDataDir, 'runtimes/steam-client-download.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({ filename, bytes: 123 }));
  assert.equal(Components.lastDownload(fixture.userDataDir), null, 'an old final-archive-only size is not a complete total');
  await Components.install({ userDataDir: fixture.userDataDir, resolved: [first, fixture.resolved] });
  const totalBytes = fs.statSync(unrelated).size + fs.statSync(fixture.zip).size;
  assert.deepEqual(Components.lastDownload(fixture.userDataDir), { filename: fixture.resolved.filename, bytes: totalBytes });
  assert.deepEqual(JSON.parse(fs.readFileSync(recordPath)), { filename: fixture.resolved.filename, totalBytes });
  await Components.remove(fixture.userDataDir);
  assert.equal(Components.lastDownload(fixture.userDataDir).bytes, totalBytes, 'the complete total remains available offline after removal');
  assert.deepEqual(requests, [first.url, fixture.resolved.url]);
});

test('interrupted Steam component removal leaves canonical trash for ordinary upkeep', async t => {
  const Storage = require('../src/core/storage-maintenance');
  const Shared = require('../src/modules/shared/runtime/runtime-components');
  const Bridge = require('../src/modules/crossover/runtime/steam-bridge');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-removal-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const userDataDir = path.join(scratch, 'profile'), runtimes = path.join(userDataDir, 'runtimes');
  const root = path.join(runtimes, 'steam-client-components'), content = path.join(root, '1'.repeat(40));
  fs.mkdirSync(content, { recursive: true });
  fs.writeFileSync(path.join(content, 'steamclient.dll'), 'downloaded component bytes');
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ archiveSha1: '1'.repeat(40), clients: { i386: 'steamclient.dll' } }));
  const protectedFiles = [path.join(runtimes, 'steam-client-download.json'), path.join(runtimes, 'unrelated', 'keep.dat'),
    path.join(userDataDir, 'games', 'saved.dat'), path.join(scratch, 'outside', 'keep.dat')];
  for (const [index, file] of protectedFiles.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'preserved ' + index);
  }
  const protectedBytes = protectedFiles.map(file => fs.readFileSync(file));
  let announce, resume, trash, settled = false;
  const renamed = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const interruption = new Error('Interrupted component deletion');
  const removal = t.mock.method(Storage, 'removeTrash', async target => {
    trash = target; announce(); await gate; throw interruption;
  });
  const manager = Bridge.create({ dependencies: { systemVersionSync: () => '26.0' } });
  const pending = manager.uninstallRuntime({ userDataDir, version: '1.0.0' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, error => error === interruption);
  await renamed;
  assert.equal(settled, false, 'bridge uninstall waits for component deletion');
  assert.equal(path.dirname(trash), runtimes);
  assert.match(path.basename(trash), Storage.TRASH);
  assert.equal(fs.existsSync(root), false, 'the store and active selection are removed together');
  assert.equal(Components.current(userDataDir), null);
  assert.equal(Components.status(userDataDir), null);
  resume(); await rejected; removal.mock.restore();
  assert.deepEqual(fs.readdirSync(runtimes).filter(name => name.startsWith('.')), [path.basename(trash)],
    'the interruption leaves only recognized trash');
  const stores = Storage.listStores({}).filter(store => store.id === 'runtime-removals');
  assert.equal(stores.length, 1, 'use the actual core runtime-removals store');
  const result = await Storage.maintainStorage({ userDataDir, stores });
  assert.deepEqual(result.errors, []);
  assert.equal(result.interrupted, false);
  assert.ok(result.bytes > 0);
  assert.equal(fs.existsSync(trash), false);
  assert.deepEqual(fs.readdirSync(runtimes).sort(), ['steam-client-download.json', 'unrelated']);
  assert.equal(await Components.remove(userDataDir), false);
  assert.equal(await manager.uninstallRuntime({ userDataDir, version: '1.0.0' }), true, 'manager success result is unchanged');

  // Both a linked store and a linked parent must stay outside removal.
  fs.symlinkSync(path.join(scratch, 'outside'), root, 'dir');
  await assert.rejects(Components.remove(userDataDir), /aliases|link/i);
  fs.unlinkSync(root);
  const aliasProfile = path.join(scratch, 'alias-profile'); fs.mkdirSync(aliasProfile);
  fs.mkdirSync(path.join(scratch, 'outside', 'steam-client-components'));
  fs.symlinkSync(path.join(scratch, 'outside'), path.join(aliasProfile, 'runtimes'), 'dir');
  await assert.rejects(Components.remove(aliasProfile), /aliases|link/i);
  await assert.rejects(Shared.removeOwned(path.join(scratch, 'outside'), userDataDir), /outside its store/);
  for (const [index, file] of protectedFiles.entries()) assert.deepEqual(fs.readFileSync(file), protectedBytes[index]);
});
