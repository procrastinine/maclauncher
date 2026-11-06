const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const Focus = require("../src/modules/shared/runtime/native-focus");
const WineActivation = require("../src/modules/shared/runtime/wine-activation");

// A notification center with Electron's systemPreferences shape.
function center() {
  const subscriptions = new Map();
  let next = 1;
  return { subscriptions,
    subscribeNotification: (name, callback) => { const id = next++; subscriptions.set(id, { name, callback }); return id; },
    unsubscribeNotification: id => { subscriptions.delete(id); },
    post: (name, userInfo) => { for (const { name: wanted, callback } of [...subscriptions.values()]) if (wanted === name) callback(name, userInfo, ""); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('every initial activation precondition logs its outcome on the common line', async () => {
  const Host = require('../src/main/launch-activation');
  const aborted = new AbortController();aborted.abort();
  for (const [options, expected] of [
    [{ platform: 'linux' }, { reason: 'unavailable', detail: 'unsupported-platform' }],
    [{ signal: aborted.signal }, { reason: 'unavailable', detail: 'launch-ended' }],
    [{ native: () => { throw Error('helper missing'); } }, { reason: 'unavailable', detail: 'helper missing' }],
    [{ native: () => ({ inspect: () => { throw Error('helper inspect failed'); } }) }, { reason: 'unavailable', detail: 'helper inspect failed' }],
    [{ native: () => ({ inspect: () => ({ active: false }) }) }, { reason: 'launcher-inactive' }]
  ]) {
    const logs = [], { signal, ...dependencies } = options;
    const result = await Host.followProcessActivation({ pid: 500 }, { signal }, {
      platform: 'darwin', native: () => assert.fail('No helper load'), ...dependencies,
      logger: { debug: (...args) => logs.push(args) }, systemPreferences: center()
    });
    assert.deepEqual(result, expected);
    assert.deepEqual(logs, [['[runtime] initial window activation', { pid: 500, ...expected }]]);
  }
});

test("ordinary Wine activation crosses the host seam and ends with the launch", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 500, exitCode: null, signalCode: null });
  let request, signal, release;
  const stop = WineActivation.followWineActivation(child, { ui: { followProcessActivation: (value, options) => {
    request = value;signal = options.signal;return new Promise(resolve => { release = resolve; });
  } } }, { platform: 'darwin' });
  assert.deepEqual(request, { pid: 500, notification: WineActivation.NOTIFICATION, pidKey: 'ActivatingAppPID' });
  assert.equal(signal.aborted, false);
  child.emit('exit', 0);assert.equal(signal.aborted, true);
  stop();release({ reason: 'launch-ended' });await settle();
  assert.equal(child.listenerCount('exit'), 0);
});

test("the host yields once to the first owned visible window and never steals focus later", async () => {
  const Host = require('../src/main/launch-activation');
  const notifications = center(), yielded = [], logs = [], controller = new AbortController();
  const windows = new Set();let front = 42;
  const native = { inspect: pid => ({ active: front === 42, frontmostPid: front, frontWindowPid: front, windowId: windows.has(pid) ? 123 : 0 }),
    yield: pid => { yielded.push(pid);front = pid;return { yielded: true, windowId: 123 }; } };
  const done = Host.followProcessActivation({ pid: 500, notification: WineActivation.NOTIFICATION, pidKey: 'ActivatingAppPID' },
    { signal: controller.signal }, { platform: 'darwin', systemPreferences: notifications, native: () => native, logger: { debug: (...args) => logs.push(args) },
      list: async () => [[500, 1], [501, 500], [502, 501], [601, 600]] });
  notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 601 });await settle();
  notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 'invalid' });
  notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 500 });await settle();
  assert.deepEqual(yielded, []);
  notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 501 });await settle();
  notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 502 });await settle();
  assert.deepEqual(yielded, [], 'a process without a visible top-level window is not activated');
  windows.add(502);
  assert.deepEqual(await done, { reason: 'activated', target: 502, windowId: 123 }, 'an earlier windowless Wine helper cannot block the actual game window');
  assert.deepEqual(logs, [['[runtime] initial window activation', { pid: 500, reason: 'activated', target: 502, windowId: 123 }]]);
  assert.deepEqual(yielded, [502]);assert.equal(notifications.subscriptions.size, 0);
  notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 502 });await settle();assert.deepEqual(yielded, [502]);
});

