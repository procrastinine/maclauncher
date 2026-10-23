const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");

async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw Error("Android platform storage is not a private directory.");
  return directory;
}

function serviceRole(role = "keystore") {
  if (role !== "keystore" && role !== "accounts" && role !== "system") throw Error("Unknown Android platform service.");
  return role;
}

async function paths(userDataDir, role = "keystore") {
  serviceRole(role);
  const profile = await fs.realpath(userDataDir);
  // Existing app storage can contain game roots; platform secrets have a
  // separate private subtree which is never granted to a game sandbox.
  const android = path.join(profile, "android");
  await fs.mkdir(android, { recursive: true });
  const parent = await privateDirectory(path.join(android, "platform"));
  const root = await privateDirectory(path.join(parent, role));
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 24);
  const temporary = await privateDirectory("/private/tmp/maclauncher-android-" + process.getuid());
  const runRoot = await privateDirectory(path.join(temporary, hash));
  return { root, runRoot, metadata: path.join(root, "owner.json"), lock: path.join(root, "owner.lock"),
    controllerSocket: path.join(runRoot, "controller"), platformSocket: path.join(runRoot, "binder") };
}

async function writePrivate(file, value) {
  const temporary = file + "." + crypto.randomUUID();
  try { await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function readPrivate(file) {
  const flags = require("node:fs").constants;
  const handle = await fs.open(file, flags.O_RDONLY | flags.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536)
      throw Error("Android platform connection metadata is not private.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function syncSocket(configurationFile) {
  const temporary=await privateDirectory("/private/tmp/maclauncher-android-"+process.getuid());
  const hash=crypto.createHash("sha256").update(path.resolve(configurationFile)).digest("hex").slice(0,32);
  return path.join(temporary,"s-"+hash+".ml-sync-file");
}

module.exports = { paths, serviceRole, privateDirectory, writePrivate, readPrivate, syncSocket };
