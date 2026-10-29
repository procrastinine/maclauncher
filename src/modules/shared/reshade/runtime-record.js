const fs = require("node:fs"), path = require("node:path");

// runtime.json of a graphics root, parsed once per file identity. Preparation
// and catalog builds read it many times; a reinstalled or replaced payload has
// a new identity and is read again. The record is frozen and shared.
const records = new Map(), LIMIT = 8;
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freeze(value[key]);
  }
  return value;
}
function read(root) {
  const file = path.join(root, "runtime.json"), stat = fs.statSync(file, {bigint: true});
  const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"), cached = records.get(file);
  if (cached?.stamp === stamp) return cached.record;
  const record = freeze(JSON.parse(fs.readFileSync(file, "utf8")));
  records.delete(file);
  if (records.size >= LIMIT) records.delete(records.keys().next().value);
  records.set(file, {stamp, record});
  return record;
}
module.exports = {read, clear: () => records.clear()};
