const retirements = new WeakMap();

export const processRunning = child => child && child.pid && child.exitCode == null && child.signalCode == null;

/** Optional observation retains the original operation and rejection. */
export function observeRetirement(phase, operation, observer) {
  if (typeof observer !== 'function') return operation;
  const report = state => {
    try { void Promise.resolve(observer({ phase, state })).catch(() => {}); } catch {}
  };
  return async () => {
    report('started');
    try { const value = await operation(); report('fulfilled'); return value; }
    catch (error) { report('rejected'); throw error; }
  };
}

export function waitForExit(child, milliseconds) {
  if (!processRunning(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      child.removeListener('exit', done);
      child.removeListener('close', done);
      resolve(!processRunning(child));
    };
    child.once('exit', done);
    child.once('close', done);
    timer = setTimeout(done, milliseconds);
    if (!processRunning(child)) done();
  });
}

function signalProcess(child, signal, group) {
  if (!processRunning(child)) return;
  let failure;
  if (group) try { process.kill(-child.pid, signal); return; }
  catch (error) { failure = error; }
  if (processRunning(child)) try {
    if (child.kill(signal) === false) return failure || Error('Android process signal was not delivered.');
  } catch (error) { return error; }
}

/** Runtime files and descriptors outlive every process that can write them.
 * A successful kill request alone does not establish process retirement. */
export function stopProcess(child, { graceMs = 2000, killMs = 2000, initialSignal = 'SIGTERM', group = true } = {}) {
  if (!processRunning(child)) return Promise.resolve();
  const existing = retirements.get(child);
  if (existing) return existing;
  const retired = (async () => {
    let failure = initialSignal ? signalProcess(child, initialSignal, group) : undefined;
    if (await waitForExit(child, graceMs)) return;
    failure = signalProcess(child, 'SIGKILL', group) || failure;
    if (!await waitForExit(child, killMs)) throw Object.assign(
      Error('Android process did not exit.', failure ? {cause: failure} : undefined), {pid: child.pid});
  })();
  retirements.set(child, retired);
  return retired;
}

/** Every independent owned closer runs, while the first failure stays intact. */
export async function retireAll(operations) {
  let failed = false, failure;
  for (const operation of operations) try { await operation(); }
  catch (error) { if (!failed) { failed = true; failure = error; } }
  if (failed) throw failure;
}

export async function stopProcesses(children, options) {
  const outcomes = await Promise.allSettled([...new Set(children)].map(child => stopProcess(child, options)));
  const failed = outcomes.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Failed signaling is not permission to release files still in use. */
export function requireRetired(children) {
  const pids = [...new Set(children)].filter(processRunning).map(child => child.pid);
  if (pids.length) throw Object.assign(Error('Android processes are still running.'), {pids});
}
