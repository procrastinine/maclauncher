const path = require("node:path");
const readline = require("node:readline");
const Applications = require("./applications");
const { bindProcessStop } = require("../../core/process-lifecycle");
const { stopProcessTree } = require("../../core/process-stop");

// A session whose helper stops sending its one-second heartbeat is ended, and
// its overlay disappears with the process.
const HEARTBEAT_TIMEOUT_MS = 5000;
// Stop asks the helper to end its session; it stops its captures before it
// exits. A helper still running after this long gets SIGTERM, and SIGKILL two
// seconds later.
const STOP_WAIT_MS = 2000;
const sessions = new Map();
const { targetList, targetId, servedIdentities } = require("./app-actions");

// The session helper is the entry's process: it captures the chosen window,
// display or displays, or the window picked in the system picker for an app,
// and presents the processed image in its overlays. It exits when the window
// closes, the app quits, sharing stops, Stop is chosen or MacLauncher quits;
// the launcher then removes the entry.
const outputScale = settings => /^scale(150|200|250|300|400|500|600|800|1000)$/.test(settings?.output) ? Number(settings.output.slice(5)) / 100 : 0;
const isScaled = settings => settings?.output === "scaled" || outputScale(settings) > 0;
const isDisplay = data => data?.target === "display" || data?.target === "all-displays";
function helperArguments(entry, helper, settings = {}) {
  const data = targetList(entry.moduleData)[0] || {};
  const args = data.target === "window" ? ["--window", String(data.windowID)] : data.target === "display" ? ["--display", String(data.displayID)]
    : data.target === "all-displays" ? ["--all-displays"] : ["--pid", String(data.pid)];
  if (data.target === "application" && Number.isFinite(data.waitWindow) && data.waitWindow > 0) args.push("--wait-window", String(data.waitWindow));
  if (data.target === "application" && data.frontWindow) args.push("--front-window");
  if (!isDisplay(data) && isScaled(settings)) {
    args.push("--scaled");
    if (outputScale(settings)) args.push("--scale", String(outputScale(settings)));
  }
  if (settings?.captureCursor === true) args.push("--cursor");
  return [...args, "--library", helper.library];
}

const validName = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
// The app that owns the window picked in the system picker. A process without
// a bundle identifier can pass the picker's exclusion list, so the session
// then serves that process: its stack is saved under its own identity, and
// shortcuts follow it. Null when the pick belongs to the app the session was
// started for, and for a window chosen directly.
function capturedApplication(data, event) {
  if (data?.target !== "application" || event?.event !== "selected" || !Number.isSafeInteger(event.pid) || event.pid <= 0) return null;
  const bundleIdentifier = validName(event.bundleIdentifier) ? event.bundleIdentifier : undefined;
  if (event.pid === data?.pid && bundleIdentifier === data?.bundleIdentifier) return null;
  return { target: "application", pid: event.pid, ...(bundleIdentifier ? { bundleIdentifier } : {}),
    ...(typeof event.executable === "string" && path.isAbsolute(event.executable) ? { executablePath: event.executable } : {}),
    ...(validName(event.name) ? { applicationName: event.name } : {}) };
}

// Session events and errors go to the launcher log.
function watch(child, { logger = console, onEvent, timeout = HEARTBEAT_TIMEOUT_MS, now = () => Number(process.hrtime.bigint() / 1000000n) } = {}) {
  let last = now();
  for (const [stream, level] of [[child.stdout, "info"], [child.stderr, "warn"]]) {
    if (!stream) continue;
    readline.createInterface({ input: stream }).on("line", line => {
      last = now();
      if (!line.trim() || line === '{"event":"heartbeat"}') return;
      let event = null;
      if (level === "info" && line.startsWith("{")) try { event = JSON.parse(line); } catch {}
      try { logger[level]?.(`[window graphics] ${line.slice(0, 2048)}`); } catch {}
      if (!event || !onEvent) return;
      try { onEvent(event); } catch (error) { logger.warn?.("[window graphics] A session event could not be applied:", error.message); }
    });
    stream.unref?.();
  }
  child.stdin?.unref?.();
  child.stdin?.on?.("error", () => {});
  // The monotonic clock pauses during sleep, as the helper's timer does.
  const timer = setInterval(() => {
    if (now() - last <= timeout) return;
    clearInterval(timer);
    try { logger.warn?.("[window graphics] The session stopped responding and was ended."); } catch {}
    try { child.kill("SIGKILL"); } catch {}
  }, 1000);
  timer.unref?.();
  child.once?.("exit", () => clearInterval(timer));
  return child;
}

