const fs = require("node:fs"), path = require("node:path");
const Writable = require("../shared/writable-input");
const {boundedLog} = require("../shared/runtime/bounded-log");

// Preserve startup output and a bounded recent tail independently of the
// controller's exit event: inherited pipes can drain after that event.
function captureRuntimeOutput(directory, logger) {
  Writable.assertOwnDirectory(directory, directory, {create: false});
  const file = path.join(directory, "runtime.log");
  fs.rmSync(file + ".previous", {force: true});
  const log = boundedLog(file, {limit: 512 * 1024, headLimit: 64 * 1024});
  let child, complete = false, logClosed = false, drainTimer, terminal;
  let stdoutTail = Buffer.alloc(0), stderrTail = Buffer.alloc(0);
  const retain = (tail, bytes) => bytes.length >= 8192 ? Buffer.from(bytes.subarray(bytes.length - 8192)) :
    Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - 8192)), bytes]);
  const closeLog = () => {
    if (logClosed) return;
    logClosed = true;
    try { log.close(); } catch (error) { logger?.warn?.("[android] Cannot close runtime details: " + error.message); }
  };
  const write = (chunk, stderr) => {
    if (complete) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stderr) stderrTail = retain(stderrTail, bytes); else stdoutTail = retain(stdoutTail, bytes);
    if (!logClosed) try { log.write(bytes); }
    catch (error) { logger?.warn?.("[android] Cannot save runtime details: " + error.message); closeLog(); }
  };
  const stdout = chunk => write(chunk, false), stderr = chunk => write(chunk, true);
  const streamError = error => stderr("\nRuntime output could not be read: " + error.message + "\n");
  function finish(code = terminal?.code, signal = terminal?.signal, error = terminal?.error) {
    if (complete) return;
    complete = true; clearTimeout(drainTimer);
    child?.stdout?.removeListener?.("data", stdout); child?.stderr?.removeListener?.("data", stderr);
    child?.stdout?.removeListener?.("error", streamError); child?.stderr?.removeListener?.("error", streamError);
    child?.removeListener?.("exit", exited); child?.removeListener?.("close", finish); child?.removeListener?.("error", failed);
    closeLog();
    if (!child) return;
    const failedExit = Boolean(error || signal || code != null && code !== 0);
    const message = (stderrTail.length ? stderrTail : stdoutTail).toString("utf8")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(-2048);
    child.completionDiagnostics = {pending: false, logFile: file,
      ...(failedExit && (message || error?.message) ? {message: message || String(error.message).slice(0, 2048)} : {})};
    child.stdout?.destroy?.(); child.stderr?.destroy?.();
    stdoutTail = stderrTail = Buffer.alloc(0);
    child.emit?.("diagnostics");
  }
  function exited(code, signal, error) {
    terminal = {code, signal, error};
    if (!child.stdout && !child.stderr) return finish();
    if (!drainTimer) { drainTimer = setTimeout(() => finish(), 1000); drainTimer.unref?.(); }
  }
  function failed(error) { exited(child?.exitCode, child?.signalCode, error); }
  return {
    attach(process) {
      if (child || complete) return;
      child = process;
      child.completionDiagnostics = {pending: true, logFile: file};
      child.stdout?.on?.("data", stdout); child.stderr?.on?.("data", stderr);
      child.stdout?.on?.("error", streamError); child.stderr?.on?.("error", streamError);
      child.once?.("exit", exited); child.once?.("close", finish); child.once?.("error", failed);
      child.stdout?.unref?.(); child.stderr?.unref?.();
      if (child.exitCode != null || child.signalCode != null) exited(child.exitCode, child.signalCode);
    },
    close: error => finish(child?.exitCode, child?.signalCode, error)
  };
}

module.exports = {captureRuntimeOutput};
