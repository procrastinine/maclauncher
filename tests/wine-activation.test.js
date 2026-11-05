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

test("Wine activation requests are answered only for processes started by the launch", async () => {
  const notifications = center(), focused = [];
  const child = Object.assign(new EventEmitter(), { pid: 500, exitCode: null, signalCode: null });
  // 500 is the supervisor; 501 the CrossOver wrapper; 502 the game. 600 is another Wine program.
  const rows = [[500, 1], [501, 500], [502, 501], [600, 1], [601, 600]];
  WineActivation.followWineActivation(child, { ui: { systemPreferences: notifications } }, { platform: "darwin", launcherPid: 42, now: () => 1700000000000,
    list: async () => rows, focus: async (pid, options) => { focused.push({ pid, yieldFrom: options.yieldFrom, launchedAt: options.launchedAt, signal: options.signal }); return { activated: true }; } });
  assert.deepEqual([...notifications.subscriptions.values()].map(row => row.name), ["WineAppWillActivateNotification"]);

  notifications.post("WineAppWillActivateNotification", { ActivatingAppPID: 601, ActivatingAppPrefix: "/other/bottle" });
  notifications.post("WineAppWillActivateNotification", { ActivatingAppPID: "not a pid" });
  notifications.post("WineAppWillActivateNotification", { ActivatingAppPID: 500 });
  await settle();
  assert.deepEqual(focused, [], "foreign, malformed and supervisor PIDs are ignored");

  notifications.post("WineAppWillActivateNotification", { ActivatingAppPID: 502, ActivatingAppPrefix: "/game/bottle", ActivatingAppConfigDir: "" });
  notifications.post("WineAppWillActivateNotification", { ActivatingAppPID: 502 });
  await settle();
  assert.equal(focused.length, 1, "a repeated request while one is pending makes no second activation");
  assert.equal(focused[0].pid, 502); assert.equal(focused[0].yieldFrom, 42); assert.equal(focused[0].launchedAt, 1700000000000);
  assert.equal(focused[0].signal.aborted, false);

  child.exitCode = 0; child.emit("exit", 0);
  assert.equal(notifications.subscriptions.size, 0, "the subscription ends with the launched process");
  assert.equal(focused[0].signal.aborted, true, "a pending activation is canceled when the game exits");
  notifications.post("WineAppWillActivateNotification", { ActivatingAppPID: 502 });
  await settle();
  assert.equal(focused.length, 1);
});

test("Wine activation needs macOS, a running launch and the host notification service", () => {
  const notifications = center(), child = Object.assign(new EventEmitter(), { pid: 500, exitCode: null, signalCode: null });
  const options = { list: async () => assert.fail("no process lookup"), focus: async () => assert.fail("no activation") };
  WineActivation.followWineActivation(child, { ui: { systemPreferences: notifications } }, { ...options, platform: "linux" });
  WineActivation.followWineActivation(child, { ui: {} }, { ...options, platform: "darwin" });
  WineActivation.followWineActivation({ ...child, exitCode: 1 }, { ui: { systemPreferences: notifications } }, { ...options, platform: "darwin" });
  assert.equal(notifications.subscriptions.size, 0);
  const stop = WineActivation.followWineActivation(child, { ui: { systemPreferences: notifications } }, { ...options, platform: "darwin" });
  assert.equal(notifications.subscriptions.size, 1); stop(); stop();
  assert.equal(notifications.subscriptions.size, 0); assert.equal(child.listenerCount("exit"), 0);
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