// Stop and Trash end a session through this owner: a stop line first, then
// signals to the helper alone. The captured app is never signalled.
function bindSessionStop(child, { wait = STOP_WAIT_MS, stopTree = stopProcessTree } = {}) {
  return bindProcessStop(child, ({ isCurrent }) => new Promise(resolve => {
    if (!isCurrent() || child.exitCode != null || child.signalCode != null) { resolve(true);return; }
    let timer = null;
    const exited = () => { clearTimeout(timer);resolve(true); };
    child.once("exit", exited);
    try { child.stdin?.write?.(JSON.stringify({ stop: true }) + "\n"); } catch {}
    timer = setTimeout(() => { child.removeListener("exit", exited);resolve(isCurrent() ? stopTree(child.pid) : false); }, wait);
    timer.unref?.();
  }));
}

const validReason = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
// A session that fails, for example without the Screen Recording permission,
// gives its reason as the process's completion detail, which MacLauncher shows
// when the session ends. Output ends after the helper's last event.
function reportFailure(child) {
  if (!child?.stdout?.once) return;
  child.completionDiagnostics = { pending: true };
  child.stdout.once("close", () => {
    const reason = child.failureReason;
    child.completionDiagnostics = { pending: false, ...(reason ? { message: /[.!?]$/.test(reason) ? reason : reason + "." } : {}) };
    child.emit?.("diagnostics");
  });
}

async function launch(entry, context = {}) {
  const data = targetList(entry.moduleData)[0] || {};
  const valid = id => Number.isSafeInteger(id) && id > 0;
  if (!(data.target === "window" ? valid(data.windowID) : data.target === "display" ? valid(data.displayID)
    : data.target === "all-displays" || (data.target === "application" && valid(data.pid))))
    throw new Error("Choose a window or a display in File > Apply Graphics.");
  const helper = (context.windowGraphics || Applications.availability)({ root: context.graphicsRuntimeRoot });
  if (!helper.available) throw new Error("Window graphics are unavailable. " + helper.reason);
  (context.verifyFile || require("../shared/reshade/payload-verification").verifyFile)(helper.root, helper.row);
  // The helper loads the graphics library itself and owns every frame call.
  // Graphics preparation adds the plan, live controls and status channels.
  const child = await context.spawnDetachedChecked(helper.executable, helperArguments(entry, helper, context.runtimeSettings),
    { env: process.env, graphicsExecutable: null, stdio: ["pipe", "pipe", "pipe"] });
  if (context.runtimeSettings?.showPointer === false) child.stdin?.write?.(JSON.stringify({ pointer: false }) + "\n");
  let moduleData = { ...entry.moduleData, targets: targetList(entry.moduleData).map(target => ({ ...target })) };
  child.windowTargets = moduleData.targets.slice(0, 1);
  const waiting = new Map();
  const clearWaiting = id => { clearTimeout(waiting.get(id));waiting.delete(id); };
  child.once?.("exit", () => { for (const id of waiting.keys()) clearWaiting(id); });
  // Displays that All Displays covers, by ID, with the names the Apply
  // Graphics window listed; such displays save as All Displays.
  child.allDisplays = allDisplaysNames(moduleData.targets);
  const snapshot = () => {
    const targets = child.windowTargets.map(target => ({ ...target }));
    return { targets, served: servedIdentities({ ...entry, moduleData }, targets) };
  };
  const publish = () => { moduleData = snapshot();context.onEntryChange?.({ moduleData }); };
  child.sessionData = snapshot;
  child.publishTargets = publish;
  bindSessionStop(child);
  reportFailure(child);
  watch(child, { logger: context.logger || console, onEvent: event => {
    const sessionWide = !event.target && event.event === "failed";
    child.failureReason = sessionWide ? validReason(event.reason) ? event.reason : "Window graphics stopped." : undefined;
    if (sessionWide) return;
    const id = event.target;
    let index = id ? child.windowTargets.findIndex(target => targetId(target) === id) : 0;
    if (event.event === "targetRemoved") {
      clearWaiting(id);
      child.windowTargets = child.windowTargets.filter(target => targetId(target) !== id);publish();return;
    }
    if (event.event === "targetAdded" && typeof id === "string") {
      const covered = index < 0 && event.kind === "display" && child.allDisplays ? child.allDisplays.get(event.displayID) || {} : null;
      if (covered && child.windowTargets[0]?.target === "all-displays") index = 0;
      const { displayIDs: _ids, displays: _displays, ...previous } = child.windowTargets[index] || {};
      const target = { ...previous, ...covered, ...(covered ? { allDisplays: true } : {}), id, target: event.kind || previous.target };
      for (const key of ["windowID", "displayID", "pid", "bundleIdentifier", "name"]) if (event[key] !== undefined) target[key] = event[key];
      if (index < 0) child.windowTargets.push(target);else child.windowTargets[index] = target;
      publish();return;
    }
    if (index < 0 || !child.windowTargets[index]) return;
    const previous = child.windowTargets[index];
    const captured = capturedApplication(previous, event);
    if (captured) child.windowTargets[index] = { ...captured, ...(id ? { id } : {}), ...(event.windowID ? { windowID: event.windowID } : {}) };
    if (event.event === "selected" && Number.isSafeInteger(event.windowID)) child.windowTargets[index] = { ...child.windowTargets[index], windowID: event.windowID };
    if (event.event === "state") {
      const target = child.windowTargets[index];
      const revealed = event.revealed === true;
      child.windowTargets[index] = { ...target, state: event.state, revealed,
        reason: revealed ? undefined : validReason(event.reason) ? event.reason : target.reason };
      const key = targetId(child.windowTargets[index]);
      if (event.state !== "running" || revealed) {
        clearWaiting(key);
        if (event.state !== "running" && child.windowTargets[index].reason === "Waiting for the window's first image") child.windowTargets[index].reason = undefined;
      } else if (!waiting.has(key) && target.reason !== "Waiting for the window's first image") {
        const timer = setTimeout(() => {
          waiting.delete(key);
          const current = child.windowTargets.find(row => targetId(row) === key);
          if (current?.state === "running" && !current.revealed) { current.reason = "Waiting for the window's first image";publish(); }
        }, 2000);
        timer.unref?.();waiting.set(key, timer);
      }
    }
    if (event.event === "failed") clearWaiting(targetId(child.windowTargets[index]));
    if (event.event === "failed") child.windowTargets[index] = { ...child.windowTargets[index], state: "failed", reason: event.reason };
    if (captured || ["state", "selected", "failed"].includes(event.event)) publish();
  } });
  if (entry.gameId) {
    sessions.set(entry.gameId, child);
    child.once?.("exit", () => {
      if (sessions.get(entry.gameId) === child) sessions.delete(entry.gameId);
    });
  }
  return child;
}

