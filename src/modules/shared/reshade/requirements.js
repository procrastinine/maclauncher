const fs = require("node:fs"), path = require("node:path");
const Native = require("../runtime/bundled-native");
function flags(value) {
  if (!value || typeof value.depth !== "boolean" || typeof value.motion !== "boolean") throw new Error("Invalid shader input requirements.");
  return { depth: value.depth, motion: value.motion };
}
function read(directory, technique) {
  const file = path.join(directory, "requirements.json");
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(Native.readRegular(file, 1024 * 1024).bytes);
  const requirements = technique ? record.techniques && Object.hasOwn(record.techniques, technique) ? flags(record.techniques[technique]) : null : flags(record);
  if (technique && !requirements) throw new Error("The selected shader technique is unavailable.");
  return requirements;
}
module.exports = { read };
