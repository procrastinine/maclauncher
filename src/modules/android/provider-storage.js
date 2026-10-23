const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const Package = require("./provider-package-set");
const PROVIDERS = new Set(["macapk", "aim"]);

function storagePaths(userDataDir, gameId, provider = "macapk") {
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]{1,128}$/.test(gameId || "") || !PROVIDERS.has(provider))
    throw new Error("Android storage requires a saved game and runtime selection.");
  const gameRoot = path.join(userDataDir, "android", "apps", gameId), root = path.join(gameRoot, "providers", provider);
  const home = path.join(root, "home"), cacheRoot = path.join(root, "cache"), androidRoot = path.join(root, "android");
  return { gameRoot, root, providerRoot: root, provider, androidRoot, dataRoot: androidRoot, home,
    filesRoot: path.join(home, "Downloads", "imports"), cacheRoot, temporary: path.join(cacheRoot, "tmp"),
    runtimeRoot: path.join(root, "runtime"), packagesRoot: path.join(gameRoot, "packages"),
    legacyDataRoot: path.join(gameRoot, "data"), logFile: path.join(root, "runtime.log") };
}

async function prepareStorage(entry, userDataDir, { provider = "macapk", signal } = {}) {
  signal?.throwIfAborted();
  const paths = storagePaths(userDataDir, entry?.gameId, provider);
  for (const directory of [paths.root, paths.androidRoot, paths.home, paths.filesRoot, paths.cacheRoot, paths.temporary, paths.runtimeRoot, paths.packagesRoot])
    Writable.assertOwnDirectory(userDataDir, directory);
  for (const name of ["Documents", "Pictures", "Movies", "Music", "Desktop", "Library/Caches", "Library/Application Support"])
    Writable.assertOwnDirectory(paths.root, path.join(paths.home, name));
  return paths;
}

const unchanged = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
async function identity(file) {
  const stat = await fs.promises.lstat(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("Android inputs must be regular files or folders.");
  return [file, ...["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => String(stat[key]))];
}
async function inputIdentity(input) {
  const values = [await identity(input)];
  if (!Package.ARCHIVES.test(input)) for (const file of Package.directFiles(input)) values.push(await identity(file));
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function copyPackage(source, destination, signal) {
  const input = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Android packages must be regular files.");
    const hash = crypto.createHash("sha256"); let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted(); bytes += chunk.length;
      if (BigInt(bytes) > before.size) throw new Error("An Android package changed during import.");
      hash.update(chunk);
    }
    const sha256 = hash.digest("hex");
    // APFS shares the immutable blocks with the imported package. Each
    // provider reads this same store; writes create private blocks.
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    await fs.promises.chmod(destination, 0o400);
    const copied = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(destination)) { signal?.throwIfAborted(); copied.update(chunk); }
    if (copied.digest("hex") !== sha256) throw new Error("An Android package changed during import.");
    if (!unchanged(before, await input.stat({ bigint: true })) || BigInt(bytes) !== before.size || !unchanged(before, await fs.promises.lstat(source, { bigint: true })))
      throw new Error("An Android package changed during import.");
    return { sha256, bytes };
  } finally { await input.close(); }
}

async function preparePackages(entry, context, storage) {
  const input = entry.gamePath, signal = context.signal;
  if (!path.isAbsolute(input || "")) throw new Error("The Android package path is missing.");
  const key = await inputIdentity(input), destination = path.join(storage.packagesRoot, key), marker = path.join(destination, "packages.json");
  Writable.assertOwnDirectory(context.userDataDir, storage.packagesRoot);
  async function readPrepared() {
    Writable.assertOwnDirectory(storage.packagesRoot, destination, { create: false });
    const stat = await fs.promises.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error("The installed Android package record is invalid.");
    const record = JSON.parse(await fs.promises.readFile(marker, "utf8"));
    if (record.schemaVersion !== 1 || record.key !== key || !Array.isArray(record.files) || !record.files.length || record.files.length > 64)
      throw new Error("The installed Android package record is invalid.");
    const files = [];
    for (const item of record.files) {
      if (typeof item.name !== "string" || path.basename(item.name) !== item.name || !/^(?:base|split_[^/]+)\.apk$/.test(item.name))
        throw new Error("The installed Android package path is invalid.");
      const file = path.join(destination, item.name), current = await fs.promises.lstat(file);
      if (!current.isFile() || current.isSymbolicLink() || current.size !== item.bytes) throw new Error("An installed Android package is unavailable.");
      files.push(file);
    }
    return { ...Package.inspectFiles(files), root: destination, key, apks: files };
  }
  try { return await readPrepared(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const staging = await fs.promises.mkdtemp(path.join(storage.packagesRoot, ".import-"));
  try {
    const archive = Package.ARCHIVES.test(input), unpacked = path.join(staging, "unpacked");
    if (archive) await fs.promises.mkdir(unpacked, { mode: 0o700 });
    const files = archive ? (await Package.unpack(input, unpacked, signal)).map(item => item.file) : Package.directFiles(input);
    const selected = Package.inspectFiles(files), records = [];
    for (const item of selected.selected) {
      signal?.throwIfAborted();
      const name = Package.installedName(item.metadata.split);
      records.push({ name, ...await copyPackage(item.file, path.join(staging, name), signal) });
    }
    if (await inputIdentity(input) !== key) throw new Error("Android packages changed during preparation.");
    await fs.promises.rm(unpacked, { recursive: true, force: true });
    Writable.atomicWrite(path.join(staging, "packages.json"), JSON.stringify({ schemaVersion: 1, key, files: records }) + "\n", { root: staging });
    try { await fs.promises.rename(staging, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    return await readPrepared();
  } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
}

module.exports = { storagePaths, prepareStorage, preparePackages, inputIdentity, copyPackage };
