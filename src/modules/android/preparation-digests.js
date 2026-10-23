const fs = require("node:fs"), path = require("node:path");
const Writable = require("../shared/writable-input");

// This index belongs to the launcher, beside (not inside) writable Android data.
// A digest is reusable only for the same current filesystem object and times.
// ctime also detects same-size edits whose original mtime was restored.
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
function open(root) {
  const file = path.join(root, ".preparation-digests.json");
  let previous = {};
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size <= 32 * 1024 ** 2) {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.version === 1 && value.files && typeof value.files === "object" && !Array.isArray(value.files)) previous = value.files;
    }
  } catch { /* An absent or damaged index is rebuilt from the actual bytes. */ }
  const files = Object.create(null);
  return {
    get(key) {
      const value = previous[key];
      return value && typeof value.identity === "string" && /^[a-f0-9]{64}$/.test(value.sha256 || "") ? value : null;
    },
    set(key, value) { files[key] = value; },
    save() {
      // Retain only this preparation's inputs; converter updates and retired
      // generations do not accumulate an unbounded history of file identities.
      const value = JSON.stringify({ version: 1, files });
      if (value !== JSON.stringify({ version: 1, files: previous })) Writable.atomicWrite(file, value, { root });
    }
  };
}
module.exports = { open, identity };
