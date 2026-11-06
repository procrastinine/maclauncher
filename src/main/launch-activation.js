const path = require('node:path');
const ProcessTree = require('../core/process-tree');

/** One initial handoff requested by a launched runtime, never a focus watchdog. */
async function followProcessActivation({ pid, notification, pidKey }, { signal } = {}, {
  systemPreferences, logger, platform = process.platform, list = ProcessTree.list,
  native = () => require(path.join(process.resourcesPath || path.resolve(__dirname, '../resources'), 'launch-activation.node'))
} = {}) {
  if (platform !== 'darwin' || signal?.aborted) return { reason: 'unavailable' };
  let helper;
  try { helper = native(); }
  catch (error) { logger?.warn?.('[runtime] launch activation: ' + error.message); return { reason: 'unavailable' }; }
  if (!helper.inspect(0).active) return { reason: 'launcher-inactive' };
  return new Promise(resolve => {
    let subscription, timer, expiry, pending = false, finished = false;
    const stop = result => {
      if (finished) return;
      finished = true;clearTimeout(timer);clearTimeout(expiry);
      signal?.removeEventListener('abort', abort);
      if (subscription != null) systemPreferences.unsubscribeNotification(subscription);
      logger?.debug?.('[runtime] initial window activation', { pid, ...result });
      resolve(result);
    };
    const abort = () => stop({ reason: 'launch-ended' });
    const answer = async target => {
      const owned = ProcessTree.descendants(pid, await list(), Infinity);
      if (finished || !owned.has(target) || target === pid) { pending = false;return; }
      const started = Date.now();
      let yieldedAt = null;
      const activate = () => {
        if (finished) return;
        const state = helper.inspect(target);
        if (state.frontmostPid === target && state.frontWindowPid === target && state.windowId)
          return stop({ reason: yieldedAt === null ? 'already-frontmost' : 'activated', target, windowId: state.windowId });
        if (yieldedAt !== null) {
          if (Date.now() - yieldedAt >= 2000) return stop({ reason: 'activation-unconfirmed', target, windowId: state.windowId });
          timer = setTimeout(activate, 50);return;
        }
        if (!state.active) return stop({ reason: 'foreground-changed' });
        if (state.windowId) {
          const result = helper.yield(target);
          if (!result.yielded) return stop({ reason: 'activation-refused', target, windowId: result.windowId });
          yieldedAt = Date.now();timer = setTimeout(activate, 50);return;
        }
        if (Date.now() - started < 10000) timer = setTimeout(activate, 50);
        else pending = false;
      };
      activate();
    };
    subscription = systemPreferences.subscribeNotification(notification, (_event, info) => {
      const target = Number(info?.[pidKey]);
      if (finished || pending || !Number.isSafeInteger(target) || target <= 0) return;
      pending = true;
      void answer(target).catch(error => stop({ reason: error.message }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    expiry = setTimeout(() => stop({ reason: 'window-unavailable' }), 120000);
    expiry.unref?.();
    if (signal?.aborted) abort();
  });
}
module.exports = { followProcessActivation };
