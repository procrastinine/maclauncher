const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const Focus = require("../src/modules/shared/runtime/native-focus");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-focus-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, "Native game ' quoted");
  fs.writeFileSync(executablePath, "runtime fixture");
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, killed: false });
  return { child, executablePath };
}

test("native focus checks exact owned identity without System Events or a shell", async context => {
  const { child, executablePath } = fixture(context);
  let invocation;
  const result = await Focus.focusOwnedNativeGame(child, { executablePath, launchedAt: 1700000000000, platform: "darwin",
    run: async (...args) => { invocation = args; return { stdout: "activated\n" }; } });
  assert.equal(result.activated, true);
  assert.equal(invocation[0], "/usr/bin/osascript");
  assert.deepEqual(invocation[1].slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.match(invocation[1][3], /runningApplicationWithProcessIdentifier\(123\)/);
  assert.ok(invocation[1][3].includes(JSON.stringify(fs.realpathSync(executablePath))));
  assert.match(invocation[1][3], /identity-changed/);
  assert.match(invocation[1][3], /timeIntervalSince1970/);
  assert.doesNotMatch(invocation[1][3], /app\.finishedLaunching/);
  assert.match(invocation[1][3], /NSApplicationActivateAllWindows/);
  assert.match(invocation[1][3], /CGWindowListCopyWindowInfo/);
  assert.match(invocation[1][3], /NSRunLoop.currentRunLoop.runUntilDate/);
  assert.doesNotMatch(invocation[1][3], /NSThread.sleep|AXUIElement/);
  assert.doesNotMatch(invocation[1][3], /System Events|Application\(/);
  assert.equal(invocation[2].timeout, 8000);
  assert.equal(child.listenerCount("exit"), 0);
});

function scenario(executablePath, { visibleAt = 3, refusal = false, confirm = true, switchedAt, changedAt, aliasPath, layer = 0, finishedLaunching = true } = {}) {
  let frame = 0, front = 100, requestedAt = null;
  const activations = [], pauses = [], expected = fs.realpathSync(executablePath), pid = 123;
  const identity = fs.statSync(expected, { bigint: true });
  const running = { isNil: () => false, terminated: false, get finishedLaunching() { return finishedLaunching && frame >= 1; },
    get executableURL() { return { isNil: () => false, URLByResolvingSymlinksInPath: { path: changedAt != null && frame >= changedAt ? "/foreign/executable" : aliasPath || expected } }; },
    launchDate: { isNil: () => false, timeIntervalSince1970: 1700000000 },
    activateWithOptions: mask => { activations.push({ frame, mask }); requestedAt = frame; if (!refusal) front = pid; return !refusal; } };
  const window = (owner, windowLayer = 0) => ({ kCGWindowOwnerPID: owner, kCGWindowLayer: windowLayer, kCGWindowAlpha: 1,
    kCGWindowBounds: { Width: 640, Height: 480 } });
  const globals = { ObjC: { import: () => {}, unwrap: value => value, castRefToObject: value => value, deepUnwrap: value => value },
    $: { NSApplication: { sharedApplication: { setActivationPolicy: value => assert.equal(value, 2), finishLaunching: undefined } },
      NSApplicationActivationPolicyProhibited: 2, NSFileSystemNumber: "dev", NSFileSystemFileNumber: "ino",
      NSFileManager: { defaultManager: { attributesOfItemAtPathError: actual => ({ isNil: () => false,
        objectForKey: key => ({ stringValue: String(actual === "/foreign/executable" ? -1 : identity[key]) }) }) } },
      NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { isNil: () => false, processIdentifier: front }; } } },
      NSRunningApplication: { runningApplicationWithProcessIdentifier: candidate => { assert.equal(candidate, pid); return running; } },
      CGWindowListCopyWindowInfo: () => frame < visibleAt ? [window(100)] : confirm && requestedAt != null && frame > requestedAt ?
        [window(pid, layer), window(100)] : [window(100), window(pid, layer)],
      kCGWindowListOptionOnScreenOnly: 1, kCGWindowListExcludeDesktopElements: 16, kCGNullWindowID: 0,
      NSApplicationActivateAllWindows: 1, NSApplicationActivateIgnoringOtherApps: 2, NSModalPanelWindowLevel: 8,
      NSDate: { dateWithTimeIntervalSinceNow: seconds => seconds },
      NSRunLoop: { currentRunLoop: { runUntilDate: seconds => { pauses.push(seconds); frame++; if (switchedAt === frame) front = 999; } } } } };
  const reason = vm.runInNewContext(Focus.activationScript({ pid, executablePath, launchedAt: 1700000000000 }), globals, { timeout: 1000 });
  return { reason, activations, pauses };
}

