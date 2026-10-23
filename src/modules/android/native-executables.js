const fs = require("node:fs"), path = require("node:path");
const { canonical, within } = require("../shared/runtime/macos-sandbox");
const NativeAbi = require("./native-abi");
const { LIMITS } = require("./apk");

function armElf(header, size, abi) {
  const arm32 = abi === "armeabi-v7a" || abi === "armeabi";
  const bytes = arm32 ? 52 : 64;
  if (header.length < bytes || header.readUInt32LE(0) !== 0x464c457f ||
      header[4] !== (arm32 ? 1 : 2) || header[5] !== 1 || header[6] !== 1 ||
      ![0, 3].includes(header[7]) || ![2, 3].includes(header.readUInt16LE(16)) ||
      header.readUInt16LE(18) !== (arm32 ? 40 : 183) || header.readUInt32LE(20) !== 1 ||
      header.readUInt16LE(arm32 ? 40 : 52) !== bytes) return false;
  const offset = arm32 ? BigInt(header.readUInt32LE(28)) : header.readBigUInt64LE(32);
  const entrySize = header.readUInt16LE(arm32 ? 42 : 54), count = header.readUInt16LE(arm32 ? 44 : 56);
  return count > 0 && entrySize === (arm32 ? 32 : 56) && offset >= BigInt(bytes) &&
    offset + BigInt(entrySize) * BigInt(count) <= BigInt(size);
}

/** Installed Linux ELF files need genuine X_OK checks even though Darwin
 * cannot execute that format. No host executable or writable input is admitted. */
async function installedExecutables(directories, writeDirectories, signal) {
  const writable = await Promise.all([...new Set(writeDirectories)].map(directory => canonical(directory, "directory")));
  const result = new Set(), visited = new Set(), shared = new Map();
  for (const directory of new Set(directories)) {
    signal?.throwIfAborted();
    const input = await fs.promises.lstat(directory);
    if (!input.isDirectory() || input.isSymbolicLink()) continue;
    const root = await canonical(directory, "directory");
    if (visited.has(root) || writable.some(value => within(value, root))) continue;
    visited.add(root);
    const abi = NativeAbi.fromDirectory(root), entries = await fs.promises.readdir(root, { withFileTypes: true });
    if (entries.length > LIMITS.entries) throw new Error("The Android native library directory contains too many files.");
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile() || !entry.name.endsWith(".so")) continue;
      const file = path.join(root, entry.name);
      if (writable.some(value => within(value, file))) continue;
      let handle;
      try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = await handle.stat({bigint: true});
        if (!before.isFile() || !(before.mode & 0o111n)) continue;
        const header = Buffer.alloc(64), { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (!armElf(header.subarray(0, bytesRead), before.size, abi)) continue;
        if (before.nlink > 1n) {
          const key = [before.dev, before.ino, before.size, before.mode, before.mtimeNs, before.ctimeNs, before.nlink].join(":");
          if (!shared.has(key)) shared.set(key, await require("./prepared-sharing").executableAliases(file, handle, before, writable, signal));
          if (!shared.get(key).has(file)) continue;
        }
        const after = await handle.stat({bigint: true}), current = await fs.promises.lstat(file, {bigint: true});
        if (!current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino &&
            after.size === before.size && after.mode === before.mode && after.nlink === before.nlink &&
            after.ctimeNs === before.ctimeNs && after.mtimeNs === before.mtimeNs)
          result.add(file);
      } catch (error) {
        if (!["ENOENT", "ELOOP"].includes(error.code)) throw error;
      } finally { await handle?.close(); }
    }
  }
  return [...result];
}

module.exports = { installedExecutables };
