const {createRuntimeUseScope} = require("../core/coordinated-runtime-managers");
const {runtimeIdentity} = require("../core/runtime-coordinator");

// Models selected during play need the same removal protection as launch
// dependencies. The owning game session releases every added lease on exit.
function createGraphicsRuntimeUse({session, isCurrent, ...options}) {
  const retained = new Set(), identities = new Set(), transactions = new Set();
  let closed = false, releasing;
  const current = () => !closed && isCurrent();
  function begin({signal} = {}) {
    let scope, finished = false, releaseTask;
    const selected = new Set();
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (!current()) throw new Error("The game has stopped. Start it again to apply effects.");
      if (finished) throw new Error("Graphics resource preparation is already finished.");
    };
    const transaction = {
      async useRuntime(identity) {
        assertCurrent();
        const key = JSON.stringify(runtimeIdentity(identity));
        if (identities.has(key)) return;
        // No scope or coordinator work is needed for an edit without models.
        if (!scope) {
          const coordinator = options.coordinator;
          scope = createRuntimeUseScope({...options, coordinator: {...coordinator,
            acquireUse(...args) {
              signal?.throwIfAborted();
              const acquired = Promise.resolve(coordinator.acquireUse(...args));
              if (!signal) return acquired;
              return new Promise((resolve, reject) => {
                let abandoned = false;
                const abort = () => {abandoned = true;cleanup();reject(signal.reason);};
                const cleanup = () => signal.removeEventListener("abort", abort);
                signal.addEventListener("abort", abort, {once: true});
                acquired.then(token => {
                  cleanup();
                  // This is an unbound candidate, not GPU retirement. A writer
                  // can finish after Off; release that exact late lease without
                  // binding it to the game or touching accepted model leases.
                  if (abandoned || signal.aborted) {
                    void Promise.resolve(coordinator.release(token)).catch(() => {});
                    if (!abandoned) reject(signal.reason);
                  } else resolve(token);
                }, error => {cleanup();reject(error);});
                if (signal.aborted) abort();
              });
            }
          }});
        }
        await scope.useRuntime(identity);
        assertCurrent();
        await scope.bind(session.pid);
        assertCurrent();
        selected.add(key);
      },
      // Call synchronously before bytes can reach the game. A visible candidate
      // may still own asynchronous readers after compensation restores it.
      retain() {
        if (finished) return;
        finished = true;transactions.delete(transaction);
        if (scope) {retained.add(scope);for (const key of selected) identities.add(key);}
      },
      release() {
        if (finished && !releaseTask) return Promise.resolve();
        if (!releaseTask) {
          finished = true;transactions.delete(transaction);
          releaseTask = scope ? scope.release() : Promise.resolve();
        }
        return releaseTask;
      }
    };
    if (!current()) throw new Error("The game has stopped. Start it again to apply effects.");
    transactions.add(transaction);return transaction;
  }
  return {
    begin,
    async useRuntime(identity) {
      const transaction = begin();
      try {await transaction.useRuntime(identity);transaction.retain();}
      catch (error) {await transaction.release();throw error;}
    },
    release() {
      if (releasing) return releasing;
      closed = true;
      releasing = Promise.all([...transactions].map(transaction => transaction.release())
        .concat([...retained].map(scope => scope.release()))).then(() => {retained.clear();identities.clear();});
      return releasing;
    }
  };
}

module.exports = {createGraphicsRuntimeUse};
