const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createAbortError, throwIfAborted } = require("./download-utils");

// Managed exports have their own process lifecycle; native build recipes are independent.
async function runToolCommand(command, args, { cwd, logPath, env, signal, timeout = 300000, onSpawn } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logPath, "a"); fs.writeSync(fd, "$ " + command + " " + args.join(" ") + "\n");
    let child;
    const grouped = process.platform !== "win32";
    try { child = spawn(command, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { fs.closeSync(fd); reject(error); return; }
    let bytes = 0, tail = "", settled = false, stopped = false, timedOut = false, bindingError, force;
    const record = data => {
      if (settled) return;
      tail = (tail + data.toString()).slice(-2048);
      if (bytes < 8 * 1024 * 1024) { const chunk = data.subarray(0, 8 * 1024 * 1024 - bytes); fs.writeSync(fd, chunk); bytes += chunk.length; }
    };
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {}
      force = setTimeout(() => {
        try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
      }, 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const ownership = Promise.resolve().then(() => child.pid && onSpawn?.(child)).catch(error => { bindingError = error; stop(); });
    const finish = async (error, code, exitSignal) => {
      if (settled) return;
      settled = true;
      await ownership; clearTimeout(timer); clearTimeout(force); signal?.removeEventListener("abort", stop); fs.closeSync(fd);
      const failure = error || bindingError || (signal?.aborted ? createAbortError()
        : timedOut ? new Error("The tool timed out. See " + logPath + ".")
        : code === 0 ? null : new Error("The tool exited " + (exitSignal || code) + ". See " + logPath + ".\n" + tail));
      if (failure) reject(failure); else resolve();
    };
    child.stdout.on("data", record); child.stderr.on("data", record);
    child.once("error", error => finish(error)); child.once("close", (code, exitSignal) => finish(null, code, exitSignal));
    signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
  });
}
module.exports = { runToolCommand };
