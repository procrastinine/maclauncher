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

test('a replacement game run suppresses the old delayed banner and recovery without retaining completion tokens', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  for (const replacementFinishesFirst of [false, true]) {
    const messages = [], logs = [], recoveries = [];
    const context = { runningGameSessions: new Map(), pendingGameCompletions: new Map(), nextRunSessionId: 1,
      broadcastActivity() {}, observeGameProcess: require('../src/core/game-process-events').observeGameProcess,
      findGameByPath: () => ({ name: 'Example' }), gameRecordsCache: [], path,
      logger: { error: message => logs.push(message) },
      launcherWindows: [{ webContents: { send: (_event, message) => messages.push(message) } }],
      maybeOfferRuntimeRecoveryAfterCrash: (...args) => recoveries.push(args) };
    vm.runInNewContext(source.slice(source.indexOf('function registerGameRun('), source.indexOf('async function stopRunSession(')), context);
    const old = new EventEmitter(), replacement = new EventEmitter();old.pid = 1;replacement.pid = 2;
    old.completionDiagnostics = { pending: true };
    context.registerProcessRun('/same-game', old, 'runtime');
    old.emit('exit', null, 'SIGSEGV');
    assert.equal(context.runningGameSessions.size, 0, 'Playing clears before stderr completes');
    context.registerProcessRun('/same-game', replacement, 'runtime');
    if (replacementFinishesFirst) replacement.emit('exit', 0, null);
    old.completionDiagnostics = { pending: false, message: 'Old native failure' };
    old.emit('diagnostics');old.emit('diagnostics');
    assert.equal(messages.length, 0);assert.equal(recoveries.length, 0);
    assert.equal(logs.length, 1);assert.match(logs[0], /Old native failure/);
    if (!replacementFinishesFirst) {
      assert.equal(context.runningGameSessions.get('/same-game').size, 1);
      assert.equal(context.pendingGameCompletions.size, 1);
      replacement.emit('exit', 0, null);
    }
    assert.equal(context.runningGameSessions.size, 0);
    assert.equal(context.pendingGameCompletions.size, 0);
    assert.equal(old.listenerCount('diagnostics'), 0);
    assert.equal(replacement.listenerCount('diagnostics'), 0);
    const current = new EventEmitter();current.pid = 3;
    const registration = context.registerProcessRun('/same-game', current, 'runtime');
    assert.equal(context.registerProcessRun('/same-game', current, 'runtime'), registration, 'final launch reply reuses early PID registration');
    assert.equal(current.listenerCount('exit'), 1);
    current.emit('exit', 1, null);current.emit('exit', 1, null);
    assert.equal(messages.length, 1, 'a current failure is still delivered once');
    assert.equal(context.pendingGameCompletions.size, 0);
  }
});
