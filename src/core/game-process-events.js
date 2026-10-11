// Native process completion is independent of the Electron host. A process may
// already have exited when its descriptor arrives from a backend worker.
function observeGameProcess(child, { isStopping = () => false, onExit, onFailure } = {}) {
  let finished = false;
  function finish(code, signal, error) {
    if (finished) return;
    finished = true;
    child.removeListener("exit", exited);
    child.removeListener("error", failed);
    const result = { code: code ?? null, signal: signal ?? null, stopped: isStopping(), ...(error ? { error } : {}) };
    onExit?.(result);
    if (!result.stopped && (error || result.signal || (result.code != null && result.code !== 0))) onFailure?.(result);
  }
  const exited = (code, signal) => finish(code, signal);
  const failed = error => finish(null, null, error);
  child.once("exit", exited);
  child.once("error", failed);
  if (child.exitCode != null || child.signalCode != null) {
    queueMicrotask(() => finish(child.exitCode, child.signalCode));
  }
}

module.exports = { observeGameProcess };
