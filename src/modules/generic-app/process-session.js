const { EventEmitter } = require("node:events");
const { execFile } = require("node:child_process");

// Signal 0 can still find a group containing only unreaped zombies. Read only
// that group's process states; an unavailable query leaves ownership unchanged.
function hasLiveGroupProcesses(pid, execute = execFile) {
  return new Promise(resolve => {
    try {
      execute("/bin/ps", ["-o", "stat=", "-g", String(pid)],
        { encoding: "utf8", timeout: 1500, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
          if (error && !(error.code === 1 && !stdout?.trim() && !stderr?.trim())) { resolve(null); return; }
          const states = String(stdout || "").trim().split(/\s+/).filter(Boolean);
          resolve(states.some(state => !state.startsWith("Z")));
        });
    } catch { resolve(null); }
  });
}

/**
 * Track a script launched in its own process group. A launcher may return while
 * its game continues in the background; its inherited group remains the owned
 * lifetime and Stop target. Processes that create a new session are not adopted.
 */
function trackScriptProcess(child, { pollIntervalMs = 250, kill = process.kill.bind(process),
  inspectProcesses = hasLiveGroupProcesses, zombieCheckIntervalMs = 5000 } = {}) {
  const session = new EventEmitter();
  for (const key of ["pid", "stdin", "stdout", "stderr", "stdio", "spawnfile", "spawnargs"])
    session[key] = child[key];
  session.exitCode = null;
  session.signalCode = null;
  session.killed = false;
  const terminated = child.exitCode != null || child.signalCode != null;
  const streams = child.stdio || [child.stdin, child.stdout, child.stderr];
  let status, closed = terminated && streams.every(stream => !stream || stream.closed === true);
  let finished = false, failed = false, closeEmitted = false, timer, referenced = true;
  let nextProcessCheck = Date.now() + Math.min(1000, zombieCheckIntervalMs);

  function cleanup() {
    clearTimeout(timer);
    timer = null;
    child.removeListener("spawn", spawned);
    child.removeListener("error", errored);
    child.removeListener("exit", exited);
    child.removeListener("close", close);
  }
  function groupExists() {
    if (!Number.isSafeInteger(session.pid) || session.pid <= 0) return false;
    try { kill(-session.pid, 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  }
  function emitClose(code, signal) {
    if (closeEmitted) return;
    closeEmitted = true;
    cleanup();
    session.emit("close", code, signal);
  }
  function finish() {
    if (finished || failed) return;
    finished = true;
    session.exitCode = status.code;
    session.signalCode = status.signal;
    // A ChildProcess emits exit before close, which also waits for its pipes.
    session.emit("exit", status.code, status.signal);
    if (closed) emitClose(status.code, status.signal);
  }
  function schedule() {
    if (finished || failed) return;
    timer = setTimeout(inspectGroup, pollIntervalMs);
    if (!referenced) timer.unref?.();
  }
  function inspectGroup() {
    timer = null;
    if (finished || failed || !status) return;
    if (!groupExists()) { finish(); return; }
    if (Date.now() >= nextProcessCheck) {
      nextProcessCheck = Date.now() + zombieCheckIntervalMs;
      Promise.resolve().then(() => inspectProcesses(session.pid)).then(live => {
        if (live === false) finish(); else schedule();
      }, schedule);
      return;
    }
    schedule();
  }
  function spawned() { session.emit("spawn"); }
  function errored(error) {
    if (!session.pid) { failed = true; clearTimeout(timer); timer = null; }
    session.emit("error", error);
  }
  function exited(code, signal) {
    if (status || failed) return;
    status = { code: code ?? null, signal: signal ?? null };
    inspectGroup();
  }
  function close(code, signal) {
    closed = true;
    if (!finished && !failed) return;
    emitClose(failed ? code : status.code, failed ? signal : status.signal);
  }
  session.kill = (signal = "SIGTERM") => {
    if (finished || failed || !Number.isSafeInteger(session.pid) || session.pid <= 0) return false;
    try {
      kill(-session.pid, signal);
      if (signal !== 0) session.killed = true;
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") session.emit("error", error);
      return false;
    }
  };
  session.ref = () => { referenced = true; child.ref?.(); timer?.ref?.(); return session; };
  session.unref = () => { referenced = false; child.unref?.(); timer?.unref?.(); return session; };
  child.on("spawn", spawned);
  child.on("error", errored);
  child.on("exit", exited);
  child.on("close", close);
  if (terminated)
    queueMicrotask(() => exited(child.exitCode, child.signalCode));
  return session;
}

module.exports = { trackScriptProcess, hasLiveGroupProcesses };
