const fs = require("node:fs"), { spawn } = require("node:child_process");

/** Kernel ownership spans backend workers and independent launch controllers. */
async function acquireFileLock(file, {wait = true, signal} = {}) {
  signal?.throwIfAborted();
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077))
      throw Error("Shared package storage is not private.");
  } finally { fs.closeSync(fd); }
  // The holder exits on stdin EOF even after its requesting worker dies. Keep
  // the lock inode: unlinking it would allow two independent kernel owners.
  // The kernel holder needs only a ready marker and stdin-EOF lifetime. Use
  // the system shell's builtins rather than starting a JS VM for every source
  // lease; app enumeration and retirement can contain hundreds of these.
  const holder = spawn("/usr/bin/lockf", ["-k", ...(!wait ? ["-t", "0"] : []), file, "/bin/sh", "-c",
    'printf "ready\\n"; while IFS= read -r line; do :; done'],
  { stdio: ["pipe", "pipe", "pipe"] });
  const cancel = () => holder.kill("SIGTERM");
  signal?.addEventListener("abort",cancel,{once:true});
  let detail = "";
  holder.stderr.on("data", bytes => { detail = (detail + bytes).slice(-2048); });
  holder.stdin.on("error", () => {});
  const closed = new Promise(resolve => { holder.once("close", resolve); holder.once("error", resolve); });
  try {
    const acquired = await new Promise((resolve, reject) => {
      let output = "";
      holder.stdout.on("data", bytes => { output += bytes; if (output.includes("ready\n")) resolve(true); });
      holder.once("error", reject);
      holder.once("close", code => signal?.aborted ? reject(signal.reason) : !wait && code === 75 ? resolve(false) : reject(Error("Shared package lock exited (" + code + "): " + detail)));
    });
    signal?.removeEventListener("abort",cancel);
    if (!acquired) { holder.stdin.end(); await closed; return null; }
    return async () => { holder.stdin.end(); await closed; };
  } catch (error) { signal?.removeEventListener("abort",cancel); holder.stdin.end(); await closed; throw error; }
}
async function withFileLock(file, update) {
  const release = await acquireFileLock(file);
  // Ownership covers the operation's completion, including asynchronous
  // package preparation. EOF releases the kernel lock after either outcome.
  try { return await update(); } finally { await release(); }
}
module.exports = { withFileLock, acquireFileLock };
