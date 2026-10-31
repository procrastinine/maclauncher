const path = require("node:path");
const readline = require("node:readline");
const Applications = require("./applications");

// A session whose helper stops sending its one-second heartbeat is ended, and
// its overlay disappears with the process.
const HEARTBEAT_TIMEOUT_MS = 5000;
// A library game's window can follow a launcher window or a loading screen.
const COMPANION_WAIT_SECONDS = 120;
const sessions = new Map();

// The session helper is the entry's process: it presents the content picker,
// captures the picked window or display and presents the processed image in
// its overlay. It exits when the window closes, the app quits, sharing stops,
// Stop is chosen or MacLauncher quits; the launcher then removes the entry.
function helperArguments(entry, helper, settings = {}) {
  const data = entry.moduleData || {};
  const args = data.target === "display" ? ["--display"] : ["--pid", String(data.pid)];
  if (data.target !== "display" && Number.isFinite(data.waitWindow) && data.waitWindow > 0) args.push("--wait-window", String(data.waitWindow));
  if (data.target !== "display" && settings?.output === "scaled") args.push("--scaled");
  if (settings?.captureCursor === true) args.push("--cursor");
  return [...args, "--library", helper.library];
}

const validName = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
// The app that owns the picked window. A process without a bundle identifier
// can pass the picker's exclusion list, so the session then serves that
// process: its stack is saved under its own identity, and shortcuts follow
// it. Null when the pick belongs to the app the session was started for.
function capturedApplication(data, event) {
  if (data?.target === "display" || event?.event !== "selected" || !Number.isSafeInteger(event.pid) || event.pid <= 0) return null;
  const bundleIdentifier = validName(event.bundleIdentifier) ? event.bundleIdentifier : undefined;
  if (event.pid === data?.pid && bundleIdentifier === data?.bundleIdentifier) return null;
  return { target: "application", pid: event.pid, ...(bundleIdentifier ? { bundleIdentifier } : {}),
    ...(typeof event.executable === "string" && path.isAbsolute(event.executable) ? { executablePath: event.executable } : {}),
    ...(validName(event.name) ? { applicationName: event.name } : {}) };
}

// Session events and errors go to the launcher's log, never a per-entry file.
// Standard input stays open: its end tells the helper that MacLauncher quit.
function watch(child, { logger = console, onEvent, timeout = HEARTBEAT_TIMEOUT_MS, now = () => Number(process.hrtime.bigint() / 1000000n) } = {}) {
  let last = now();
  for (const [stream, level] of [[child.stdout, "info"], [child.stderr, "warn"]]) {
    if (!stream) continue;
    readline.createInterface({ input: stream }).on("line", line => {
      last = now();
      if (!line.trim() || line === '{"event":"heartbeat"}') return;
      try { logger[level]?.(`[window graphics] ${line.slice(0, 2048)}`); } catch {}
      if (level !== "info" || !onEvent || !line.startsWith("{")) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
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

async function launch(entry, context = {}) {
  const data = entry.moduleData || {};
  if (data.target !== "display" && !(Number.isSafeInteger(data.pid) && data.pid > 0))
    throw new Error("Choose a running app in File > Apply Graphics To.");
  const helper = (context.windowGraphics || Applications.availability)({ root: context.graphicsRuntimeRoot });
  if (!helper.available) throw new Error("Window graphics are unavailable. " + helper.reason);
  (context.verifyFile || require("../shared/reshade/payload-verification").verifyFile)(helper.root, helper.row);
  // The helper loads the graphics library itself and owns every frame call.
  // Graphics preparation adds the plan, live controls and status channels.
  const child = await context.spawnDetachedChecked(helper.executable, helperArguments(entry, helper, context.runtimeSettings),
    { env: process.env, graphicsExecutable: null, stdio: ["pipe", "pipe", "pipe"] });
  let moduleData = entry.moduleData || {};
  watch(child, { logger: context.logger || console, onEvent: event => {
    const captured = capturedApplication(moduleData, event);
    if (!captured) return;
    moduleData = captured;
    context.onEntryChange?.({ moduleData: captured });
  } });
  if (entry.gameId) {
    sessions.set(entry.gameId, child);
    child.once?.("exit", () => { if (sessions.get(entry.gameId) === child) sessions.delete(entry.gameId); });
  }
  return child;
}

// Capture settings apply to a running session as an option line.
function runtimeSettingsChanged(entry, runtimeId, settings) {
  const child = runtimeId === "capture" && sessions.get(entry?.gameId);
  if (!child?.stdin?.writable) return false;
  child.stdin.write(JSON.stringify({ cursor: settings?.captureCursor === true, scaled: settings?.output === "scaled" }) + "\n");
  return true;
}

// Scaled output forwards the pointer with posted events, which need the
// Accessibility permission. Choosing Scaled asks for it through the system
// prompt; until it is granted, the setting stays In place.
function reviewRuntimeSettings(runtimeId, next, previous, { systemPreferences } = {}) {
  if (runtimeId !== "capture" || next?.output !== "scaled" || previous?.output === "scaled") return next;
  if (systemPreferences?.isTrustedAccessibilityClient?.(true) === true) return next;
  return { ...next, output: "inPlace" };
}

// A library game whose own process refuses the graphics library can still
// receive graphics: this helper waits for the game's window, offers the
// picker for it and presents a processed copy over it. Null when the graphics
// package or this Mac cannot capture windows.
function captureCompanion(library, { availability = Applications.availability, verifyFile, spawn = require("node:child_process").spawn,
  logger = console } = {}) {
  if (typeof library !== "string" || !path.isAbsolute(library)) return null;
  const helper = availability({ root: path.dirname(library) });
  if (!helper.available) return null;
  return {
    start(pid, environment) {
      (verifyFile || require("../shared/reshade/payload-verification").verifyFile)(helper.root, helper.row);
      const child = spawn(helper.executable, ["--pid", String(pid), "--wait-window", String(COMPANION_WAIT_SECONDS), "--owner-only", "--library", library],
        { env: environment, stdio: ["pipe", "pipe", "pipe"] });
      child.once?.("error", error => logger.warn?.("[window graphics] The capture companion could not start:", error.message));
      return watch(child, { logger });
    }
  };
}

module.exports = {
  HEARTBEAT_TIMEOUT_MS, launch, helperArguments, watch, capturedApplication, runtimeSettingsChanged, reviewRuntimeSettings, captureCompanion
};
