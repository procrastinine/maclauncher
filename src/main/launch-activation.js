const path = require('node:path');
const ProcessTree = require('../core/process-tree');

/** One initial handoff requested by a launched runtime, never a focus watchdog. */
async function followProcessActivation({ pid, notification, pidKey }, { signal } = {}, {
  systemPreferences, logger, platform = process.platform, list = ProcessTree.list,
  native = () => require(path.join(process.resourcesPath || path.resolve(__dirname, '../resources'), 'launch-activation.node'))
} = {}) {
  const report = result => { logger?.debug?.('[runtime] initial window activation', { pid, ...result });return result; };
  if (platform !== 'darwin' || signal?.aborted)
    return report({ reason: 'unavailable', detail: signal?.aborted ? 'launch-ended' : 'unsupported-platform' });
  let helper;
  try {
    helper = native();
    if (!helper.inspect(0).active) return report({ reason: 'launcher-inactive' });
  } catch (error) { return report({ reason: 'unavailable', detail: error.message }); }
  return new Promise(resolve => {
    let subscription, expiry, activating = null, finished = false;
    const pending = new Set(), timers = new Set();
    const later = action => { const timer = setTimeout(() => { timers.delete(timer);action(); }, 50);timers.add(timer); };
    const stop = result => {
      if (finished) return;
      finished = true;for (const timer of timers) clearTimeout(timer);clearTimeout(expiry);
      signal?.removeEventListener('abort', abort);
      if (subscription != null) systemPreferences.unsubscribeNotification(subscription);
      resolve(report(result));
    };
    const abort = () => stop({ reason: 'launch-ended' });
    const answer = async target => {
      const owned = ProcessTree.descendants(pid, await list(), Infinity);
      if (finished || !owned.has(target) || target === pid) { pending.delete(target);return; }
      let yieldedAt = null;
      const activate = () => {
        if (finished || activating !== null && activating !== target) return;
        const state = helper.inspect(target);
        if (state.frontmostPid === target && state.frontWindowPid === target && state.windowId)
          return stop({ reason: yieldedAt === null ? 'already-frontmost' : 'activated', target, windowId: state.windowId });
        if (yieldedAt !== null) {
          if (Date.now() - yieldedAt >= 2000) return stop({ reason: 'activation-unconfirmed', target, windowId: state.windowId });
          later(activate);return;
        }
        if (!state.active) return stop({ reason: 'foreground-changed' });
        if (state.windowId) {
          const result = helper.yield(target);
          if (!result.yielded) return stop({ reason: 'activation-refused', target, windowId: result.windowId });
          activating = target;
          yieldedAt = Date.now();later(activate);return;
        }
        later(activate);
      };
      activate();
    };
    subscription = systemPreferences.subscribeNotification(notification, (_event, info) => {
      const target = Number(info?.[pidKey]);
      if (finished || pending.has(target) || !Number.isSafeInteger(target) || target <= 0) return;
      pending.add(target);
      void answer(target).catch(error => stop({ reason: error.message }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    expiry = setTimeout(() => stop({ reason: 'window-unavailable' }), 120000);
    expiry.unref?.();
    if (signal?.aborted) abort();
  });
}
module.exports = { followProcessActivation };
