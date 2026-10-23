const { spawn } = require("node:child_process");

// These are data-reading native helpers. The Windows installer is always an
// argument, never a command. Drained/capped output and asynchronous spawn keep
// installer work outside both Electron and the worker's request loop.
function runHelper(executable, args, { signal, timeout = 15000, maximum = 32 * 1024 * 1024, cwd, onSpawn } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(DYLD_|Malloc)/.test(key)) delete env[key];
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false });
    const stdout = [], stderr = []; let outBytes = 0, error, killTimer;
    const fail = value => {
      if (error) return;
      error = value; child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); killTimer.unref();
    };
    const abort = () => fail(Object.assign(new Error("Import cancelled."), { name: "AbortError", code: "ABORT_ERR" }));
    const timer = setTimeout(() => fail(new Error("The installer helper timed out.")), timeout); timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", bytes => {
      if ((outBytes += bytes.length) > maximum) fail(new Error("Installer metadata exceeds its limit."));
      else stdout.push(bytes);
    });
    let errBytes = 0;
    child.stderr.on("data", bytes => { if ((errBytes += bytes.length) <= 64 * 1024) stderr.push(bytes); });
    child.on("error", value => { error ||= value; });
    child.on("spawn", () => onSpawn?.({ pid: child.pid, executable, args, startedAt: new Date().toISOString() }));
    child.on("close", (code, termSignal) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      const result = { pid: child.pid, code, signal: termSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (error) reject(error);
      else if (code !== 0) reject(Object.assign(new Error("Could not read the installer data. " + result.stderr.replace(/[\x00-\x08\x0b-\x1f]/g, "").trim().slice(0, 1500)), { code: "INSTALLER_HELPER", result }));
      else resolve(result);
    });
  });
}

module.exports = { runHelper };
