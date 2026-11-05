// Wine on macOS 14 and later activates cooperatively: before a Wine process
// activates itself it posts WineAppWillActivateNotification, and the active
// application is expected to yield (as other Wine processes and CrossOver do).
// While a game launched here runs, the launcher answers that request for the
// game's own processes only, so the game window becomes the active application
// when it opens instead of drawing and taking input while another app is active.
const ProcessTree = require("../../../core/process-tree");
const NativeFocus = require("./native-focus");

const NOTIFICATION = "WineAppWillActivateNotification";

function activatingPid(userInfo) {
  const pid = Number(userInfo?.ActivatingAppPID);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Answers Wine activation requests from descendants of `child` until it exits.
 * Returns a function that stops observing.
 */
function followWineActivation(child, context, { list = ProcessTree.list, focus = NativeFocus.focusOwnedProcess,
  platform = process.platform, launcherPid = process.pid, now = Date.now } = {}) {
  const center = context?.ui?.systemPreferences;
  if (platform !== "darwin" || !Number.isSafeInteger(child?.pid) || child.pid <= 0 || child.exitCode != null || child.signalCode != null ||
      typeof center?.subscribeNotification !== "function" || typeof center?.unsubscribeNotification !== "function") return () => {};
  const launchedAt = now(), controller = new AbortController(), pending = new Set();
  let subscription = null;
  const running = () => !controller.signal.aborted && child.exitCode == null && child.signalCode == null;
  const answer = async pid => {
    // The PID comes from a system-wide notification. Only a process started by
    // this launch, matched against the live process table, is activated.
    const owned = ProcessTree.descendants(child.pid, await list(), Infinity);
    if (!running() || pid === child.pid || !owned.has(pid)) return;
    await focus(pid, { launchedAt, yieldFrom: launcherPid, signal: controller.signal, logger: context.logger, platform });
  };
  const stop = () => {
    controller.abort();
    child.removeListener?.("exit", stop);
    if (subscription == null) return;
    const id = subscription;
    subscription = null;
    try { center.unsubscribeNotification(id); } catch {}
  };
  try {
    subscription = center.subscribeNotification(NOTIFICATION, (_event, userInfo) => {
      const pid = activatingPid(userInfo);
      if (!pid || pending.has(pid) || !running()) return;
      pending.add(pid);
      void answer(pid).catch(error => {
        try { context.logger?.warn?.(`[runtime] Wine activation: ${error.message}`); } catch {}
      }).finally(() => pending.delete(pid));
    });
  } catch (error) {
    try { context.logger?.warn?.(`[runtime] Wine activation: ${error.message}`); } catch {}
    return () => {};
  }
  child.once?.("exit", stop);
  return stop;
}

module.exports = { NOTIFICATION, activatingPid, followWineActivation };
