const path = require("node:path");
const Guards = require("./guards");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);

function logActivation(write) {
  try { void Promise.resolve(write()).catch(() => {}); } catch {}
}

// `executablePath: null` is reserved for a caller that has just matched the PID
// to its own process tree, such as a Wine process whose executable is a
// temporary loader link. `yieldFrom` activates only while that application
// (the launcher) is still frontmost, as an application yielding its activation.
function activationScript({ pid, executablePath, launchedAt, yieldFrom = null }) {
  if (!Number.isInteger(pid) || pid <= 0 || executablePath !== null && (!path.isAbsolute(executablePath || "") || executablePath.includes("\0")) ||
      !Number.isFinite(launchedAt) || launchedAt <= 0 || yieldFrom !== null && (!Number.isInteger(yieldFrom) || yieldFrom <= 0))
    throw new Error("An owned native process identity is required.");
  const expected = executablePath === null ? null : fs.realpathSync(executablePath);
  const identity = expected === null ? null : fs.statSync(expected, { bigint: true });
  return `ObjC.import("AppKit");
ObjC.import("Foundation");
ObjC.import("CoreGraphics");
// AppKit activation requires an application event receiver, even for a
// headless controller. It must never take focus from the game itself.
const controllerApp = $.NSApplication.sharedApplication;
controllerApp.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
controllerApp.finishLaunching;
const expected = ${JSON.stringify(expected)}, earliest = ${(launchedAt - 2000) / 1000};
const expectedDevice = ${JSON.stringify(identity && identity.dev.toString())}, expectedInode = ${JSON.stringify(identity && identity.ino.toString())};
const yieldFrom = ${JSON.stringify(yieldFrom)};
const workspace = $.NSWorkspace.sharedWorkspace;
const initialFront = workspace.frontmostApplication;
const initialFrontPid = initialFront && !initialFront.isNil() ? Number(initialFront.processIdentifier) : null;
function frontPid() {
  const front = workspace.frontmostApplication;
  return front && !front.isNil() ? Number(front.processIdentifier) : null;
}
function windows() {
  const value = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
  if (!value) return [];
  const rows = ObjC.deepUnwrap(ObjC.castRefToObject(value));
  return Array.isArray(rows) ? rows.slice(0, 4096).filter(row => (Number(row.kCGWindowLayer) === 0 ||
    Number(row.kCGWindowOwnerPID) === ${pid} && Number(row.kCGWindowLayer) > 0 && Number(row.kCGWindowLayer) <= Number($.NSModalPanelWindowLevel)) &&
    Number(row.kCGWindowAlpha) > 0 && Number(row.kCGWindowBounds?.Width) > 1 && Number(row.kCGWindowBounds?.Height) > 1) : [];
}
function pause(seconds) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
}
// Another application in front keeps its activation; only the launcher yields.
const yielding = yieldFrom === null || initialFrontPid === yieldFrom || initialFrontPid === ${pid};
let result = yielding ? "not-registered" : "launcher-inactive";
for (let attempt = 0; yielding && attempt < 24; attempt++) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
  if (app && !app.isNil() && !app.terminated && app.executableURL && !app.executableURL.isNil()) {
    let sameFile = expected === null;
    if (!sameFile) {
      const actual = ObjC.unwrap(app.executableURL.URLByResolvingSymlinksInPath.path);
      // AppKit may spell /private/tmp as /tmp even after URL resolution.
      // Compare the actual file identity, never a guessed path substitution.
      const attributes = $.NSFileManager.defaultManager.attributesOfItemAtPathError(actual, null);
      sameFile = attributes && !attributes.isNil() &&
        ObjC.unwrap(attributes.objectForKey($.NSFileSystemNumber).stringValue) === expectedDevice &&
        ObjC.unwrap(attributes.objectForKey($.NSFileSystemFileNumber).stringValue) === expectedInode;
    }
    const date = app.launchDate;
    if (!sameFile || date && !date.isNil() && Number(date.timeIntervalSince1970) < earliest) {
      result = "identity-changed"; break;
    }
    const visible = windows();
    // A runtime can own a live Cocoa window while running its own event loop
    // without NSApplication's finishLaunching. The owned window is readiness.
    if (visible.some(row => Number(row.kCGWindowOwnerPID) === ${pid})) {
      const currentFrontPid = frontPid();
      if (currentFrontPid === ${pid} && Number(visible[0]?.kCGWindowOwnerPID) === ${pid}) {
        result = "already-frontmost"; break;
      }
      if (initialFrontPid && currentFrontPid !== initialFrontPid && currentFrontPid !== ${pid}) {
        result = "foreground-changed"; break;
      }
      if (!app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)) {
        result = "activation-refused"; break;
      }
      result = "activation-unconfirmed";
      for (let verification = 0; verification < 12; verification++) {
        pause(0.05);
        const ordered = windows();
        if (frontPid() === ${pid} && Number(ordered[0]?.kCGWindowOwnerPID) === ${pid}) {
          result = "activated"; break;
        }
      }
      break;
    }
    result = "window-unavailable";
  }
  pause(0.25);
}
result;`;
}

