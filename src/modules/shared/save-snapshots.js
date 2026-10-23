const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const LIMITS = Object.freeze({ files: 5000, bytes: 512 * 1024 * 1024, fileBytes: 128 * 1024 * 1024, depth: 16 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const SID = /^[0-9]{13}-[a-f0-9-]{36}$/;

function relativeName(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
      path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid relative save path.");
  }
  return value;
}

// Walk every component, including parents: a symlinked save directory must not
// turn a user-selected save operation into a write elsewhere.
function checkDirectory(directory, { create = false } = {}) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    const systemAlias = process.platform === "darwin" && (current === "/tmp" || current === "/var");
    if (systemAlias && stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Save paths must use real directories, without symlinks.");
  }
  return true;
}

function readRegular(filePath, maxBytes = LIMITS.fileBytes) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error("Save file is not regular or exceeds the size limit.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Save changed while being read. Reload and retry.");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Save changed while being read. Reload and retry.");
    }
    return { bytes, size: bytes.length, sha256: hash(bytes), mode: before.mode & 0o777, mtimeMs: before.mtimeMs };
  } finally { fs.closeSync(fd); }
}

function collectFiles(directory, { extensions, names, recursive = true, limits = LIMITS } = {}) {
  const files = [];
  let total = 0;
  if (!checkDirectory(directory)) return files;
  const suffixes = extensions?.map(ext => `.${String(ext).replace(/^\./, "").toLowerCase()}`);
  function walk(relative, depth) {
    if (depth > limits.depth) throw new Error("Save directory nesting exceeds the limit.");
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      // Disposable editor and legacy recovery sidecars are not actual saves.
      if (entry.name.includes(".maclauncher.") || entry.name.startsWith(".maclauncher-")) continue;
      const name = relativeName(path.posix.join(relative, entry.name));
      const full = path.join(directory, name);
      if (recursive === false) {
        if (entry.isDirectory()) continue;
        // A portable save folder can also be the native game's working
        // directory. Ignore unrelated linked assets without following them.
        if (suffixes?.length && !suffixes.some(suffix => name.toLowerCase().endsWith(suffix)) && !names?.includes(entry.name)) continue;
      }
      if (entry.isSymbolicLink()) throw new Error("Save directories cannot contain symlinks.");
      if (entry.isDirectory()) { walk(name, depth + 1); continue; }
      if (!entry.isFile()) throw new Error("Save directories may contain only regular files and directories.");
      if (suffixes?.length && !suffixes.some(suffix => name.toLowerCase().endsWith(suffix)) && !names?.includes(entry.name)) continue;
      const file = readRegular(full, limits.fileBytes);
      total += file.size;
      if (files.length >= limits.files || total > limits.bytes) throw new Error("Save snapshot exceeds file count or size limits.");
      files.push({ name, ...file });
    }
  }
  walk("", 0);
  return files.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function stateHash(files) { return hash(JSON.stringify(files.map(({ name, size, sha256 }) => ({ name, size, sha256 })))); }

function resolveSnapshotRoot(userDataDir, gameId) {
  if (typeof gameId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(gameId)) throw new Error("Invalid game identity for save snapshots.");
  return path.join(path.resolve(userDataDir), "games", gameId, "save-snapshots");
}

