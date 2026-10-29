"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");

// The digest of a module and every module it loads by relative path. A cache
// keyed by it is not reused after an application update that changes any of
// them. Null when a source cannot be read.
const identities = new Map();
function identity(entry) {
  if (identities.has(entry)) return identities.get(entry);
  let value = null;
  try {
    const hash = crypto.createHash("sha256"), seen = new Set(), pending = [entry];
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      hash.update(`${path.relative(path.dirname(entry), file)}\0${text}\0`);
      for (const match of text.matchAll(/(?:require\(|\bfrom |import\()\s*["'](\.{1,2}\/[^"']+)["']/g))
        pending.push(require.resolve(path.resolve(path.dirname(file), match[1])));
    }
    value = hash.digest("hex");
  } catch {}
  identities.set(entry, value);
  return value;
}

module.exports = {identity};
