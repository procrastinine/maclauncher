const test = require('node:test'), assert = require('node:assert/strict');

test('version order compares numeric runs, prerelease suffixes and build hashes', async () => {
  const { compareVersions } = await import('../src/modules/shared/runtime/version-order.mjs');
  const ordered = ['0.72', '0.80', '0.80-244-g7c8dee1', '1.9', '1.10.3', '2.0-rc1', '2.0', 'v3.1', '3.1.1', '26.3', '27.0.0-devel-MCLv12-local-44d8dd17'];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), ordered);
  assert.equal(compareVersions('3.1.1', 'V3.1.1'), 0);
  assert.equal(compareVersions('dxvk-async', 'DXVK-ASYNC'), 0, 'labels without versions compare by base letters');
  assert.ok(compareVersions('build-2', 'build-10') < 0, 'numeric runs in plain labels compare as numbers');
  assert.equal(compareVersions('1.0-abcdef1', '1.0-1234567'), 0, 'build hashes do not order builds');
  for (const prefix of ['', 'sha1-']) assert.equal(compareVersions(prefix + 'f'.repeat(40), prefix + '1'.repeat(40)), 0,
    'content-addressed versions identify bytes without imposing release order');
  assert.equal(compareVersions('sha256-' + 'f'.repeat(64), '7.0'), 0, 'a content digest cannot establish that it supersedes a release');
});
