const DEFAULT_GRACE_MS = 2000;
const TEMPORARY_PROCESS_MAX_GRACE_MS = 15000;
// A native application may already have received its normal Quit event.
// Escalation must not inject a second, concurrent SIGTERM shutdown path.
function forceStopProcessTree(pid, {kill = process.kill.bind(process), isCurrent = () => true} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isCurrent()) return false;
  try {kill(-pid, "SIGKILL");return true;}
  catch {
    if (!isCurrent()) return false;
    try {kill(pid, "SIGKILL");return true;} catch {return false;}
  }
}
function normalizeShutdownGraceMs(value) {
  return Number.isSafeInteger(value) && value >= DEFAULT_GRACE_MS && value <= TEMPORARY_PROCESS_MAX_GRACE_MS ? value : DEFAULT_GRACE_MS;
}
/** Stop an owned game process without assuming it started a process group. */
function stopProcessTree(pid, { kill = process.kill.bind(process), schedule = setTimeout, graceMs = DEFAULT_GRACE_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  let target = -pid;
  try { kill(target, "SIGTERM"); }
  catch {
    // Piped debugger/tool processes intentionally share the host's group.
    // A missing group is not evidence that the owned child has exited.
    target = pid;
    try { kill(target, "SIGTERM"); }
    catch { return false; }
  }
  const timer = schedule(() => {
    try { kill(target, 0); }
    catch { return; }
    try { kill(target, "SIGKILL"); }
    catch {}
  }, graceMs);
  timer?.unref?.();
  return true;
}

module.exports = { stopProcessTree, forceStopProcessTree, normalizeShutdownGraceMs, TEMPORARY_PROCESS_MAX_GRACE_MS };
