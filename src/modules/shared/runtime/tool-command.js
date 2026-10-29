const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createAbortError, throwIfAborted } = require("./download-utils");
const MAX_LOG_BYTES = 8 * 1024 * 1024;

function rotateLog(logPath) {
  let size;
  try { size = fs.statSync(logPath).size; } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (size < MAX_LOG_BYTES) return;
  const previous = logPath + ".previous";
  fs.renameSync(logPath, previous);
  if (size <= MAX_LOG_BYTES) return;
  const fd = fs.openSync(previous, "r+");
  try {
    const tail = Buffer.alloc(MAX_LOG_BYTES);
    const count = fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    fs.writeSync(fd, tail, 0, count, 0);
    fs.ftruncateSync(fd, count);
  } finally { fs.closeSync(fd); }
}

// Managed exports have their own process lifecycle; native build recipes are independent.
async function runToolCommand(command, args, { cwd, logPath, env, signal, timeout = 300000, onSpawn } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    // Several commands may share an export log. Retain that history up to the
    // output limit, then replace one previous log rather than append forever.
    rotateLog(logPath);
    const fd = fs.openSync(logPath, "a"); fs.writeSync(fd, "$ " + command + " " + args.join(" ") + "\n");
    let child;
    const grouped = process.platform !== "win32";
    try { child = spawn(command, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { fs.closeSync(fd); reject(error); return; }
    let bytes = 0, tail = "", settled = false, stopped = false, timedOut = false, bindingError, force;
    const record = data => {
      if (settled) return;
      tail = (tail + data.toString()).slice(-2048);
      if (bytes < MAX_LOG_BYTES) { const chunk = data.subarray(0, MAX_LOG_BYTES - bytes); fs.writeSync(fd, chunk); bytes += chunk.length; }
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
      if (failure) { failure.exitCode = code; failure.exitSignal = exitSignal; reject(failure); } else resolve();
    };
    child.stdout.on("data", record); child.stderr.on("data", record);
    child.once("error", error => finish(error)); child.once("close", (code, exitSignal) => finish(null, code, exitSignal));
    signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
  });
}
module.exports = { runToolCommand };
