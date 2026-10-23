const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDownloadIdentity, checkExistingDownload } = require('../src/core/external-download-duplicates');

async function fixture(t, metadata, { custom = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-duplicate-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, custom ? 'custom' : 'external/downloads/' + metadata.store, 'edition');
  await fs.mkdir(location, { recursive: true });
  const saved = { ...metadata, path: location, complete: true };
  const manifest = metadata.store === 'steam' ? '.maclauncher-steam.json' : '.maclauncher-external.json';
  await fs.writeFile(path.join(location, manifest), JSON.stringify(saved));
  const index = path.join(root, metadata.store === 'steam' ? 'steam/installations.json' : 'external/installations.json');
  await fs.mkdir(path.dirname(index), { recursive: true }); await fs.writeFile(index, JSON.stringify([saved]));
  return { root, location: await fs.realpath(location), saved };
}

test('duplicate identity uses exact depot manifests, independent of depot order', () => {
  const common = { store: 'steam', appId: 42, platform: 'windows' }, one = { depotId: 7, manifestId: '18446744073709551615' }, two = { depotId: 8, manifestId: '99' };
  assert.equal(createDownloadIdentity({ ...common, depots: [one, two] }), createDownloadIdentity({ ...common, depots: [two, one] }));
  assert.notEqual(createDownloadIdentity({ ...common, depots: [one] }), createDownloadIdentity({ ...common, depots: [{ ...one, manifestId: '18446744073709551614' }] }));
});

test('default exact copies offer reuse, download-again and cancellation without payload work', async t => {
  const content = { store: 'steam', appId: 42, platform: 'windows', depots: [{ depotId: 7, manifestId: '99' }] };
  const f = await fixture(t, content); const request = { userDataDir: f.root, ...content };
  let prompts = 0;
  const existing = await checkExistingDownload({ ...request, confirmDuplicate: async saved => { prompts++; assert.equal(saved.path, f.location); return 'use-existing'; } });
  assert.equal(existing.path, f.location); assert.equal(prompts, 1);
  assert.equal(await checkExistingDownload({ ...request, confirmDuplicate: async () => 'download-again' }), null);
  await assert.rejects(checkExistingDownload({ ...request, confirmDuplicate: async () => 'cancel' }), { code: 'ABORT_ERR' });
  assert.equal(await checkExistingDownload({ ...request, platform: 'macos', confirmDuplicate: () => assert.fail('different platform') }), null);
  assert.equal(await checkExistingDownload({ ...request, destination: '/custom', confirmDuplicate: () => assert.fail('custom parent') }), null);
});

test('custom copies, deleted copies and different versions do not raise a default duplicate warning', async t => {
  const content = { store: 'itch', appId: '42', platform: 'windows', versionId: '7:99' };
  const f = await fixture(t, content, { custom: true });
  assert.equal(await checkExistingDownload({ userDataDir: f.root, ...content, confirmDuplicate: () => assert.fail('custom copy') }), null);
  const normal = await fixture(t, content);
  assert.equal(await checkExistingDownload({ userDataDir: normal.root, ...content, versionId: '7:100', confirmDuplicate: () => assert.fail('different version') }), null);
  await fs.rm(normal.location, { recursive: true });
  assert.equal(await checkExistingDownload({ userDataDir: normal.root, ...content, confirmDuplicate: () => assert.fail('missing copy') }), null);
});

test('earlier Epic metadata retains its opaque manifest identity', async t => {
  const f = await fixture(t, { store: 'epic', appId: 'Example', platform: 'windows', branch: 'windows', buildId: 'opaque-manifest-id', version: '1.2.3' });
  const found = await checkExistingDownload({ userDataDir: f.root, store: 'epic', appId: 'Example', platform: 'windows', versionId: 'manifest:opaque-manifest-id:windows', confirmDuplicate: async () => 'use-existing' });
  assert.equal(found.path, f.location);
});

test('Google Play exact version, ABI and language identities reuse only the matching Android copy', async t => {
  const content = { store: 'google-play', appId: 'com.example.game', platform: 'android', versionId: '120:arm64:en' };
  const f = await fixture(t, content);
  assert.ok(createDownloadIdentity(content));
  const existing = await checkExistingDownload({ userDataDir: f.root, ...content, confirmDuplicate: async () => 'use-existing' });
  assert.equal(existing.path, f.location);
  assert.equal(await checkExistingDownload({ userDataDir: f.root, ...content, versionId: '120:x86_64:en', confirmDuplicate: () => assert.fail('different ABI') }), null);
  assert.equal(await checkExistingDownload({ userDataDir: f.root, ...content, versionId: '121:arm64:en', confirmDuplicate: () => assert.fail('different version') }), null);
});
