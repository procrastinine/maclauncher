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
test('a damaged content-addressed directory is retained aside and repaired from the verified archive', async t => {
  const fixture = archive(t), options = { ...fixture, archiveFile: fixture.zip };
  const installed = await Components.install(options);
  const file = path.join(installed.root, installed.clients.x86_64);
  fs.writeFileSync(file, 'damaged bytes');
  assert.equal(Components.current(fixture.userDataDir), null);
  const repaired = await Components.install(options);
  assert.equal(repaired.root, installed.root);
  assert.match(fs.readFileSync(file, 'utf8'), /^archive inspection input:/);
  const retained = fs.readdirSync(path.dirname(installed.root)).filter(name => name.startsWith(installed.archiveSha1 + '.damaged-'));
  assert.equal(retained.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(installed.root), retained[0], installed.clients.x86_64), 'utf8'), 'damaged bytes');
});
