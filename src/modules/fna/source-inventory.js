const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { hasFineChangeTime } = require("../shared/file-time");

const LIMITS = { files: 50000, bytes: 4 * 1024 ** 3, depth: 32, cacheBytes: 32 * 1024 ** 2, chunkBytes: 256 * 1024 };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function changedError() {
  return Object.assign(new Error("Game files changed during preparation. Try again."), { code: "SOURCE_CHANGED" });
}
function checkSignal(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Game preparation cancelled."), { name: "AbortError", code: "ABORT_ERR" });
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function regularStat(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw changedError();
  return stat;
}
function hashRegularFile(file, expected, signal) {
  checkSignal(signal);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (identity(opened) !== expected) throw changedError();
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size > LIMITS.bytes) throw new Error("FNA game preparation exceeds supported bounds.");
    const buffer = Buffer.allocUnsafe(LIMITS.chunkBytes);
    const readDigest = () => {
      const hash = crypto.createHash("sha256");
      let offset = 0;
      while (offset < size) {
        checkSignal(signal);
        const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!read) throw changedError();
        hash.update(buffer.subarray(0, read)); offset += read;
      }
      return hash.digest("hex");
    };
    const digest = readDigest();
    // Equal coarse stamps cannot establish that a streaming read was stable.
    if (!hasFineChangeTime(opened) && readDigest() !== digest) throw changedError();
    if (identity(fs.fstatSync(descriptor, { bigint: true })) !== expected || identity(regularStat(file)) !== expected) throw changedError();
    return digest;
  } finally { fs.closeSync(descriptor); }
}
// Explicit reachable transformation inputs only: never enumerate game assets.
function inspectTransforms(inputFiles, {previous, signal} = {}) {
  const saved = new Map(Array.isArray(previous) ? previous.filter(item => item && typeof item.path === "string").map(item => [item.path, item]) : []);
  const files = new Map();let bytes = 0;
  if (inputFiles.length > 32) throw new Error("FNA has too many managed conversion inputs.");
  for (const input of inputFiles) {
    const file = fs.realpathSync(input), stat = regularStat(file), observed = identity(stat), cached = saved.get(file);
    if ((bytes += Number(stat.size)) > LIMITS.bytes) throw new Error("FNA conversion exceeds supported bounds.");
    const sha256 = hasFineChangeTime(stat) && cached?.identity === observed && /^[a-f0-9]{64}$/.test(cached.sha256 || "") ? cached.sha256 : hashRegularFile(file, observed, signal);
    files.set(file, {path: file, identity: observed, sha256});
  }
  const assertUnchanged = () => {
    checkSignal(signal);
    for (const [file, record] of files) {
      const stat = regularStat(file);
      if (identity(stat) !== record.identity || !hasFineChangeTime(stat) && hashRegularFile(file, record.identity, signal) !== record.sha256) throw changedError();
    }
  };
  assertUnchanged();
  return {files, assertUnchanged, digest: sha(JSON.stringify([...files.values()].map(item => [item.path, item.sha256])))};
}
module.exports = {LIMITS, inspectTransforms, hashRegularFile, identity, changedError};
