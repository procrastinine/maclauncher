const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../shared/writable-input");
const PROFILE_ID = "microg-v1";
function profilePaths(userDataDir, { create = false } = {}) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Google accounts require private launcher storage.");
  const root = path.join(userDataDir, "android", "profiles", PROFILE_ID), home = path.join(root, "home");
  const paths = { id: PROFILE_ID, root, providerRoot: root, androidRoot: path.join(root, "android"), home,
    cacheRoot: path.join(root, "cache"), temporary: path.join(root, "cache", "tmp"), runtimeRoot: path.join(root, "runtime"),
    packagesRoot: path.join(root, "packages"),
    filesRoot: path.join(home, "Downloads", "imports"), metadataFile: path.join(root, "accounts.json") };
  for (const name of ["root", "androidRoot", "home", "cacheRoot", "temporary", "runtimeRoot", "filesRoot", "packagesRoot"])
    Writable.assertOwnDirectory(userDataDir, paths[name], { create });
  return paths;
}
function accountIdentity(value) {
  if (!value || value.type !== "com.google" || typeof value.name !== "string" || !value.name || value.name.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(value.name)) throw new Error("The Android account service returned an invalid identity.");
  return { id: crypto.createHash("sha256").update(PROFILE_ID + "\0" + value.type + "\0" + value.name).digest("hex"),
    name: value.name, type: value.type, providerPackage: "com.google.android.gms" };
}
function readSnapshot(userDataDir) {
  const file = profilePaths(userDataDir).metadataFile;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("Invalid Google account metadata.");
      const data = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (data.schemaVersion !== 1 || !Array.isArray(data.accounts)) throw new Error("Invalid Google account metadata.");
      const accounts = data.accounts.map(accountIdentity);
      if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error("Duplicate Google account metadata.");
      return accounts;
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
// Only account names/type returned by the real Android AccountManager enter this
// host snapshot. Passwords, master tokens, cookies and credential stores never do.
function saveSnapshot(userDataDir, values) {
  const accounts = values.map(accountIdentity), storage = profilePaths(userDataDir, { create: true });
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error("Duplicate Google accounts.");
  Writable.atomicWrite(storage.metadataFile, JSON.stringify({ schemaVersion: 1, accounts }) + "\n", { root: storage.root });
  fs.chmodSync(storage.metadataFile, 0o600);
  return accounts;
}
module.exports = { PROFILE_ID, profilePaths, accountIdentity, readSnapshot, saveSnapshot };
