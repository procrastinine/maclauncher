const NOTIFICATION = 'WineAppWillActivateNotification';

// Wine requests cooperative activation before making its own Cocoa window key.
// The Electron main process must yield its actual NSApplication, not a helper's.
function followWineActivation(child, context, { platform = process.platform } = {}) {
  if (platform !== 'darwin' || !Number.isSafeInteger(child?.pid) || child.pid <= 0 || child.exitCode != null || child.signalCode != null ||
      typeof context?.ui?.followProcessActivation !== 'function') return () => {};
  const controller = new AbortController();
  const stop = () => controller.abort();
  child.once('exit', stop);
  context.signal?.addEventListener('abort', stop, { once: true });
  void context.ui.followProcessActivation({ pid: child.pid, notification: NOTIFICATION, pidKey: 'ActivatingAppPID' }, { signal: controller.signal })
    .catch(error => { if (!controller.signal.aborted) context.logger?.warn?.('[runtime] Wine activation: ' + error.message); })
    .finally(() => { child.removeListener('exit', stop);context.signal?.removeEventListener('abort', stop); });
  if (context.signal?.aborted) stop();
  return stop;
}
module.exports = { NOTIFICATION, followWineActivation };