function allDisplaysNames(targets) {
  const covering = targets.find(target => target?.target === "all-displays");
  if (!covering) return null;
  return new Map((Array.isArray(covering.displays) ? covering.displays : []).map(({ displayID, ...names }) => [displayID, names]));
}
function send(gameId, message) {
  const child = sessions.get(gameId);
  if (!child?.stdin?.writable || child.exitCode != null || child.signalCode != null) return false;
  child.stdin.write(JSON.stringify(message) + "\n");return true;
}
function removeTarget(gameId, id) {
  const child = sessions.get(gameId);
  if (!child?.windowTargets.some(target => targetId(target) === id)) return false;
  if (!send(gameId, { remove: id })) return false;
  child.windowTargets = child.windowTargets.filter(target => targetId(target) !== id);child.publishTargets();return true;
}
function sessionData(gameId) {
  const child = sessions.get(gameId);
  return child ? child.sessionData() : null;
}

// Capture settings apply to a running session as an option line.
function runtimeSettingsChanged(entry, runtimeId, settings) {
  const child = runtimeId === "capture" && sessions.get(entry?.gameId);
  if (!child?.stdin?.writable) return false;
  child.stdin.write(JSON.stringify({ cursor: settings?.captureCursor === true, scaled: isScaled(settings), scale: outputScale(settings), pointer: settings?.showPointer !== false }) + "\n");
  return true;
}

// Scaled output confines the pointer to the source window, which needs
// Accessibility permission. Choosing a scaled output asks through the system
// prompt; until it is granted, the setting stays In place.
function reviewRuntimeSettings(runtimeId, next, previous, { systemPreferences } = {}) {
  if (runtimeId !== "capture" || !isScaled(next) || next.output === previous?.output) return next;
  if (systemPreferences?.isTrustedAccessibilityClient?.(true) === true) return next;
  return { ...next, output: "inPlace" };
}

function windowTogglePointer(entry) { return send(entry?.gameId, { pointer: "toggle" }); }

module.exports = {
  HEARTBEAT_TIMEOUT_MS, STOP_WAIT_MS, launch, helperArguments, watch, bindSessionStop, capturedApplication, runtimeSettingsChanged, reviewRuntimeSettings,
  windowTogglePointer, removeTarget, sessionData
};