/** AppKit activation in an asynchronous child; no System Events or Electron. */
async function focusOwnedNativeGame(child, { executablePath, launchedAt = Date.now(), logger, run = execute, platform = process.platform } = {}) {
  if (platform !== "darwin" || !Number.isInteger(child?.pid) || child.pid <= 0 || child.exitCode != null || child.signalCode != null || child.killed) return { activated: false, reason: "not-running" };
  const controller = new AbortController();
  const stop = () => controller.abort();
  child.once?.("exit", stop);
  try {
    const script = activationScript({ pid: child.pid, executablePath, launchedAt });
    const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script],
      { signal: controller.signal, timeout: 8000, maxBuffer: Guards.limit(4096) });
    const reason = result.stdout.trim();
    logActivation(() => logger?.debug?.("[runtime] native window activation", { pid: child.pid, reason }));
    return { activated: reason === "activated" || reason === "already-frontmost", reason };
  } catch (error) {
    const reason = controller.signal.aborted ? "game-exited" : error.message;
    if (!controller.signal.aborted) logActivation(() => logger?.warn?.(`[runtime] native window activation: ${reason}`));
    return { activated: false, reason };
  } finally { child.removeListener?.("exit", stop); }
}

/** Activates a process the caller has matched to its own launch, while `yieldFrom` is frontmost. */
async function focusOwnedProcess(pid, { launchedAt, yieldFrom = null, signal, logger, run = execute, platform = process.platform } = {}) {
  if (platform !== "darwin" || signal?.aborted) return { activated: false, reason: "not-running" };
  try {
    const script = activationScript({ pid, executablePath: null, launchedAt, yieldFrom });
    const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { signal, timeout: 8000, maxBuffer: Guards.limit(4096) });
    const reason = result.stdout.trim();
    logActivation(() => logger?.debug?.("[runtime] window activation", { pid, reason }));
    return { activated: reason === "activated" || reason === "already-frontmost", reason };
  } catch (error) {
    const reason = signal?.aborted ? "game-exited" : error.message;
    if (!signal?.aborted) logActivation(() => logger?.warn?.(`[runtime] window activation: ${reason}`));
    return { activated: false, reason };
  }
}

function foregroundEnvironment(environment = process.env, { platform = process.platform } = {}) {
  // SDL otherwise defaults to background activation on newer macOS versions.
  // This is a child-only game launch hint, not a global system preference.
  return { ...environment, ...(platform === "darwin" ? { SDL_MAC_BACKGROUND_APP: "0" } : {}) };
}

async function spawnForegroundNativeGame({ context, executablePath, args = [], options = {}, needsRosetta = false },
  { focus = focusOwnedNativeGame, now = Date.now, platform = process.platform } = {}) {
  if (typeof context?.spawnDetachedChecked !== "function") throw new Error("Native process launcher is unavailable.");
  const launchedAt = now();
  const child = await context.spawnDetachedChecked(executablePath, args,
    { ...options, env: foregroundEnvironment(options.env || process.env, { platform }) }, needsRosetta);
  // Game registration/window creation is independent of the launcher response.
  // A launch can run a private copy of the executable for graphics.
  const launched = context.launchedPath?.(executablePath) ?? executablePath;
  void Promise.resolve().then(() => focus(child, { executablePath: launched, launchedAt, logger: context.logger, platform }))
    .catch(error => logActivation(() => context.logger?.warn?.(`[runtime] native window activation: ${error.message}`)));
  return child;
}

module.exports = { activationScript, focusOwnedNativeGame, focusOwnedProcess, foregroundEnvironment, spawnForegroundNativeGame };
