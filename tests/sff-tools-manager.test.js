// Required first: it replaces the network before modules load.
const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createManager } = require('../src/modules/ikemen/tools/sff-manager');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('SFF discovers WASM/glue versions and retains exact offline receipts with optional publisher digests', { skip: process.platform !== 'darwin' }, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sff-catalog-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), glue = Buffer.from('// fixture Go runtime glue');
  let downloads = 0;
  const files = { 'sff.wasm': wasm, 'wasm_exec.js': glue }, release = version => {
    const published = Harness.githubRelease('openkakutou/sff', 'v' + version, Object.keys(files));
    published.assets = published.assets.map(({ digest, ...asset }) => ({ ...asset, size: files[asset.name].length,
      ...(version === '1.2.0' ? { digest: 'sha256:' + sha(files[asset.name]) } : {}) }));
    return published;
  };
  const releases = [release('1.2.0'), release('1.1.0')], routes = Harness.githubRoutes('openkakutou/sff', releases);
  for (const asset of releases.flatMap(item => item.assets)) routes[asset.browser_download_url] = () => { downloads++; return files[asset.name]; };
  const manager = createManager(), requests = Harness.network.requests.length;
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []); assert.equal(Harness.network.requests.length, requests);
  Harness.network.routes = routes;
  let installed;
  try {
    await manager.refreshCatalog({ userDataDir, force: true });
    assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ['1.2.0', '1.1.0']);
    installed = await manager.installRuntime({ userDataDir, version: '1.1.0' });
  } finally { Harness.network.routes = null; }
  assert.equal(downloads, 2);
  const restarted = createManager(), offline = Harness.network.requests.length;
  const selected = restarted.resolveSelection(null, { runtimes: { 'sff-tools': { defaultVersion: '1.1.0' } } }, userDataDir);
  assert.equal(selected.ready, true); assert.equal(selected.version, '1.1.0');
  fs.appendFileSync(path.join(installed.installDir, 'wasm_exec.js'), '\n// altered');
  assert.equal(restarted.resolveSelection(null, {}, userDataDir, { version: '1.1.0' }).ready, false);
  assert.equal(installed.provenanceVerified, false); assert.match(installed.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(installed.installationMetadata.runtimeGlue.sha256, sha(glue));
  assert.equal(Harness.network.requests.length, offline, 'Offline receipts make no request');
  assert.match(manager.__test.recognize({ ...release('2.0.0'), assets: release('2.0.0').assets.slice(0, 1) }).installReason, /Go runtime glue/);
});
