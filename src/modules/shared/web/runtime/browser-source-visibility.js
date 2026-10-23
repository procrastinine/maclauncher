const warn = require("../../graphics-warning");

const PREFIX = "org.maclauncher.browser-frame-visibility.";

// The native capture owner reports visibility edges in this same process. No
// watcher, timer or renderer work is needed while the original window is used.
function attachBrowserSourceVisibility(win, {systemPreferences, environment = process.env,
  platform = process.platform, pid = process.pid, logger} = {}) {
  const token = environment?.RESHADE_BROWSER_FRAME_TOKEN;
  if (platform !== "darwin" || !environment?.RESHADE_BROWSER_FRAME_STATE ||
      !/^[a-f0-9]{32}$/.test(token || "") ||
      typeof systemPreferences?.subscribeLocalNotification !== "function" ||
      typeof systemPreferences?.unsubscribeLocalNotification !== "function") return () => {};
  let contents, nativeView;
  try {
    contents = win.webContents;
    if (typeof contents.getBackgroundThrottling !== "function" ||
        typeof contents.setBackgroundThrottling !== "function") return () => {};
    const handle = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length !== 8) return () => {};
    nativeView = handle.readBigUInt64LE().toString(16);
    if (nativeView === "0") return () => {};
  } catch { return () => {}; }
  const event = PREFIX + token;
  let subscription, disposed = false, active = false, lease = null;
  const alive = () => {
    try { return !win.isDestroyed() && !contents.isDestroyed(); } catch { return false; }
  };
  function restore() {
    const previous = lease;
    lease = null; // Foreign setters may synchronously publish another edge.
    if (!previous || !alive()) return;
    try {
      // A different current value belongs to the game, not this attachment.
      if (contents.getBackgroundThrottling() === false)
        contents.setBackgroundThrottling(previous.value);
    } catch (error) {
      warn(logger, "[graphics] Browser animation policy could not be restored.", error);
    }
  }
  function observe(name, value) {
    if (disposed || name !== event || value?.schema !== 1 || value.pid !== pid ||
        value.nativeView !== nativeView || typeof value.active !== "boolean" || !alive()) return;
    if (!value.active) { active = false; restore(); return; }
    if (active) return;
    active = true;
    try {
      const previous = contents.getBackgroundThrottling();
      if (previous !== true) return;
      // Record ownership before calling Electron: native notifications are
      // synchronous and can reenter during a visibility update.
      lease = {value: previous};
      contents.setBackgroundThrottling(false);
    } catch (error) {
      warn(logger, "[graphics] Browser animation policy could not be updated.", error);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { systemPreferences.unsubscribeLocalNotification(subscription); } catch {}
    win.removeListener("closed", dispose);
    restore();
  }
  try { subscription = systemPreferences.subscribeLocalNotification(event, observe); }
  catch { return () => {}; }
  win.once("closed", dispose);
  return dispose;
}

module.exports = {attachBrowserSourceVisibility, PREFIX};
