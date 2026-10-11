const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
let subscribeLauncherGameFailures;
test.before(async () => {
  ({ subscribeLauncherGameFailures } = await import('../src/renderer/src/ui/launcher-state-model.mjs'));
});

function bridge() {
  const ipc = new EventEmitter();
  const invocations = [];
  ipc.invoke = (...args) => { invocations.push(args); return Promise.resolve(); };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/shared/web/preload/launcher.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) {
        assert.equal(name, 'MacLauncher'); api = value.launcher;
      } } };
    }
  });
  return { api, ipc, invocations };
}

test('the production preload forwards game failures to the renderer message subscription without exposing the IPC event', () => {
  const { api, ipc, invocations } = bridge();
  const messages = [];
  const stop = subscribeLauncherGameFailures(api, message => messages.push(message));
  const failure = Object.freeze({ gamePath: '/game', message: 'Example game exited with code 7.' });
  ipc.emit('launcher:gameFailed', { internalSender: true }, failure);
  assert.deepEqual(messages, [failure.message]);
  assert.deepEqual(invocations, [], 'subscribing or receiving failures must not launch or read games');
  stop();
  assert.equal(ipc.listenerCount('launcher:gameFailed'), 0);
  ipc.emit('launcher:gameFailed', {}, { ...failure, message: 'Late failure' });
  assert.deepEqual(messages, [failure.message]);
});

test('each failure subscription removes only its own preload listener', () => {
  const { api, ipc } = bridge();
  const first = [], second = [];
  const stopFirst = api.onGameFailed(value => first.push(value));
  const stopSecond = api.onGameFailed(value => second.push(value));
  stopFirst();
  const failure = { gamePath: '/second', message: 'Second game ended with SIGABRT.' };
  ipc.emit('launcher:gameFailed', {}, failure);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [failure]);
  stopSecond(); assert.equal(ipc.listenerCount('launcher:gameFailed'), 0);
});

test('unmounted failure subscriptions ignore queued events and missing or malformed messages', () => {
  let listener, removed = false;
  const messages = [];
  const stop = subscribeLauncherGameFailures({ onGameFailed(callback) {
    listener = callback; return () => { removed = true; };
  } }, message => messages.push(message));
  for (const value of [null, {}, { message: null }, { message: 1 }, { message: '' }, { message: '  ' }]) listener(value);
  assert.deepEqual(messages, []);
  listener({ gamePath: '/game', message: 'Game failed.\nMore details.' });
  assert.deepEqual(messages, ['Game failed.\nMore details.']);
  stop(); assert.equal(removed, true);
  listener({ gamePath: '/game', message: 'Queued after closing the launcher.' });
  assert.equal(messages.length, 1);
  for (const api of [undefined, {}]) assert.doesNotThrow(() => subscribeLauncherGameFailures(api, () => assert.fail('No bridge subscription'))());
});
