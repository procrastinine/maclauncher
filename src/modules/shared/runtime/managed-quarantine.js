const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { throwIfAborted } = require("./download-utils");

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function managedInstallRoot(install, userDataDir) {
  if (!install || install.readOnly === true || install.removable === false || install.source === "local" ||
    !path.isAbsolute(userDataDir || "")) return null;
  // Installation results are module-owned. Never accept a caller's path, an
  // external registration, the application's resources or an entire data root.
  const candidate = [install.installDir, install.root, install.appPath]
    .find(value => typeof value === "string" && path.isAbsolute(value));
  if (!candidate) return null;
  const runtimeRoot = path.join(path.resolve(userDataDir), "runtimes"), requested = path.resolve(candidate);
  if (!inside(runtimeRoot, requested)) return null;
  let current = path.resolve(userDataDir);
  try {
    for (const part of path.relative(current, requested).split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs.promises.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed runtime folders must not be aliases.");
    }
    const root = await fs.promises.realpath(requested), owned = await fs.promises.realpath(runtimeRoot);
    if (!inside(owned, root)) throw new Error("The managed runtime folder escapes launcher storage.");
    return root;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeManagedRuntimeQuarantine(install, { userDataDir, signal } = {},
  { platform = process.platform, execute = execFile } = {}) {
  if (platform !== "darwin") return false;
  throwIfAborted(signal);
  const root = await managedInstallRoot(install, userDataDir);
  if (!root) return false;
  throwIfAborted(signal);
  const run = args => new Promise((resolve, reject) => {
    // -s acts on aliases themselves. Shared dependency and system-resource
    // targets remain untouched, including when they are outside this runtime.
    execute("/usr/bin/xattr", args,
      { timeout: 30000, maxBuffer: 1024 * 1024, shell: false, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout || ""));
        if (signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") return reject(error);
        reject(new Error(`Could not prepare the downloaded runtime: ${String(stderr || error.message).trim()}`));
      });
  });
  try {
    await run(["-drs", "com.apple.quarantine", root]);
  } catch (error) {
    throwIfAborted(signal);
    // macOS can reject removexattr on a read-only file even when that file
    // has no quarantine attribute. Verify the remaining names before treating
    // that error as an installation failure; preserve publisher permissions.
    let attributes;
    try { attributes = await run(["-rs", root]); }
    catch { throwIfAborted(signal); throw error; }
    if (/(?:^|[\s:])com\.apple\.quarantine(?:\r?\n|$)/.test(attributes)) throw error;
  }
  return true;
}

module.exports = { managedInstallRoot, removeManagedRuntimeQuarantine };
