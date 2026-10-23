const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSteamVersionHistory, parseManifestHistory, historyUrl } = require('../src/core/steam-version-history');

const html = `<h2>Files</h2><table><tr><td>1234567890123456789</td></tr></table>
<h2>Previously seen manifests</h2><table><tbody>
<tr data-branch="public"><td data-timestamp="1700000000">Date</td><td></td><td><a href="/depot/102/?manifest=18446744073709551615">18446744073709551615</a></td></tr>
<tr data-manifestid="900000000000000001"><td><time datetime="2023-01-01T00:00:00Z">Date</time></td></tr>
<tr><td>18446744073709551616</td></tr>
<tr><td>900000000000000002</td></tr>
</tbody></table><h2>History</h2><tr data-manifestid="900000000000000003"></tr>`;

function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-history-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true })); return userDataDir;
}
test('SteamDB manifest history retains uint64 IDs and dates without treating file hashes or page history as versions', () => {
  const rows = parseManifestHistory(html, '102', '2026-10-20T00:00:00Z');
  assert.deepEqual(rows.map(row => row.manifestId), ['18446744073709551615', '900000000000000001', '900000000000000002']);
  assert.equal(rows[0].branch, 'public'); assert.equal(rows[0].date, '2023-11-14T22:13:20.000Z');
  assert.equal(rows[1].date, '2023-01-01T00:00:00.000Z');
  assert.equal(rows.every(row => row.depotId === '102'), true);
});
test('previous-version requests are explicit, use only SteamDB depot pages, share in-flight work and reuse the per-game cache', async t => {
  const requests = []; let release;
  const service = createSteamVersionHistory({ userDataDir: fixture(t), fetch: async (url, options) => {
    requests.push({ url, options }); await new Promise(resolve => { release = resolve; }); return new Response(html);
  } }); t.after(() => service.dispose());
  assert.equal(requests.length, 0);
  const first = service.get(101, [102]); const second = service.get('101', ['102']);
  release(); assert.deepEqual(await first, await second); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://steamdb.info/depot/102/manifests/');
  assert.equal(requests[0].options.redirect, 'error'); assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal((await service.get(101, [102])).history.length, 3); assert.equal(requests.length, 1);
  const refresh = service.get(101, [102], { refresh: true }); release(); await refresh; assert.equal(requests.length, 2);
});
test('a SteamDB browser challenge stops further requests and preserves saved choices without pretending history loaded', async t => {
  const userDataDir = fixture(t); let calls = 0;
  const service = createSteamVersionHistory({ userDataDir, fetch: async () => { calls++; return calls === 1 ? new Response(html) : new Response('Browser challenge', { status: 403 }); } });
  t.after(() => service.dispose());
  await service.get(101, [102]);
  const result = await service.get(101, [102, 103, 104], { refresh: true });
  assert.equal(calls, 2); assert.equal(result.blocked, true); assert.match(result.message, /browser access/);
  assert.equal(result.history.length, 3); assert.equal(result.sources.length, 3);
  assert.equal(result.sourceUrl, 'https://steamdb.info/app/101/depots/');
  await assert.rejects(service.get('../101', [102]), /valid Steam/);
  await assert.rejects(service.get(101, []), /Choose/);
  assert.throws(() => historyUrl(101, 'https://example.com'), /valid Steam/);
});
