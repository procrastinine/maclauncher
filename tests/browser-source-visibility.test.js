const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const {attachBrowserSourceVisibility, PREFIX} = require("../src/modules/shared/web/runtime/browser-source-visibility");

const token = "0123456789abcdef0123456789abcdef";
const environment = {RESHADE_BROWSER_FRAME_TOKEN: token, RESHADE_BROWSER_FRAME_STATE: "/private/channel"};
const event = PREFIX + token;
function fixture({policy = true, setter, getter, logger} = {}) {
  const win = new EventEmitter(), calls = [], observers = new Map();
  let destroyed = false, current = policy, next = 1;
  const handle = Buffer.alloc(8);handle.writeBigUInt64LE(0xabcdn);
  const contents = {
    isDestroyed: () => destroyed,
    getBackgroundThrottling: () => getter ? getter(current) : current,
    setBackgroundThrottling: value => {calls.push(value);current = value;setter?.(value);}
  };
  Object.assign(win, {webContents: contents, getNativeWindowHandle: () => handle,
    isDestroyed: () => destroyed});
  const subscriptions = [], removals = [];
  const systemPreferences = {
    subscribeLocalNotification: (name, callback) => {const id = next++;observers.set(id, callback);subscriptions.push(name);return id;},
    unsubscribeLocalNotification: id => {removals.push(id);observers.delete(id);}
  };
  const attach = options => attachBrowserSourceVisibility(win, {systemPreferences, environment, platform: "darwin", pid: 42, logger, ...options});
  const notify = (active, overrides = {}, name = event) => {
    for (const callback of [...observers.values()]) callback(name, {schema: 1, pid: 42, nativeView: "abcd", active, ...overrides});
  };
  return {win, contents, calls, observers, subscriptions, removals, attach, notify,
    policy: () => current, writePolicy: value => {current = value;}, close: () => {destroyed = true;win.emit("closed");}};
}

test("original rendering has no subscription or throttling changes without an authenticated browser channel", () => {
  for (const options of [{environment: {}}, {platform: "linux"},
    {environment: {...environment, RESHADE_BROWSER_FRAME_TOKEN: "invalid"}},
    {environment: {RESHADE_BROWSER_FRAME_TOKEN: token}}]) {
    const f = fixture();f.attach(options)();
    assert.deepEqual(f.subscriptions, []);assert.deepEqual(f.calls, []);
  }
});

test("only a matching visible owned-output edge leases animation policy, and external covering restores it", () => {
  const f = fixture(), dispose = f.attach();
  assert.deepEqual(f.subscriptions, [event]);assert.deepEqual(f.calls, []);
  for (const override of [{schema: 2}, {pid: 43}, {nativeView: "beef"}, {active: 1}]) f.notify(true, override);
  f.notify(true, {}, event + "-old");assert.deepEqual(f.calls, []);
  f.notify(true);f.notify(true);assert.deepEqual(f.calls, [false]);
  f.notify(false);assert.deepEqual(f.calls, [false, true]);
  f.notify(true);dispose();
  assert.deepEqual(f.calls, [false, true, false, true]);
  assert.deepEqual(f.removals, [1]);assert.equal(f.observers.size, 0);
  dispose();f.notify(true);assert.equal(f.calls.length, 4);
});

test("preexisting and later game-owned animation policies are preserved", () => {
  const prior = fixture({policy: false});prior.attach();prior.notify(true);prior.notify(false);
  assert.deepEqual(prior.calls, []);assert.equal(prior.policy(), false);
  const changed = fixture();changed.attach();changed.notify(true);
  changed.writePolicy(true);changed.notify(false);
  assert.deepEqual(changed.calls, [false]);assert.equal(changed.policy(), true);
});

test("two windows sharing a launch token never alter the wrong native view", () => {
  const first = fixture(), second = fixture();
  second.win.getNativeWindowHandle = () => {const b = Buffer.alloc(8);b.writeBigUInt64LE(0xbeefn);return b;};
  first.attach();second.attach();
  first.notify(true);second.notify(true);
  assert.deepEqual(first.calls, [false]);assert.deepEqual(second.calls, []);
  second.notify(true, {nativeView: "beef"});assert.deepEqual(second.calls, [false]);
});

test("close unsubscribes and stale callbacks cannot call a retired WebContents", () => {
  const f = fixture();f.attach();const callback = [...f.observers.values()][0];
  f.notify(true);f.close();
  callback(event, {schema: 1, pid: 42, nativeView: "abcd", active: true});
  assert.deepEqual(f.calls, [false]);assert.deepEqual(f.removals, [1]);
});

test("synchronous visibility reentrancy and optional API failures cannot escape into the game", () => {
  let f;
  f = fixture({setter: value => {if (value === false) f.notify(false);}});f.attach();f.notify(true);
  assert.deepEqual(f.calls, [false, true]);assert.equal(f.policy(), true);
  const rejected = fixture({setter: () => {throw Error("Optional setter failed");},
    logger: {warn: () => Promise.reject(Error("Optional warning failed"))}});
  rejected.attach();assert.doesNotThrow(() => rejected.notify(true));
  assert.doesNotThrow(() => rejected.notify(false));assert.equal(rejected.policy(), true);
  const absent = fixture();delete absent.contents.setBackgroundThrottling;
  absent.attach();assert.deepEqual(absent.subscriptions, []);
});
