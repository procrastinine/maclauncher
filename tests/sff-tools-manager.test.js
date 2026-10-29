const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createManager } = require('../src/modules/ikemen/tools/sff-manager');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('SFF discovers WASM/glue versions and retains exact offline receipts with optional publisher digests', { skip: process.platform !== 'darwin' }, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sff-catalog-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), glue = Buffer.from('// fixture Go runtime glue');
  let requests = 0, downloads = 0;
  const release = version => ({ tag_name: 'v' + version, assets: [['sff.wasm', wasm], ['wasm_exec.js', glue]].map(([name, bytes], index) =>
    ({ name, id: 100 + index, size: bytes.length, ...(version === '1.2.0' ? { digest: 'sha256:' + sha(bytes) } : {}), browser_download_url: `https://github.com/openkakutou/sff/releases/download/v${version}/${name}` })) });
  const dependencies = { fetchGithubReleases: async () => { requests++; return [release('1.2.0'), release('1.1.0')]; },
    fetchGithubTags: async () => ['1.2.0', '1.1.0'].map(version => ({ name: 'v' + version, commit: { sha: 'a'.repeat(40) } })),
    downloadToFile: async (url, file) => { downloads++; fs.writeFileSync(file, url.endsWith('sff.wasm') ? wasm : glue); } };
  const manager = createManager(dependencies);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []); assert.equal(requests, 0);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ['1.2.0', '1.1.0']);
  const installed = await manager.installRuntime({ userDataDir, version: '1.1.0' }); assert.equal(downloads, 2);
  const restarted = createManager({ fetchGithubReleases: () => assert.fail('offline receipt cannot fetch'), downloadToFile: () => assert.fail('offline receipt cannot download') });
  const selected = restarted.resolveSelection(null, { runtimes: { 'sff-tools': { defaultVersion: '1.1.0' } } }, userDataDir);
  assert.equal(selected.ready, true); assert.equal(selected.version, '1.1.0');
  fs.appendFileSync(path.join(installed.installDir, 'wasm_exec.js'), '\n// altered');
  assert.equal(restarted.resolveSelection(null, {}, userDataDir, { version: '1.1.0' }).ready, false);
  assert.equal(installed.provenanceVerified, false); assert.match(installed.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(installed.installationMetadata.runtimeGlue.sha256, sha(glue));
  assert.equal(await manager.__test.mapRelease({ ...release('2.0.0'), assets: release('2.0.0').assets.map(asset => ({ ...asset, browser_download_url: 'https://example.com/' + asset.name })) },
    { githubAssetDigest: () => null }), null);
});
