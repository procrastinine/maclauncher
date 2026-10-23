// Native process completion is independent of the Electron host. A process may
// already have exited when its descriptor arrives from a backend worker.
const COMPLETION_DIAGNOSTIC_WAIT_MS = 1500;
function observeGameProcess(child, { isStopping = () => false, onExit, onFailure, onComplete } = {}) {
  let finished = false, reported = false, result, diagnosticTimer;
  function report() {
    if (!result || reported) return;
    reported = true;
    clearTimeout(diagnosticTimer);
    child.removeListener("diagnostics", diagnosed);
    const diagnostics = child.completionDiagnostics;
    // An owned native close notification can drain just after the exit event.
    result.stopped ||= isStopping();
    if (diagnostics?.message) result.diagnostics = diagnostics;
    try {
      if (!result.stopped && (result.error || result.signal || (result.code != null && result.code !== 0) || diagnostics?.message))
        onFailure?.(result);
    } finally { onComplete?.(result); }
  }
  const diagnosed = () => report();
  function finish(code, signal, error) {
    if (finished) return;
    finished = true;
    child.removeListener("exit", exited);
    child.removeListener("error", failed);
    result = { code: code ?? null, signal: signal ?? null, stopped: isStopping(), ...(error ? { error } : {}) };
    onExit?.(result);
    if (!result.stopped && child.completionDiagnostics?.pending === true) {
      // Running state clears at exit; only the optional failure detail waits
      // for the runtime's pipe drain. Bound lost/unsupported completion IPC.
      diagnosticTimer = setTimeout(report, COMPLETION_DIAGNOSTIC_WAIT_MS);
      diagnosticTimer.unref?.();
    } else report();
  }
  const exited = (code, signal) => finish(code, signal);
  const failed = error => finish(null, null, error);
  child.once("exit", exited);
  child.once("error", failed);
  child.on("diagnostics", diagnosed);
  if (child.exitCode != null || child.signalCode != null) {
    queueMicrotask(() => finish(child.exitCode, child.signalCode));
  }
}

module.exports = { observeGameProcess, COMPLETION_DIAGNOSTIC_WAIT_MS };
