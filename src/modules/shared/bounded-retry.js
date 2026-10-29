// Bounded re-evaluation of state that is not readable or settled yet when an
// event happens, such as a launch binding that records its PID after the
// process is registered. Timers are read from `timers` when used (the caller's
// realm by default).
//
// `create` schedules re-reads per key: each key runs at most one schedule.
// `attempt` re-reads the state and returns (or resolves to) true once it is
// settled; after the last delay `exhausted` runs once and the state is read
// again only on demand.
function create({delays, timers = globalThis}) {
  const runs = new Map();
  function stop(key) {
    const run = runs.get(key);if (!run) return;
    runs.delete(key);run.stopped = true;if (run.timer !== undefined) timers.clearTimeout(run.timer);
  }
  function start(key, attempt, exhausted) {
    if (runs.has(key)) return false;
    const run = {stopped: false, timer: undefined};runs.set(key, run);
    const next = (index, settled) => {
      if (run.stopped) return;
      if (settled || index + 1 >= delays.length) {runs.delete(key);if (!settled) exhausted?.();return;}
      step(index + 1);
    };
    const step = index => {
      run.timer = timers.setTimeout(() => {
        run.timer = undefined;
        let result;
        try { result = attempt(index); } catch { result = true; }
        if (typeof result?.then === "function") result.then(value => next(index, value === true), () => next(index, true));
        else next(index, result === true);
      }, delays[index]);
      run.timer?.unref?.();
    };
    step(0);
    return true;
  }
  return {start, stop, has: key => runs.has(key)};
}
// The same schedule inside one asynchronous operation: after an unsettled
// `result`, wait each delay in turn and attempt again until `settled(result)`.
// Returns the last result; an aborted signal ends the wait with its reason.
async function until(result, attempt, {delays, settled, signal, timers = globalThis}) {
  for (let index = 0; index < delays.length && !settled(result); index++) {
    await wait(delays[index], signal, timers);
    result = await attempt(index);
  }
  return result;
}
function wait(ms, signal, timers) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(signal.reason);return;}
    const stop = () => {timers.clearTimeout(timer);reject(signal.reason);};
    const timer = timers.setTimeout(() => {signal?.removeEventListener("abort", stop);resolve();}, ms);
    signal?.addEventListener("abort", stop, {once: true});
  });
}
module.exports = {create, until};