function createSnapshot({ userDataDir, entry, saveDir, reason = "manual", extensions, names, recursive = true }) {
  const files = collectFiles(saveDir, { extensions, names, recursive });
  const root = resolveSnapshotRoot(userDataDir, entry.gameId);
  checkDirectory(root, { create: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const staging = path.join(root, `.pending-${randomUUID()}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const manifest = {
      schemaVersion: 1, id, createdAt: Date.now(), reason: String(reason).slice(0, 120),
      gameId: entry.gameId, moduleId: entry.moduleId || entry.engine || "unknown", gameName: entry.name || "",
      runtimeId: entry.runtimeId || null, runtimeData: entry.runtimeData || null,
      sourceDirectory: path.resolve(saveDir), extensions: extensions || null, names: names || null, recursive,
      files: files.map(({ bytes, ...file }) => file), totalBytes: files.reduce((sum, file) => sum + file.size, 0)
    };
    for (const file of files) {
      const target = path.join(staging, "files", file.name);
      checkDirectory(path.dirname(target), { create: true });
      fs.writeFileSync(target, file.bytes, { flag: "wx", mode: 0o400 });
    }
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o400 });
    // Detect a game write or newly created save during the copy before publication.
    if (stateHash(collectFiles(saveDir, { extensions, names, recursive })) !== stateHash(files)) {
      throw new Error("Saves changed during snapshot creation. Stop the game and retry.");
    }
    fs.renameSync(staging, path.join(root, id));
    return manifest;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function readManifest(userDataDir, gameId, id) {
  if (!SID.test(id)) throw new Error("Invalid snapshot identity.");
  const directory = path.join(resolveSnapshotRoot(userDataDir, gameId), id);
  if (!checkDirectory(directory)) throw new Error("Save snapshot not found.");
  const manifest = JSON.parse(readRegular(path.join(directory, "manifest.json"), 4 * 1024 * 1024).bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.id !== id || manifest.gameId !== gameId ||
      !Array.isArray(manifest.files) || manifest.files.length > LIMITS.files) throw new Error("Invalid save snapshot manifest.");
  const seen = new Set();
  let total = 0;
  for (const file of manifest.files) {
    relativeName(file.name);
    const key = file.name.normalize("NFC").toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new Error("Invalid save snapshot file record.");
    }
    seen.add(key);
    total += file.size;
    if (total > LIMITS.bytes) throw new Error("Save snapshot exceeds size limit.");
  }
  return { manifest, directory };
}

function listSnapshots({ userDataDir, gameId }) {
  const root = resolveSnapshotRoot(userDataDir, gameId);
  if (!checkDirectory(root)) return [];
  return fs.readdirSync(root).filter(id => SID.test(id)).map(id => readManifest(userDataDir, gameId, id).manifest)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function verifiedSnapshot(options) {
  const { manifest, directory } = readManifest(options.userDataDir, options.entry.gameId, options.snapshotId);
  const files = manifest.files.map(file => {
    const target = path.join(directory, "files", file.name);
    if (!checkDirectory(path.dirname(target))) throw new Error("Snapshot file is missing.");
    const data = readRegular(target);
    if (data.size !== file.size || data.sha256 !== file.sha256) throw new Error("Snapshot file checksum mismatch.");
    return { ...file, bytes: data.bytes };
  });
  return { manifest, files };
}

function previewRestore(options) {
  const { manifest, files } = verifiedSnapshot(options);
  for (const file of files) {
    if (options.recursive === false && file.name.includes("/")) throw new Error("Snapshot contains saves outside this engine's directory layout.");
    if (options.extensions?.length && !options.extensions.some(ext => file.name.toLowerCase().endsWith(`.${String(ext).replace(/^\./, "").toLowerCase()}`)) && !options.names?.includes(path.posix.basename(file.name))) {
      throw new Error("Snapshot contains a file outside this engine's save formats.");
    }
  }
  const current = collectFiles(options.saveDir, options);
  const byName = new Map(current.map(file => [file.name, file]));
  const changes = files.filter(file => byName.get(file.name)?.sha256 !== file.sha256).map(file => ({
    name: file.name, operation: byName.has(file.name) ? "replace" : "create", size: file.size
  }));
  return { snapshotId: manifest.id, createdAt: manifest.createdAt, changes, expectedStateHash: stateHash(current),
    keptFiles: current.filter(file => !files.some(saved => saved.name === file.name)).map(file => file.name) };
}

// Stage first, replace atomically per file, and roll back the complete batch on
// failure. Unrelated files are retained; restore is deliberately a merge.
function replaceFiles({ saveDir, files, expectedStateHash, extensions, names, recursive = true }) {
  if (recursive === false && files.some(file => file.name.includes("/"))) throw new Error("Save import contains files outside this engine's directory layout.");
  if (stateHash(collectFiles(saveDir, { extensions, names, recursive })) !== expectedStateHash) throw new Error("Saves changed. Reload the restore preview and retry.");
  checkDirectory(saveDir, { create: true });
  const staged = [], applied = [], originals = new Map();
  try {
    for (const file of files) {
      const target = path.join(saveDir, relativeName(file.name));
      checkDirectory(path.dirname(target), { create: true });
      let original = null;
      try { original = readRegular(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
      originals.set(target, original);
      const temporary = path.join(path.dirname(target), `.maclauncher-restore-${randomUUID()}.tmp`);
      staged.push({ target, temporary, writtenHash: hash(file.bytes) });
      fs.writeFileSync(temporary, file.bytes, { flag: "wx", mode: original?.mode ?? file.mode ?? 0o600 });
    }
    if (stateHash(collectFiles(saveDir, { extensions, names, recursive })) !== expectedStateHash) throw new Error("Saves changed during restore. Stop the game and retry.");
    for (const record of staged) {
      checkDirectory(path.dirname(record.target));
      let current = null;
      try { current = readRegular(record.target); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if ((current?.sha256 || null) !== (originals.get(record.target)?.sha256 || null)) {
        throw new Error("A save changed during the transaction. Stop the game and retry.");
      }
      fs.renameSync(record.temporary, record.target);
      applied.push(record);
    }
  } catch (error) {
    const failures = [];
    for (const { target, writtenHash } of applied.reverse()) {
      try {
        checkDirectory(path.dirname(target));
        const current = readRegular(target);
        if (current.sha256 !== writtenHash) throw new Error("A save changed after replacement; preserving the newer file instead of rolling it back.");
        const original = originals.get(target);
        if (!original) fs.rmSync(target);
        else {
          const temp = path.join(path.dirname(target), `.maclauncher-rollback-${randomUUID()}.tmp`);
          try {
            fs.writeFileSync(temp, original.bytes, { flag: "wx", mode: original.mode });
            fs.renameSync(temp, target);
          } finally { fs.rmSync(temp, { force: true }); }
        }
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Save transaction failed; rollback incomplete. Recover using the pre-write snapshot.");
    throw error;
  } finally { for (const { temporary } of staged) fs.rmSync(temporary, { force: true }); }
}

function restoreSnapshot(options) {
  const preview = previewRestore(options);
  if (typeof options.expectedStateHash !== "string" || options.expectedStateHash !== preview.expectedStateHash) {
    throw new Error("Saves changed or restore preview missing. Preview again before restoring.");
  }
  const { files } = verifiedSnapshot(options);
  const recovery = createSnapshot({ ...options, reason: "before-restore" });
  replaceFiles({ ...options, files });
  return { ...preview, recoverySnapshotId: recovery.id, restored: true };
}

module.exports = { LIMITS, hash, relativeName, checkDirectory, readRegular, collectFiles, stateHash,
  resolveSnapshotRoot, createSnapshot, listSnapshots, previewRestore, restoreSnapshot, replaceFiles };
