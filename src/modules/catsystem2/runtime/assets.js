const fs = require("node:fs"), path = require("node:path");
const Archive = require("../archive"), Startup = require("../startup");
const LIMITS = Object.freeze({ bytes: Archive.LIMITS.memberBytes, reads: 100000 });
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

/** Confined original-file or exact archive-member reads. No extraction tree. */
function createAssets({ dataRoot, archives, signal } = {}) {
  if (!path.isAbsolute(dataRoot || "") || !Array.isArray(archives)) throw new Error("Validated CatSystem2 asset roots and indexes are required.");
  const root = fs.realpathSync(dataRoot); let reads = 0;
  async function read(name, { maximumBytes = LIMITS.bytes } = {}) {
    signal?.throwIfAborted(); Startup.memberPath(name);
    if (++reads > LIMITS.reads || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > LIMITS.bytes) throw new Error("CatSystem2 asset read limit exceeded.");
    const parts = name.split("/"), candidates = archives.filter(archive => path.basename(archive.path).toLowerCase() === parts[0].toLowerCase());
    if (/\.int$/i.test(parts[0])) {
      if (parts.length < 2 || candidates.length !== 1) throw new Error("CatSystem2 asset archive is absent or ambiguous.");
      const archive = candidates[0], members = archive.entries.filter(entry => entry.name.toLowerCase() === parts.slice(1).join("/").toLowerCase());
      if (members.length !== 1) throw new Error("CatSystem2 asset member is absent or ambiguous.");
      return Archive.readEntry(archive, members[0], { maximumBytes, signal });
    }
    const file = path.join(root, ...parts); let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]); const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() || stat.size > maximumBytes : !stat.isDirectory())) throw new Error("CatSystem2 asset requires bounded original regular paths.");
    }
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(); if (!before.isFile() || before.size > maximumBytes) throw new Error("CatSystem2 asset exceeds its read limit.");
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new Error("Truncated CatSystem2 asset."); offset += result.bytesRead; }
      const after = await handle.stat(), current = await fs.promises.lstat(file), resolved = await fs.promises.realpath(file);
      if (current.isSymbolicLink() || !resolved.startsWith(root + path.sep) || identity(before) !== identity(after) || identity(before) !== identity(current)) throw new Error("CatSystem2 original asset changed during reading.");
      return bytes;
    } finally { await handle.close(); }
  }
  async function exists(name) {
    signal?.throwIfAborted(); Startup.memberPath(name);
    if (++reads > LIMITS.reads) throw new Error("CatSystem2 asset read limit exceeded.");
    const parts = name.split("/");
    if (/\.int$/i.test(parts[0])) {
      if (parts.length < 2) throw new Error("A CatSystem2 archive member name is required.");
      const candidates = archives.filter(archive => path.basename(archive.path).toLowerCase() === parts[0].toLowerCase());
      if (!candidates.length) return false; if (candidates.length !== 1) throw new Error("CatSystem2 asset archive is ambiguous.");
      await Archive.verifyArchive(candidates[0], { signal });
      const members = candidates[0].entries.filter(entry => entry.name.toLowerCase() === parts.slice(1).join("/").toLowerCase());
      if (members.length > 1) throw new Error("CatSystem2 asset member is ambiguous."); return members.length === 1;
    }
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]); let stat;
      try { stat = await fs.promises.lstat(current); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("CatSystem2 assets require original regular paths.");
    }
    if (!(await fs.promises.realpath(current)).startsWith(root + path.sep)) throw new Error("The CatSystem2 original asset path changed."); return true;
  }
  async function observe(name) {
    signal?.throwIfAborted(); Startup.memberPath(name);
    if (++reads > LIMITS.reads || /\.int(?:\/|$)/i.test(name)) throw new Error("A bounded original loose asset is required.");
    let file = root;
    const parts = name.split("/");
    for (let index = 0; index < parts.length; index++) {
      file = path.join(file, parts[index]); const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() || stat.size > LIMITS.bytes : !stat.isDirectory()))
        throw new Error("CatSystem2 loose assets require bounded original regular paths.");
    }
    const before = await fs.promises.lstat(file), resolved = await fs.promises.realpath(file), after = await fs.promises.lstat(file);
    if (!resolved.startsWith(root + path.sep) || identity(before) !== identity(after) || after.isSymbolicLink()) throw new Error("The CatSystem2 original asset changed during observation.");
    return Object.freeze({ path: resolved, identity: identity(after), size: after.size });
  }
  return { read, exists, observe, root };
}
module.exports = { LIMITS, createAssets };