test("a user switch or game exit cancels the initial window handoff", async () => {
  const Host = require('../src/main/launch-activation');
  for (const exit of [false, true]) {
    const notifications = center(), controller = new AbortController();let active = true;
    const native = { inspect: () => ({ active, frontmostPid: active ? 42 : 77, windowId: 0 }), yield: () => assert.fail('no focus rescue') };
    const done = Host.followProcessActivation({ pid: 500, notification: WineActivation.NOTIFICATION, pidKey: 'ActivatingAppPID' },
      { signal: controller.signal }, { platform: 'darwin', systemPreferences: notifications, native: () => native, list: async () => [[502, 500]] });
    if (exit) controller.abort();
    else { active = false;notifications.post(WineActivation.NOTIFICATION, { ActivatingAppPID: 502 }); }
    assert.equal((await done).reason, exit ? 'launch-ended' : 'foreground-changed');
    assert.equal(notifications.subscriptions.size, 0);
  }
});

// Runs the generated JXA activation script against a stub AppKit.
function yieldScenario({ front }) {
  const pid = 502, activations = [];
  let current = front;
  const running = { isNil: () => false, terminated: false,
    executableURL: { isNil: () => false, URLByResolvingSymlinksInPath: { path: "/private/var/folders/winetemp/Game.exe" } },
    launchDate: { isNil: () => false, timeIntervalSince1970: 1700000001 },
    activateWithOptions: mask => { activations.push(mask); current = pid; return true; } };
  const window = owner => ({ kCGWindowOwnerPID: owner, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { Width: 640, Height: 480 } });
  const globals = { ObjC: { import: () => {}, unwrap: value => value, castRefToObject: value => value, deepUnwrap: value => value },
    $: { NSApplication: { sharedApplication: { setActivationPolicy: () => {}, finishLaunching: undefined } }, NSApplicationActivationPolicyProhibited: 2,
      NSFileManager: { defaultManager: { attributesOfItemAtPathError: () => assert.fail("an ownership-matched PID needs no executable identity") } },
      NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { isNil: () => false, processIdentifier: current }; } } },
      NSRunningApplication: { runningApplicationWithProcessIdentifier: candidate => { assert.equal(candidate, pid); return running; } },
      CGWindowListCopyWindowInfo: () => current === pid ? [window(pid), window(42)] : [window(42), window(pid)],
      kCGWindowListOptionOnScreenOnly: 1, kCGWindowListExcludeDesktopElements: 16, kCGNullWindowID: 0,
      NSApplicationActivateAllWindows: 1, NSApplicationActivateIgnoringOtherApps: 2, NSModalPanelWindowLevel: 8,
      NSDate: { dateWithTimeIntervalSinceNow: seconds => seconds }, NSRunLoop: { currentRunLoop: { runUntilDate: () => {} } } } };
  const script = Focus.activationScript({ pid, executablePath: null, launchedAt: 1700000000000, yieldFrom: 42 });
  return { reason: vm.runInNewContext(script, globals, { timeout: 1000 }), activations };
}

test("the launcher yields activation to a matched Wine process only while it is frontmost", () => {
  const yielded = yieldScenario({ front: 42 });
  assert.equal(yielded.reason, "activated"); assert.deepEqual(yielded.activations, [3]);
  const elsewhere = yieldScenario({ front: 77 });
  assert.equal(elsewhere.reason, "launcher-inactive"); assert.deepEqual(elsewhere.activations, []);
  assert.throws(() => Focus.activationScript({ pid: 502, launchedAt: 1700000000000 }), /identity is required/,
    "an omitted executable still requires the native identity check");
  assert.throws(() => Focus.activationScript({ pid: 502, executablePath: null, launchedAt: 1700000000000, yieldFrom: -1 }), /identity is required/);
});

test("PID activation runs one bounded osascript request and reports its result", async () => {
  let invocation;
  const result = await Focus.focusOwnedProcess(502, { launchedAt: 1700000000000, yieldFrom: 42, platform: "darwin",
    run: async (...args) => { invocation = args; return { stdout: "launcher-inactive\n" }; } });
  assert.deepEqual(result, { activated: false, reason: "launcher-inactive" });
  assert.equal(invocation[0], "/usr/bin/osascript"); assert.equal(invocation[2].timeout, 8000);
  assert.match(invocation[1][3], /runningApplicationWithProcessIdentifier\(502\)/);
  assert.match(invocation[1][3], /const yieldFrom = 42;/);
  assert.deepEqual(await Focus.focusOwnedProcess(502, { launchedAt: 1700000000000, platform: "linux", run: async () => assert.fail("not macOS") }),
    { activated: false, reason: "not-running" });
});
