const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { memberPath } = require("../startup");
const LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, roots: 4 });
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

/** Original records remain read-only; atomic writes use the separate state root. */
async function createSaveStore({ directory, originalDirectories = [], signal } = {}) {
  if (!path.isAbsolute(directory || "") || !Array.isArray(originalDirectories) || originalDirectories.length >= LIMITS.roots ||
      originalDirectories.some(root => !path.isAbsolute(root || ""))) throw new Error("Bounded CatSystem2 save directories are required.");
  const roots = [];
  for (const source of [directory, ...originalDirectories]) {
    signal?.throwIfAborted(); const stat = await fs.promises.lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("CatSystem2 save roots require regular directories.");
    const root = await fs.promises.realpath(source); if (roots.some(item => item.path === root)) throw new Error("CatSystem2 save roots are repeated.");
    roots.push({ path: root, identity: identity(stat) });
  }
  async function checkRoot(root) {
    const stat = await fs.promises.lstat(root.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || root.identity.split(":").slice(0, 2).join(":") !== [stat.dev, stat.ino].join(":"))
      throw new Error("The CatSystem2 save directory changed.");
  }
  async function read(name) {
    signal?.throwIfAborted(); const relative = memberPath(name.replaceAll("\\", "/")); let result = null;
    for (const root of roots) {
      // Save creation changes directory timestamps; only filesystem identity is
      // stable across writes made by a different session's save UI.
      await checkRoot(root);
      const parts = relative.split("/"); let target = root.path, missing = false;
      for (let index = 0; index < parts.length; index++) {
        target = path.join(target, parts[index]); let stat;
        try { stat = await fs.promises.lstat(target); } catch (error) { if (error.code === "ENOENT") { missing = true; break; } throw error; }
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() || stat.size > LIMITS.bytes : !stat.isDirectory()))
          throw new Error("CatSystem2 saved data requires bounded regular paths.");
      }
      if (missing) continue;
      const handle = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = await handle.stat(); if (!before.isFile() || before.size > LIMITS.bytes) throw new Error("CatSystem2 saved data exceeds its byte limit.");
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { signal?.throwIfAborted(); const record = await handle.read(bytes, offset, bytes.length - offset, offset); if (!record.bytesRead) throw new Error("CatSystem2 saved data is truncated."); offset += record.bytesRead; }
        const after = await handle.stat(), current = await fs.promises.lstat(target), resolved = await fs.promises.realpath(target);
        if (current.isSymbolicLink() || !resolved.startsWith(root.path + path.sep) || identity(before) !== identity(after) || identity(before) !== identity(current))
          throw new Error("CatSystem2 saved data changed during reading.");
        if (result !== null) throw new Error("CatSystem2 saved data is ambiguous across its directories."); result = bytes;
      } finally { await handle.close(); }
    }
    return result;
  }
  async function write(name, source) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(source) || source.length > LIMITS.bytes) throw new Error("CatSystem2 saved data exceeds its byte limit.");
    const bytes = Buffer.from(source), relative = memberPath(name.replaceAll("\\", "/")), root = roots[0], target = path.join(root.path, relative);
    if (roots.slice(1).some(original => target === original.path || target.startsWith(original.path + path.sep) || root.path.startsWith(original.path + path.sep)))
      throw new Error("Original CatSystem2 save directories are read-only.");
    await checkRoot(root); let parent = root.path;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      try { await fs.promises.mkdir(parent, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = await fs.promises.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !((await fs.promises.realpath(parent)).startsWith(root.path + path.sep)))
        throw new Error("CatSystem2 saved data requires regular directories.");
    }
    async function current() {
      try {
        const stat = await fs.promises.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes) throw new Error("CatSystem2 saved data requires a bounded regular file.");
        return identity(stat);
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }
    const before = await current(), parentStat = await fs.promises.lstat(parent), partial = path.join(parent, ".partial-cs2-" + crypto.randomUUID());
    let handle;
    try {
      handle = await fs.promises.open(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null; signal?.throwIfAborted(); await checkRoot(root);
      const after = await fs.promises.lstat(parent), resolved = await fs.promises.realpath(parent);
      if (after.isSymbolicLink() || !after.isDirectory() || [after.dev, after.ino].join(":") !== [parentStat.dev, parentStat.ino].join(":") ||
          resolved !== parent || await current() !== before) throw new Error("The CatSystem2 save destination changed during writing.");
      await fs.promises.rename(partial, target); return true;
    } finally { if (handle) await handle.close(); await fs.promises.rm(partial, { force: true }); }
  }
  async function remove(name) {
    signal?.throwIfAborted(); const relative = memberPath(name.replaceAll("\\", "/")), root = roots[0], target = path.join(root.path, relative);
    if (roots.slice(1).some(original => target === original.path || target.startsWith(original.path + path.sep) || root.path.startsWith(original.path + path.sep)))
      throw new Error("Original CatSystem2 save directories are read-only.");
    async function locate(item) {
      await checkRoot(item); let file = item.path, last = null;
      const parts = relative.split("/");
      for (let index = 0; index < parts.length; index++) {
        file = path.join(file, parts[index]);
        try { last = await fs.promises.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
        if (last.isSymbolicLink() || (index === parts.length - 1 ? !last.isFile() || last.size > LIMITS.bytes : !last.isDirectory()))
          throw new Error("CatSystem2 saved data requires bounded regular paths.");
      }
      return { file, stat: last };
    }
    for (const original of roots.slice(1)) if (await locate(original)) throw new Error("Original CatSystem2 save files are read-only.");
    const found = await locate(root); if (!found) return false;
    const parent = path.dirname(found.file), parentBefore = await fs.promises.lstat(parent), resolved = await fs.promises.realpath(parent);
    signal?.throwIfAborted(); await checkRoot(root);
    const current = await fs.promises.lstat(found.file), parentAfter = await fs.promises.lstat(parent);
    if (current.isSymbolicLink() || !current.isFile() || identity(current) !== identity(found.stat) || parentAfter.isSymbolicLink() ||
        !parentAfter.isDirectory() || [parentBefore.dev, parentBefore.ino].join(":") !== [parentAfter.dev, parentAfter.ino].join(":") ||
        resolved !== parent || parent !== root.path && !parent.startsWith(root.path + path.sep))
      throw new Error("The CatSystem2 save destination changed during removal.");
    await fs.promises.unlink(found.file); return true;
  }
  return { read, write, remove };
}
module.exports = { LIMITS, createSaveStore };
