/** Stop an owned game process without assuming it started a process group. */
function stopProcessTree(pid, { kill = process.kill.bind(process), schedule = setTimeout, graceMs = 2000 } = {}) {
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

module.exports = { stopProcessTree };
