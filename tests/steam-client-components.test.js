const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Components = require('../src/modules/crossover/runtime/steam-client-components');
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
test('consented Valve install discovers client DLL names in renamed assets and nested paths', async t => {
  const fixture = archive(t);
  const installed = await Components.install({ ...fixture, archiveFile: fixture.zip });
  assert.equal(installed.archiveSha1, fixture.resolved.sha1);
  assert.equal(fs.readFileSync(path.join(installed.root, installed.clients.i386), 'utf8'), 'archive inspection input: other-layout/SteamClient.dll');
  assert.equal(Components.current(fixture.userDataDir).root, installed.root);
});
test('a damaged content-addressed directory rolls back on failure and leaves no backup after repair', async t => {
  const fixture = archive(t), options = { ...fixture, archiveFile: fixture.zip };
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