test("activation waits for a real owned window and verifies ordering after one request", context => {
  const { executablePath } = fixture(context), result = scenario(executablePath);
  assert.equal(result.reason, "activated"); assert.deepEqual(result.activations, [{ frame: 3, mask: 3 }]);
  assert.ok(result.pauses.includes(0.05));
  assert.equal(scenario(executablePath, { layer: 8 }).reason, "activated");
  assert.equal(scenario(executablePath, { aliasPath: "/tmp/alias-of-owned-game" }).reason, "activated",
    "AppKit path aliases are accepted only when actual device and inode match");
});

test("a visible owned native window is ready even when its event loop never finishes AppKit launch", context => {
  const { executablePath } = fixture(context);
  const ready = scenario(executablePath, { finishedLaunching: false });
  assert.equal(ready.reason, "activated");
  assert.deepEqual(ready.activations, [{ frame: 3, mask: 3 }]);
  const noWindow = scenario(executablePath, { finishedLaunching: false, visibleAt: 100 });
  assert.equal(noWindow.reason, "window-unavailable");
  assert.deepEqual(noWindow.activations, []);
  const changed = scenario(executablePath, { finishedLaunching: false, changedAt: 2 });
  assert.equal(changed.reason, "identity-changed");
  assert.deepEqual(changed.activations, []);
});

test("native focus reports the bounded result without treating a declined activation as a failed launch", async context => {
  const { child, executablePath } = fixture(context);
  const logs = [];
  const result = await Focus.focusOwnedNativeGame(child, { executablePath, platform: "darwin",
    run: async () => ({ stdout: "foreground-changed\n" }), logger: { debug: (...args) => logs.push(args), warn: () => assert.fail("user focus change is not a warning") } });
  assert.deepEqual(result, { activated: false, reason: "foreground-changed" });
  assert.deepEqual(logs, [["[runtime] native window activation", { pid: child.pid, reason: "foreground-changed" }]]);
});

test("registration, changed identity, user focus changes and unconfirmed requests never cause blind retries", context => {
  const { executablePath } = fixture(context);
  const noWindow = scenario(executablePath, { visibleAt: 100 });
  assert.equal(noWindow.reason, "window-unavailable"); assert.deepEqual(noWindow.activations, []); assert.equal(noWindow.pauses.length, 24);
  const switched = scenario(executablePath, { switchedAt: 2 });
  assert.equal(switched.reason, "foreground-changed"); assert.deepEqual(switched.activations, []);
  const changed = scenario(executablePath, { changedAt: 2 });
  assert.equal(changed.reason, "identity-changed"); assert.deepEqual(changed.activations, []);
  const unconfirmed = scenario(executablePath, { confirm: false });
  assert.equal(unconfirmed.reason, "activation-unconfirmed"); assert.equal(unconfirmed.activations.length, 1);
  const refused = scenario(executablePath, { refusal: true });
  assert.equal(refused.reason, "activation-refused"); assert.equal(refused.activations.length, 1);
});

