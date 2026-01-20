const fs = require("node:fs");
const path = require("node:path");

function readAsarHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const headerBuf = Buffer.alloc(16);
    const read = fs.readSync(fd, headerBuf, 0, 16, 0);
    if (read !== 16) throw new Error("Failed to read asar header");
    const jsonSize = headerBuf.readUInt32LE(12);
    const dataOffset = headerBuf.readUInt32LE(4) + 8;
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString("utf8"));
    return { header, jsonSize, dataOffset };
  } finally {
    fs.closeSync(fd);
  }
}

function listAsarEntries(header, dataOffset, prefix = "") {
  const out = [];
  const files = header?.files || {};
  for (const [name, entry] of Object.entries(files)) {
    const nextPath = prefix ? path.join(prefix, name) : name;
    if (entry && typeof entry === "object" && entry.files) {
      out.push({ path: nextPath, type: "dir" });
      out.push(...listAsarEntries(entry, dataOffset, nextPath));
      continue;
    }
    const size = Number(entry?.size || 0);
    const rawOffset = entry?.offset;
    if (rawOffset === undefined || rawOffset === null) {
      out.push({ path: nextPath, type: "file", size, unpacked: true });
      continue;
    }
    const offset = dataOffset + Number(rawOffset);
    out.push({ path: nextPath, type: "file", size, offset });
  }
  return out;
}

function extractAsar(filePath, outDir) {
  const fd = fs.openSync(filePath, "r");
  try {
    const { header, dataOffset } = readAsarHeader(filePath);
    const entries = listAsarEntries(header, dataOffset);
    for (const entry of entries) {
      if (entry.type === "dir") {
        fs.mkdirSync(path.join(outDir, entry.path), { recursive: true });
        continue;
      }
      if (entry.unpacked || entry.offset === undefined) continue;
      const target = path.join(outDir, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, entry.size, entry.offset);
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
