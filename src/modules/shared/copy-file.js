const fs = require("node:fs"), path = require("node:path");
const ChildProcess = require("node:child_process");

// Wait for close, including after cancellation, before removing a partial copy.
function nativeCopy(source, destination, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn("/bin/cp", ["-c", source, destination], { stdio: ["ignore", "ignore", "pipe"] });
    let failure, stderr = "";
    const abort = () => child.kill("SIGTERM");
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-2048); });
    child.once("error", error => { failure = error; });
    child.once("close", (code, exitSignal) => {
      signal?.removeEventListener("abort", abort);
      try { signal?.throwIfAborted(); }
      catch (error) { reject(error); return; }
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error("The file could not be copied."), {
        code: "COPY_FAILED", exitCode: code, exitSignal, stderr
      }));
      else resolve();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function copyFileExclusive(source, destination, { signal, mode, validate } = {}) {
  signal?.throwIfAborted();
  source = path.resolve(source); destination = path.resolve(destination);
  try {
    await fs.promises.lstat(destination);
    throw Object.assign(new Error("The destination already exists."), { code: "EEXIST", path: destination });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const original = await fs.promises.stat(source);
  if (!original.isFile()) throw Object.assign(new Error("The source must be a regular file."), { code: "EINVAL" });
  const directory = await fs.promises.mkdtemp(path.join(path.dirname(destination), ".copy-"));
  const staged = path.join(directory, "file");
  let published = false, copied;
  try {
    signal?.throwIfAborted();
    // cp invokes native clonefile on macOS and falls back to copyfile when the
    // filesystem cannot clone. Node's clone request remains suitable elsewhere.
    if (process.platform === "darwin") await nativeCopy(source, staged, signal);
    else await fs.promises.copyFile(source, staged, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    signal?.throwIfAborted();
    copied = await fs.promises.lstat(staged);
    if (!copied.isFile() || original.dev === copied.dev && original.ino === copied.ino)
      throw new Error("The copied file must have an independent file identity.");
    await fs.promises.chmod(staged, mode ?? original.mode & 0o777);
    await validate?.(staged);
    signal?.throwIfAborted();
    await fs.promises.link(staged, destination);
    published = true;
    signal?.throwIfAborted();
  } catch (error) {
    if (published) {
      const current = await fs.promises.lstat(destination).catch(() => null);
      if (current?.dev === copied.dev && current?.ino === copied.ino) await fs.promises.unlink(destination);
    }
    throw error;
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

module.exports = { copyFileExclusive };