test("foreground spawn returns before focus completes and preserves child-only environment and arguments", async context => {
  const { child, executablePath } = fixture(context), base = { ORIGINAL: "kept", SDL_MAC_BACKGROUND_APP: "1", DYLD_INSERT_LIBRARIES: "/graphics/helper.dylib" };
  let invocation, focused, finish;
  const launching = Focus.spawnForegroundNativeGame({ context: { spawnDetachedChecked: async (...args) => { invocation = args; return child; } },
    executablePath, args: ["argument with spaces"], options: { cwd: path.dirname(executablePath), env: base }, needsRosetta: true },
    { platform: "darwin", now: () => 1700000000000, focus: (...args) => { focused = args; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(await launching, child); assert.deepEqual(invocation[1], ["argument with spaces"]); assert.equal(invocation[3], true);
  assert.equal(invocation[2].env.SDL_MAC_BACKGROUND_APP, "0"); assert.equal(invocation[2].env.ORIGINAL, "kept");
  assert.equal(invocation[2].env.DYLD_INSERT_LIBRARIES, base.DYLD_INSERT_LIBRARIES); assert.equal(base.SDL_MAC_BACKGROUND_APP, "1");
  assert.equal(focused[0], child); assert.equal(focused[1].launchedAt, 1700000000000); finish({ activated: true });
});

test("successful native spawn survives focus rejection and throwing optional loggers", async context => {
  const { child, executablePath } = fixture(context);
  const loggingFailure = new Error("logger unavailable");
  for (const warn of [() => { throw loggingFailure; }, async () => { throw loggingFailure; }]) {
    const launched = await Focus.spawnForegroundNativeGame({
      context: { spawnDetachedChecked: async () => child, logger: { warn } }, executablePath,
    }, { platform: "darwin", focus: async () => { throw new Error("AppKit unavailable"); } });
    assert.equal(launched, child);
    // Let the detached activation rejection and any logger promise settle.
    // node:test treats an escaped unhandled rejection as a test failure.
    await new Promise(resolve => setImmediate(resolve));
  }
  const logger = { debug: () => { throw loggingFailure; }, warn: () => { throw loggingFailure; } };
  assert.deepEqual(await Focus.focusOwnedNativeGame(child, { executablePath, platform: "darwin", logger,
    run: async () => ({ stdout: "activated\n" }) }), { activated: true, reason: "activated" });
  assert.deepEqual(await Focus.focusOwnedNativeGame(child, { executablePath, platform: "darwin", logger,
    run: async () => { throw new Error("AppKit unavailable"); } }), { activated: false, reason: "AppKit unavailable" });
  assert.equal(child.listenerCount("exit"), 0);
  const spawnFailure = new Error("spawn failed");
  await assert.rejects(Focus.spawnForegroundNativeGame({
    context: { spawnDetachedChecked: async () => { throw spawnFailure; }, logger }, executablePath,
  }, { focus: () => assert.fail("failed spawn must not request focus") }), error => error === spawnFailure);
});

test("native focus cancels its asynchronous registration wait when the owned game exits", async context => {
  const { child, executablePath } = fixture(context);
  let running;
  const pending = Focus.focusOwnedNativeGame(child, { executablePath, platform: "darwin",
    run: (_command, _args, options) => new Promise((_resolve, reject) => {
      running = options;
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }) });
  assert.equal(running.signal.aborted, false);
  child.emit("exit", 0);
  assert.deepEqual(await pending, { activated: false, reason: "game-exited" });
  assert.equal(running.signal.aborted, true);
  assert.equal(child.listenerCount("exit"), 0);
});

test("native focus skips exited games and keeps an activation failure separate from launch", async context => {
  const { child, executablePath } = fixture(context);
  child.exitCode = 0;
  assert.deepEqual(await Focus.focusOwnedNativeGame(child, { executablePath, platform: "darwin", run: () => assert.fail("must not run") }),
    { activated: false, reason: "not-running" });
  child.exitCode = null;
  assert.deepEqual(await Focus.focusOwnedNativeGame(child, { executablePath, platform: "darwin", run: async () => { throw new Error("AppKit unavailable"); } }),
    { activated: false, reason: "AppKit unavailable" });
  assert.throws(() => Focus.activationScript({ pid: 0, executablePath, launchedAt: Date.now() }), /owned native process identity/);
});
