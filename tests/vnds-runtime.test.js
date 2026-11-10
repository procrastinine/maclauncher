const test = require('node:test');
const assert = require('node:assert/strict');
const Love = require('../src/modules/love/main');
const Vnds = require('../src/modules/vnds/main');

// Play runs the VNDS interpreter on LÖVE, so the inspector's Automatic entry
// names LÖVE's version for the same host entry that Play prepares.
test('the VNDS Automatic version is LÖVE\'s for the host entry Play runs', t => {
  const calls = [];
  t.mock.method(Love, 'automaticRuntimeVersion', (entry, context) => { calls.push({ entry, context }); return '11.5'; });
  const entry = { gameId: 'vnds-game', moduleId: 'vnds', runtimeId: 'vnds_love',
    runtimeData: { vnds_love: { version: null, channel: 'stable' } } };
  assert.equal(Vnds.automaticRuntimeVersion(entry, { runtimeId: 'vnds_love', userDataDir: '/profile' }), '11.5');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.runtimeId, 'love');
  assert.equal(calls[0].context.userDataDir, '/profile');
  assert.equal(calls[0].entry.runtimeId, 'love');
  assert.deepEqual(calls[0].entry.runtimeData, { love: { version: null, channel: 'stable' } });
});
