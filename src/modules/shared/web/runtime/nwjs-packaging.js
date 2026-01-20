const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const Zip = require("../../runtime/zip");
const Asar = require("../../runtime/asar");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(true);
      const err = new Error(`${cmd} failed (${code})`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractZipDarwin(zipPath, destDir) {
  const ditto = "/usr/bin/ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, destDir]);
}

function copyRangeToFile(filePath, destPath, startOffset) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath, { start: Math.max(0, startOffset || 0) });
    const output = fs.createWriteStream(destPath);
    input.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    input.pipe(output);
  });
}

async function extractZipPayload(filePath, destDir) {
  const result = Zip.readZipEntries(filePath);
  if (!result || !result.info) return null;
  const zipBase = Number(result.info.zipBase || 0);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-zip-"));
  const payloadPath = path.join(tmpDir, "payload.zip");

  try {
    await copyRangeToFile(filePath, payloadPath, zipBase);
    ensureDir(destDir);
    await extractZipDarwin(payloadPath, destDir);
  } finally {
    safeRm(tmpDir);
  }

  return result;
}

function readPeOverlayOffset(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.size || stat.size < 0x40) return null;
    const header = Buffer.alloc(0x40);
    fs.readSync(fd, header, 0, header.length, 0);
    const peOffset = header.readUInt32LE(0x3c);
    if (!peOffset || peOffset <= 0 || peOffset > stat.size - 4) return null;

    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, peOffset);
    if (sig.toString("ascii") !== "PE\u0000\u0000") return null;

    const coff = Buffer.alloc(20);
    fs.readSync(fd, coff, 0, coff.length, peOffset + 4);
    const numSections = coff.readUInt16LE(2);
    const optHeaderSize = coff.readUInt16LE(16);
    const sectionTable = peOffset + 4 + 20 + optHeaderSize;
    const sectionSize = 40;
    if (sectionTable + numSections * sectionSize > stat.size) return null;

    let maxEnd = 0;
    const sectionBuf = Buffer.alloc(sectionSize);
    for (let i = 0; i < numSections; i += 1) {
      const offset = sectionTable + i * sectionSize;
      fs.readSync(fd, sectionBuf, 0, sectionSize, offset);
      const rawSize = sectionBuf.readUInt32LE(16);
      const rawPtr = sectionBuf.readUInt32LE(20);
      const end = rawPtr + rawSize;
      if (end > maxEnd) maxEnd = end;
    }

    if (maxEnd <= 0 || maxEnd >= stat.size) return null;
    return maxEnd;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

async function extractPeOverlayZip(filePath, destDir) {
  const offset = readPeOverlayOffset(filePath);
  if (offset === null) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-overlay-"));
  const overlayPath = path.join(tmpDir, "overlay.bin");

  try {
    await copyRangeToFile(filePath, overlayPath, offset);
    const result = await extractZipPayload(overlayPath, destDir);
    if (!result) return null;
    return { overlayPath, result };
  } finally {
    safeRm(tmpDir);
  }
}

function extractAsarToDir(filePath, destDir) {
  ensureDir(destDir);
  return Asar.extractAsar(filePath, destDir);
}

module.exports = {
  extractZipPayload,
  extractPeOverlayZip,
  extractAsarToDir,
  readPeOverlayOffset,
  readZipEntries: Zip.readZipEntries,
  listAsarEntries: Asar.listAsarEntries,
  readAsarHeader: Asar.readAsarHeader
};
