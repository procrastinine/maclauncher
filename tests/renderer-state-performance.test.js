const assert = require('node:assert/strict');
const test = require('node:test');
const { createLibraryFixture } = require('./library-layout-fixture');
let model;
test.before(async () => { model = await import('../src/renderer/src/ui/launcher-state-model.mjs'); });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('identical IPC snapshots reuse the entire launcher state', () => {
  const previous = createLibraryFixture();
  assert.equal(model.shareLauncherValue(previous, structuredClone(previous)), previous);
});
test('download progress preserves game, module, settings and catalog identities', () => {
  const previous = createLibraryFixture();
  previous.downloads = [{ id: 'download', downloaded: 0, status: 'downloading' }];
  const incoming = structuredClone(previous);
  incoming.downloads[0].downloaded = 100;
  const shared = model.shareLauncherValue(previous, incoming);
  assert.notEqual(shared, previous);
  for (const key of ['recents', 'modules', 'moduleSettings', 'moduleStates', 'runtimeManagers', 'runtimeDefaults', 'launcherSettings', 'running']) {
    assert.equal(shared[key], previous[key], key);
  }
  assert.notEqual(shared.downloads, previous.downloads);
  assert.equal(shared.downloads[0].downloaded, 100);
  assert.equal(previous.downloads[0].downloaded, 0);
  assert.deepEqual(shared, incoming);
});
test('changing one game leaves every other game and its extracted icon stable', () => {
  const previous = createLibraryFixture();
  previous.recents = [previous.recents[0], { ...previous.recents[0], gamePath: '/other', gameId: 'other', iconUrl: 'data:image/png;base64,original' }];
  const incoming = structuredClone(previous);
  incoming.recents[0].runtimeData = { managed: { version: '2.0' } };
  const shared = model.shareLauncherValue(previous, incoming);
  assert.notEqual(shared.recents, previous.recents);
  assert.notEqual(shared.recents[0], previous.recents[0]);
  assert.equal(shared.recents[1], previous.recents[1]);
  assert.equal(shared.recents[0].moduleData, previous.recents[0].moduleData);
  assert.deepEqual(shared, incoming);
});
test('reordering or removing games preserves surviving game objects', () => {
  const previous = [{ gamePath: '/a', data: { ready: true } }, { gamePath: '/b', data: { ready: false } }];
  const reordered = model.shareLauncherValue(previous, structuredClone([...previous].reverse()));
  assert.equal(reordered[0], previous[1]);
  assert.equal(reordered[1], previous[0]);
  const removed = model.shareLauncherValue(previous, structuredClone([previous[1]]));
  assert.equal(removed[0], previous[1]);
  assert.deepEqual(model.shareLauncherValue([{ id: 'same', value: 1 }, { id: 'same', value: 2 }], [{ id: 'same', value: 2 }]), [{ id: 'same', value: 2 }]);
});
test('state reconciliation retains false and zero, removes missing fields, and does not merge opaque values', () => {
  const previous = { active: true, count: 1, absent: undefined, date: new Date(0) };
  const incoming = { active: false, count: 0, date: new Date(100) };
  const shared = model.shareLauncherValue(previous, incoming);
  assert.deepEqual(shared, incoming);
  assert.equal(Object.hasOwn(shared, 'absent'), false);
  assert.equal(shared.date, incoming.date);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"zero":0}');
  assert.deepEqual(model.shareLauncherValue({}, hostile), hostile);
  assert.equal(Object.prototype.polluted, undefined);
});
test('identical per-game status responses do not change result maps', () => {
  const statuses = { '/game': { ready: true, version: '1.0' }, '/none': null };
  assert.equal(model.updatePathValue(statuses, '/game', { ready: true, version: '1.0' }), statuses);
  assert.equal(model.updatePathValue(statuses, '/none', null), statuses);
  assert.deepEqual(model.updatePathValue(statuses, '/new', null), { ...statuses, '/new': null });
});
test('inspector requests deduplicate concurrent calls and return cached results on reselection', async () => {
  const requests = model.createInspectionRequests();
  const pending = deferred(); let calls = 0;
  const request = () => { calls += 1; return pending.promise; };
  const first = requests.run('/a', 'status', 'version1', request);
  const strictModeReplay = requests.run('/a', 'status', 'version1', request);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve({ ready: true });
  assert.deepEqual(await first, { current: true, value: { ready: true } });
  assert.deepEqual(await strictModeReplay, { current: true, value: { ready: true } });
  await requests.run('/b', 'status', 'version1', async () => 'other game');
  assert.deepEqual(await requests.run('/a', 'status', 'version1', request), { current: true, value: { ready: true } });
  assert.equal(calls, 1);
});
test('changed runtime inputs suppress a slower old status response', async () => {
  const requests = model.createInspectionRequests();
  const pending = deferred();
  const previous = requests.run('/a', 'status', 'old-runtime-settings', () => pending.promise);
  const changed = await requests.run('/a', 'status', 'new-runtime-settings', async () => 'new');
  assert.deepEqual(changed, { current: true, value: 'new' });
  pending.resolve('old');
  assert.deepEqual(await previous, { current: false, value: 'old' });
});
test('manual refresh invalidates its status while other games and tools keep their cache', async () => {
  const requests = model.createInspectionRequests(); let calls = 0;
  const request = async () => ++calls;
  await requests.run('/a', 'status', 'same', request);
  await requests.run('/a', 'detect', 'same', request);
  await requests.run('/b', 'status', 'same', request);
  requests.invalidate('/a', 'status');
  assert.equal((await requests.run('/a', 'status', 'same', request)).value, 4);
  assert.equal((await requests.run('/a', 'detect', 'same', request)).value, 2);
  assert.equal((await requests.run('/b', 'status', 'same', request)).value, 3);
});
test('failed requests retry and removed-game requests cannot publish', async () => {
  const requests = model.createInspectionRequests();
  await assert.rejects(requests.run('/a', 'status', 'same', async () => { throw Error('temporary'); }), /temporary/);
  assert.equal((await requests.run('/a', 'status', 'same', async () => 'recovered')).value, 'recovered');
  const pending = deferred();
  const removed = requests.run('/removed', 'status', 'same', () => pending.promise);
  requests.retain(['/a']); pending.resolve('obsolete');
  assert.equal((await removed).current, false);
});
test('the initial snapshot cannot replace a newer state broadcast', async () => {
  const pending = deferred(); const received = []; let listener, removed = false;
  const stop = model.subscribeLauncherState({ getState: () => pending.promise,
    onState(callback) { listener = callback; return () => { removed = true; }; } }, state => received.push(state), error => { throw error; });
  listener({ revision: 2 }); pending.resolve({ revision: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [{ revision: 2 }]);
  stop(); assert.equal(removed, true);
  listener({ revision: 3 }); assert.equal(received.length, 1);
});
test('unmounted state subscriptions ignore late snapshots and failures', async () => {
  const pending = deferred(); const received = []; const errors = [];
  const stop = model.subscribeLauncherState({ getState: () => pending.promise, onState: () => () => {} },
    state => received.push(state), error => errors.push(error));
  stop(); pending.reject(Error('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, []); assert.deepEqual(errors, []);
});
