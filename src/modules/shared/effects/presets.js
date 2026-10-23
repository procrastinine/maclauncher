const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Plan = require("./plan"), Writable = require("../writable-input");
const LIMITS = Object.freeze({ entries: 128, bytes: 16 * 1024 * 1024, name: 128 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const nameKey = value => value.normalize("NFKC").toLocaleLowerCase("en-US");
function location(root) {
  if (!path.isAbsolute(root || "")) throw new Error("Graphics presets require the application's data directory.");
  return path.join(root, "graphics", "effects-presets.json");
}
function name(value) {
  if (typeof value !== "string" || !value.trim() || value.length > LIMITS.name || /[\x00-\x1f]/.test(value))
    throw new Error("Enter a preset name of up to 128 characters without control characters.");
  return value.trim();
}
function read(root) {
  const file = location(root);
  Writable.assertOwnDirectory(root, path.dirname(file), { create: false });
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return [];throw error; }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.bytes) throw new Error();
    const data = JSON.parse(fs.readFileSync(file, "utf8")), ids = new Set(), names = new Set();
    if (data.schema !== 1 || !Array.isArray(data.presets) || data.presets.length > LIMITS.entries) throw new Error();
    return data.presets.map(row => {
      if (!row || !UUID.test(row.id) || ids.has(row.id) || names.has(nameKey(name(row.name))) ||
          !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 1) throw new Error();
      ids.add(row.id);names.add(nameKey(row.name));
      return { id: row.id, name: name(row.name), updatedAt: row.updatedAt, plan: Plan.validate(row.plan) };
    });
  } catch { throw new Error("Graphics presets could not be read. Restore the saved preset file before editing presets."); }
}
function write(root, presets) {
  const contents = JSON.stringify({ schema: 1, presets }, null, 2) + "\n";
  if (presets.length > LIMITS.entries || Buffer.byteLength(contents) > LIMITS.bytes)
    throw new Error("The graphics preset library is full. Remove an unused preset before saving another.");
  Writable.atomicWrite(location(root), contents, { root });
  return presets;
}
function find(rows, id, updatedAt) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Choose a graphics preset.");
  const index = rows.findIndex(row => row.id === id);
  if (index < 0) throw new Error("The graphics preset was removed. Reload the preset library.");
  if (updatedAt !== rows[index].updatedAt) throw new Error("The graphics preset changed in another window. Reload it before saving.");
  return index;
}
function save(root, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["id", "name", "plan", "updatedAt"].includes(key)))
    throw new Error("Choose a preset name and Advanced effects chain.");
  const rows = read(root), index = value.id == null ? -1 : find(rows, value.id, value.updatedAt), nextName = name(value.name);
  if (rows.some((row, i) => i !== index && nameKey(row.name) === nameKey(nextName))) throw new Error("A graphics preset with this name already exists.");
  const row = { id: index < 0 ? crypto.randomUUID() : rows[index].id, name: nextName,
    updatedAt: Math.max(Date.now(), index < 0 ? 1 : rows[index].updatedAt + 1), plan: Plan.validate(value.plan) };
  if (index < 0) rows.push(row);else rows[index] = row;
  write(root, rows);return row;
}
function remove(root, id, updatedAt) {
  const rows = read(root), index = find(rows, id, updatedAt);
  rows.splice(index, 1);return write(root, rows);
}
module.exports = { LIMITS, location, list: read, save, remove };
