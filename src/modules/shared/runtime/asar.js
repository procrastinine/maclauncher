const fs = require("node:fs");
const path = require("node:path");

function readHeaderFromFd(fd) {
  const headerBuf = Buffer.alloc(16);
  const read = fs.readSync(fd, headerBuf, 0, 16, 0);
  if (read !== 16) throw new Error("Failed to read asar header");
  const jsonSize = headerBuf.readUInt32LE(12);
  const dataOffset = headerBuf.readUInt32LE(4) + 8;
  const fileSize = fs.fstatSync(fd).size;
  if (dataOffset < 16 || dataOffset > fileSize || jsonSize > dataOffset - 16) {
    throw new Error("Invalid asar header size");
  }
  const jsonBuf = Buffer.alloc(jsonSize);
  if (fs.readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) {
    throw new Error("Truncated asar header");
  }
  const header = JSON.parse(jsonBuf.toString("utf8"));
  return { header, jsonSize, dataOffset };
}

function readAsarHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    return readHeaderFromFd(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function listAsarEntries(header, dataOffset, prefix = "") {
  const out = [];
  const files = header?.files || {};
  for (const [name, entry] of Object.entries(files)) {
    // Header keys are single path components, not paths to resolve.
    if (!name || name === "." || name === ".." || name.includes("\0") || path.basename(name) !== name) {
      throw new Error(`Invalid asar entry name: ${name}`);
    }
    const nextPath = prefix ? path.join(prefix, name) : name;
    if (entry && typeof entry === "object" && entry.files) {
      out.push({ path: nextPath, type: "dir" });
      out.push(...listAsarEntries(entry, dataOffset, nextPath));
      continue;
    }
    const size = Number(entry?.size || 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid asar file size: ${nextPath}`);
    const rawOffset = entry?.offset;
    if (entry?.unpacked || rawOffset === undefined || rawOffset === null) {
      out.push({ path: nextPath, type: "file", size, unpacked: true });
      continue;
    }
    const relativeOffset = Number(rawOffset);
    const offset = dataOffset + relativeOffset;
    if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0 || !Number.isSafeInteger(offset)) {
      throw new Error(`Invalid asar file offset: ${nextPath}`);
    }
    out.push({ path: nextPath, type: "file", size, offset });
  }
  return out;
}

function assertNoSymlink(root, relativePath) {
  let current = root;
  for (const part of relativePath.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Cannot extract asar through symbolic link: ${relativePath}`);
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
  }
}

function extractAsar(filePath, outDir) {
  const fd = fs.openSync(filePath, "r");
  try {
    const { header, dataOffset } = readHeaderFromFd(fd);
    const entries = listAsarEntries(header, dataOffset);
    const fileSize = fs.fstatSync(fd).size;
    for (const entry of entries) {
      if (entry.offset !== undefined && entry.size > fileSize - entry.offset) {
        throw new Error(`Invalid asar file range: ${entry.path}`);
      }
    }
    fs.mkdirSync(outDir, { recursive: true });
    const root = fs.realpathSync(outDir);
    for (const entry of entries) assertNoSymlink(root, entry.path);
    for (const entry of entries) {
      if (entry.type === "dir") {
        fs.mkdirSync(path.join(root, entry.path), { recursive: true });
        continue;
      }
      if (entry.unpacked || entry.offset === undefined) continue;
      const target = path.join(root, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const buffer = Buffer.alloc(entry.size);
      if (fs.readSync(fd, buffer, 0, entry.size, entry.offset) !== entry.size) {
        throw new Error(`Truncated asar file: ${entry.path}`);
      }
      fs.writeFileSync(target, buffer);
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  readAsarHeader,
  listAsarEntries,
  extractAsar
};
