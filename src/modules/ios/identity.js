const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function vendorIdentifier(root) {
  const data = path.join(root, "data"); Writable.assertOwnDirectory(root, data);
  const file = path.join(data, "vendor-identifier");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isFile() && stat.size === 37) {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (UUID.test(saved)) return saved;
  }
  const value = crypto.randomUUID();
  Writable.atomicWrite(file, value + "\n", { root });
  return value;
}
module.exports = { vendorIdentifier };
