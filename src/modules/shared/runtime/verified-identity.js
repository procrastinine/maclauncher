const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { hasFineChangeTime } = require("../file-time");

// Caller-owned verification policy, with bounded successful-result reuse.
// A null identity cannot authorize reuse. No in-flight result is shared.
function createVerifiedIdentityCache({ maximum = 128 } = {}) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32768) throw Error("Invalid verification cache limit.");
  const entries = new Map();
  const keyFor = value => value == null ? null : JSON.stringify(value);
  return {
    clear(key) { if (key === undefined) entries.clear(); else entries.delete(key); },
    verify(key, { identity, verify }) {
      const previous = entries.get(key);
      let before;
      try { before = keyFor(identity(previous?.value)); }
      catch (error) { entries.delete(key); throw error; }
      if (before !== null && previous?.identity === before) {
        entries.delete(key); entries.set(key, previous);
        return previous.value;
      }
      entries.delete(key);
      const failed = error => { entries.delete(key); throw error; };
      const finished = value => {
        try {
          if (value !== false && value !== null && before !== null && keyFor(identity(value)) === before) {
            if (entries.size >= maximum) entries.delete(entries.keys().next().value);
            entries.set(key, { identity: before, value });
          }
          return value;
        } catch (error) { return failed(error); }
      };
      try {
        const value = verify();
        return value && typeof value.then === "function" ? value.then(finished, failed) : finished(value);
      } catch (error) { return failed(error); }
    }
  };
}

function statFacts(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].map(String);
}

// Precise facts only: a whole-second or unavailable ctime always needs bytes.
function fileIdentity(file) {
  try {
    const own = fs.lstatSync(file, { bigint: true });
    if (!hasFineChangeTime(own)) return null;
    const result = { own: statFacts(own) };
    if (own.isSymbolicLink()) {
      result.link = fs.readlinkSync(file);
      result.resolved = fs.realpathSync(file);
      const target = fs.statSync(result.resolved, { bigint: true });
      if (!hasFineChangeTime(target)) return null;
      result.target = statFacts(target);
    }
    return result;
  } catch { return null; }
}

// Only digest/size/mode facts are retained, never payload buffers. Inventory,
// expected hashes, aliases, dependencies and CPU policy remain with callers.
// One manifest can contain 20,000 files; leave room for its dependency facts.
const digests = createVerifiedIdentityCache({ maximum: 32768 });
function fileDigest(file, { maximum = Number.MAX_SAFE_INTEGER, noFollow = false } = {}) {
  const absolute = path.resolve(file), key = JSON.stringify([absolute, noFollow]);
  const result = digests.verify(key, {
    identity: () => fileIdentity(absolute),
    verify() {
      const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (noFollow ? fs.constants.O_NOFOLLOW || 0 : 0));
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > BigInt(maximum)) throw Error("Runtime file is not regular or exceeds its limit.");
        const buffer = Buffer.alloc(64 * 1024);
        const read = () => {
          const hash = crypto.createHash("sha256");
          let position = 0, count;
          while ((count = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
            hash.update(buffer.subarray(0, count)); position += count;
          }
          if (BigInt(position) !== before.size) throw Error("Runtime file changed while being read.");
          return hash.digest("hex");
        };
        const sha256 = read();
        if (!hasFineChangeTime(before) && read() !== sha256) throw Error("Runtime file changed while being read.");
        if (JSON.stringify(statFacts(before)) !== JSON.stringify(statFacts(fs.fstatSync(fd, { bigint: true }))))
          throw Error("Runtime file changed while being read.");
        return Object.freeze({ size: Number(before.size), mode: Number(before.mode & 0o777n), sha256 });
      } finally { fs.closeSync(fd); }
    }
  });
  if (result.size > maximum) { digests.clear(key); throw Error("Runtime file exceeds its limit."); }
  return result;
}

module.exports = { createVerifiedIdentityCache, fileIdentity, fileDigest };
