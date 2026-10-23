const fs = require("node:fs"), path = require("node:path");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Writable = require("../writable-input");
const run = promisify(execFile);
let directory;
async function systemCacheDirectory() {
  if (!directory) directory = run("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { timeout: 5000, maxBuffer: 8192 })
    .then(async ({ stdout }) => fs.promises.realpath(stdout.trim()))
    .catch(error => { directory = null; throw error; });
  return directory;
}

/** MetalCompilerService owns the contents and sandbox delegation of this
 * per-bundle directory. Its compiler workers require the original Darwin cache
 * location; redirecting it through a symlink breaks cold module compilation. */
async function prepare({ identifier }, locate = systemCacheDirectory) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(identifier || "")) throw new Error("Invalid native cache identifier.");
  const parent = await fs.promises.realpath(await locate()), cache = path.join(parent, identifier);
  Writable.assertOwnDirectory(parent, cache);
  return { directory: cache, writeDirectories: [cache], fileExtensions: { readWrite: [cache] },
    machServices: ["com.apple.system.opendirectoryd.membership", "com.apple.bsd.dirhelper"] };
}
module.exports = { prepare };
