const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Bridge = require('../src/modules/crossover/runtime/steam-bridge');
const Components = require('../src/modules/crossover/runtime/steam-client-components');

test('declined optional bridge stays quiet until explicit refresh permits a new offer', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-bridge-consent-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const bridge = Bridge.create({ identifyGame: () => ({ appId: '123' }), discoverClient: () => '/discovered/client' });
  const context = { userDataDir }, [plan] = await bridge.requirements({}, context);
  assert.equal(plan.optional, true); assert.equal(plan.silentFallback, true);
  bridge.skipOptional(plan, context);
  assert.deepEqual(await bridge.requirements({}, context), []);
  bridge.clearSkipped(userDataDir);
  assert.equal((await bridge.requirements({}, context)).length, 1);
});

test('current Valve metadata selects content addresses without a fixed client version', () => {
  for (const digest of ['1'.repeat(40), 'a'.repeat(40)]) {
    const archive = Components.resolveManifest('"client" { "bins_misc" { "file" "bins_misc_ubuntu12.zip.' + digest + '" "size" "128" } }');
    assert.equal(archive.sha1, digest);
    assert.equal(archive.url, 'https://client-update.akamai.steamstatic.com/' + archive.filename);
  }
  assert.throws(() => Components.resolveManifest('"client" { "bins_misc" { "file" "latest.zip" } }'));
});
