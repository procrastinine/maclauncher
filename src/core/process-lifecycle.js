const { randomUUID } = require("node:crypto");
const { stopProcessTree } = require("./process-stop");

const owners = new WeakMap();

/** Bind cleanup to this ChildProcess incarnation, never to a reusable PID alone. */
function bindProcessStop(child, stop, { token = randomUUID() } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0 || typeof stop !== "function")
    throw new TypeError("Runtime Stop requires an owned process and callback.");
  if (owners.has(child)) return child;
  const owner = { pid: child.pid, token, stop, pending: null, settled: false };
  owners.set(child, owner);
  child.requestStop = options => requestProcessStop(child, options);
  return child;
}

function processStopBinding(child) {
  const owner = owners.get(child);
  return owner && child.pid === owner.pid ? { token: owner.token, pending: Boolean(owner.pending && !owner.settled) } : null;
}

function requestProcessStop(child, { isCurrent = () => true, fallback = stopProcessTree } = {}) {
  if (!child || !isCurrent()) return Promise.resolve(false);
  const owner = owners.get(child);
  if (owner) {
    if (child.pid !== owner.pid) return Promise.resolve(false);
    if (owner.pending) return owner.pending;
    child.stopRequested = true;
    // Publish the promise before invoking the callback. A synchronous exit
    // must retain this cleanup owner and its runtime/game leases.
    const current = () => owners.get(child) === owner && child.pid === owner.pid;
    owner.pending = Promise.resolve().then(() => current() ? owner.stop({ child, pid: owner.pid, isCurrent: current }) : false);
    owner.pending = owner.pending.then(value => value !== false).finally(() => {
      owner.settled = true;child.emit("runtimeStopFinished");
    });
    void owner.pending.catch(error => {child.runtimeStopError = error;child.emit("runtimeStopError", error);});
    child.emit("stopRequested");
    return owner.pending;
  }
  if (child.exitCode != null || child.signalCode != null || !Number.isSafeInteger(child.pid) || child.pid <= 0) return Promise.resolve(false);
  child.stopRequested = true;
  return Promise.resolve(fallback(child.pid));
}

/** Runtime teardown can outlive an ordinary root exit as well as explicit Stop.
 * Read it after all exit listeners have published their retirement promise. */
async function afterProcessStop(child, release) {
  await Promise.resolve();
  const pending = owners.get(child)?.pending, retirement = child?.runtimeRetirement;
  const settled = await Promise.allSettled([pending, retirement]);
  if (retirement && settled[1].status === "rejected") {
    // Failed retirement can leave real consumers. Their worker and runtime
    // leases remain owned; an exited root is not authority to remove them.
    const error = settled[1].reason;
    if (child.runtimeRetirementError !== error) {
      child.runtimeRetirementError = error;
      child.emit?.("runtimeRetirementError", error);
    }
    return false;
  }
  return release();
}

function waitForProcessStop(child) {return owners.get(child)?.pending || Promise.resolve();}

module.exports = { bindProcessStop, processStopBinding, requestProcessStop, afterProcessStop, waitForProcessStop };
