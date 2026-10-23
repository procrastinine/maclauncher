const fs = require("node:fs"), path = require("node:path");
const { pipeline } = require("node:stream/promises");
const Writable = require("../shared/writable-input");
const pending = new Map();
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };

function storagePaths(userDataDir, gameId) {
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]{1,128}$/.test(gameId || ""))
    throw new Error("Android storage requires a saved game identity.");
  const root = path.join(userDataDir, "android", "apps", gameId);
  const dataRoot=path.join(root,"data");
  return { root, dataRoot, filesRoot: path.join(dataRoot, "files"), cacheRoot: path.join(dataRoot, "cache"),
    runtimeRoot: path.join(root, "runtime"),
    preparedRoot: path.join(root, "prepared"), launchFile: path.join(root, "launch.json"), logFile: path.join(root, "runtime.log") };
}

async function exists(file) {
  try { return await fs.promises.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Import regular files only. Never retain source aliases or modify originals.
async function copyTree(source, destination, state, signal) {
  signal?.throwIfAborted();
  const before = await fs.promises.lstat(source);
  if (before.isSymbolicLink()) throw new Error("Android storage imports cannot contain aliases.");
  if (++state.entries > 200000 || state.depth > 128) throw new Error("The Android storage import contains too many files.");
  if (before.isDirectory()) {
    await fs.promises.mkdir(destination, { mode: 0o700 });
    state.depth++;
    try { for (const name of await fs.promises.readdir(source)) await copyTree(path.join(source, name), path.join(destination, name), state, signal); }
    finally { state.depth--; }
  } else if (before.isFile()) {
    const input = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = await input.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Android storage changed during import.");
      await pipeline(input.createReadStream({ autoClose: false }), fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
      const after = await input.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
        throw new Error("Android storage changed during import.");
      await fs.promises.utimes(destination, opened.atime, opened.mtime);
    } finally { await input.close(); }
  } else throw new Error("Android storage imports require regular files and folders.");
}

async function prepareStorage(entry, userDataDir, { signal, payloadRoot } = {}) {
  const paths = storagePaths(userDataDir, entry?.gameId);
  if (pending.has(paths.root)) return pending.get(paths.root);
  const initialize = async () => {
    signal?.throwIfAborted();
    Writable.assertOwnDirectory(userDataDir, path.dirname(paths.root));
    if (entry.saveDirOverride != null && entry.saveDirOverride !== "" &&
        (typeof entry.saveDirOverride !== "string" || !path.isAbsolute(entry.saveDirOverride) || entry.saveDirOverride.includes("\0")))
      throw new Error("The Android save import must be an absolute folder path.");
    const marker = path.join(paths.root, "storage.json"), previous = await exists(paths.root);
    if (previous) {
      Writable.assertOwnDirectory(userDataDir, paths.root, { create: false });
      const stat = await exists(marker);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Android storage already exists without a completed import.");
      const record = JSON.parse(await fs.promises.readFile(marker, "utf8"));
      if (record.schemaVersion !== 1 || record.gameId !== entry.gameId) throw new Error("The Android storage identity is invalid.");
      const requested = entry.saveDirOverride ? path.resolve(entry.saveDirOverride) : null;
      if (requested && requested !== record.importedSaveRequest && requested !== record.importedSaveDirectory) throw new Error("Android saves already use private storage. Export the current saves before importing another folder.");
      for (const directory of [paths.dataRoot, paths.filesRoot, paths.cacheRoot, paths.preparedRoot]) Writable.assertOwnDirectory(userDataDir, directory);
      return paths;
    }
    let selected = null;
    if (entry.saveDirOverride != null && entry.saveDirOverride !== "") {
      if (typeof entry.saveDirOverride !== "string" || !path.isAbsolute(entry.saveDirOverride) || entry.saveDirOverride.includes("\0"))
        throw new Error("The Android save import must be an absolute folder path.");
      const stat = await exists(entry.saveDirOverride);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("The Android save import must be an existing regular folder.");
      selected = await fs.promises.realpath(entry.saveDirOverride);
      const container = await fs.promises.realpath(path.dirname(paths.root));
      if (inside(selected, container) || inside(container, selected) || payloadRoot && inside(await fs.promises.realpath(payloadRoot), selected))
        throw new Error("Android saves must be imported from outside prepared files and the installed runtime.");
    }
    const temporary = await fs.promises.mkdtemp(path.join(path.dirname(paths.root), ".import-" + entry.gameId + "-"));
    let movedPrepared = null;
    try {
      const legacy = path.join(userDataDir, "games", entry.gameId, "modules", "android");
      Writable.assertOwnDirectory(userDataDir, legacy, { create: false });
      const state = { entries: 0, depth: 0 };
      const oldData = path.join(legacy, "data"), newData = path.join(temporary, "data");
      if (await exists(oldData)) await copyTree(oldData, newData, state, signal);
      else await fs.promises.mkdir(newData, { mode: 0o700 });
      const files = path.join(temporary, "data", "files");
      if (selected) {
        if (await exists(files)) {
          await fs.promises.mkdir(path.join(temporary, "imports"), { mode: 0o700 });
          await fs.promises.rename(files, path.join(temporary, "imports", "legacy-files"));
        }
        await copyTree(selected, files, state, signal);
      } else if (!await exists(files)) await fs.promises.mkdir(files, { mode: 0o700 });
      Writable.assertOwnDirectory(temporary, path.join(temporary, "data", "cache"));
      signal?.throwIfAborted();
      const oldPrepared = path.join(legacy, "prepared"), newPrepared = path.join(temporary, "prepared");
      if (await exists(oldPrepared)) {
        Writable.assertOwnDirectory(userDataDir, oldPrepared, { create: false });
        // Conversion caches are launcher-owned. Relocate them rather than
        // retaining a second large copy; save data above remains copied.
        await fs.promises.rename(oldPrepared, newPrepared);
        movedPrepared = oldPrepared;
      } else await fs.promises.mkdir(newPrepared, { mode: 0o700 });
      signal?.throwIfAborted();
      Writable.atomicWrite(path.join(temporary, "storage.json"), JSON.stringify({ schemaVersion: 1,
        gameId: entry.gameId, importedSaveDirectory: selected, importedSaveRequest: selected ? path.resolve(entry.saveDirOverride) : null, legacyRetained: Boolean(await exists(legacy)) }) + "\n", { root: temporary });
      // A complete nonempty destination can never be replaced by this rename.
      await fs.promises.rename(temporary, paths.root);
      movedPrepared = null;
      return paths;
    } catch (error) {
      if (movedPrepared) {
        try { await fs.promises.rename(path.join(temporary, "prepared"), movedPrepared);movedPrepared = null; }
        catch (rollback) { throw new AggregateError([error, rollback], "Android cache relocation could not be restored. The files remain in " + temporary); }
      }
      throw error;
    } finally { if (!movedPrepared) await fs.promises.rm(temporary, { recursive: true, force: true }); }
  };
  const work = (async () => {
    Writable.assertOwnDirectory(userDataDir, path.dirname(paths.root));
    // Publication is atomic, but independent launcher workers can all observe
    // the initial absence. Only that cold path needs a shared import owner.
    if (fs.existsSync(paths.root)) return initialize();
    return require("./catalog-lock").withCatalogLock(
      path.join(path.dirname(paths.root), ".storage-" + entry.gameId + ".lock"), initialize);
  })();
  pending.set(paths.root, work);
  try { return await work; } finally { if (pending.get(paths.root) === work) pending.delete(paths.root); }
}

module.exports = { storagePaths, prepareStorage };
