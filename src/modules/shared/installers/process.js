const { spawn } = require("node:child_process");

// These are data-reading native helpers. The Windows installer is always an
// argument, never a command. Drained/capped output and asynchronous spawn keep
// installer work outside both Electron and the worker's request loop.
function runHelper(executable, args, { signal, timeout = 15000, maximum = 32 * 1024 * 1024, cwd, onSpawn, env: suppliedEnvironment, environmentOnly = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = environmentOnly ? { ...suppliedEnvironment } : { ...process.env, ...suppliedEnvironment };
    for (const key of Object.keys(env)) if (/^(DYLD_|Malloc)/.test(key) && !suppliedEnvironment?.[key]) delete env[key];
    // A wrapper can exit while one of its children still holds the pipes.
    // Give this helper its own group so cancellation reaches those children.
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    const stdout = [], stderr = []; let outBytes = 0, error, killTimer, ownership = Promise.resolve(), closed = false, settled = false;
    const stop = value => {
      if (grouped && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, value); return; } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
      }
      try { child.kill(value); } catch {}
    };
    const fail = value => {
      if (error) return;
      error = value;
      if (closed) return;
      stop("SIGTERM");
      killTimer = setTimeout(() => {
        stop("SIGKILL");
        child.stdout.destroy(); child.stderr.destroy();
        // Close can wait indefinitely on inherited pipes, even after the
        // wrapper exits. A failed helper must still let its owner clean up.
        finish(child.exitCode ?? null, null);
      }, 1500); killTimer.unref();
    };
    const abort = () => fail(Object.assign(new Error("Import cancelled."), { name: "AbortError", code: "ABORT_ERR" }));
    const timer = setTimeout(() => fail(new Error("The installer helper timed out.")), timeout); timer.unref();
    async function finish(code, termSignal) {
      if (settled) return;
      settled = true; closed = true;
      await ownership;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      const result = { pid: child.pid, code, signal: termSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (error) reject(error);
      else if (code !== 0) reject(Object.assign(new Error("Could not read the installer data. " + result.stderr.replace(/[\x00-\x08\x0b-\x1f]/g, "").trim().slice(0, 1500)), { code: "INSTALLER_HELPER", result }));
      else resolve(result);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", bytes => {
      if ((outBytes += bytes.length) > maximum) fail(new Error("Installer metadata exceeds its limit."));
      else stdout.push(bytes);
    });
    let errBytes = 0;
    child.stderr.on("data", bytes => { if ((errBytes += bytes.length) <= 64 * 1024) stderr.push(bytes); });
    child.on("error", fail);
    child.on("spawn", () => { ownership = Promise.resolve().then(() => onSpawn?.({ pid: child.pid, executable, args, startedAt: new Date().toISOString() })).catch(fail); });
    child.on("close", (code, termSignal) => { closed = true; finish(code, termSignal); });
  });
}

module.exports = { runHelper };
