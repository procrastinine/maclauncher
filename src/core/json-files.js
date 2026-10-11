const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function readJsonObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Keep readers from seeing partially written launcher metadata or cheat settings.
function writeJsonAtomic(filePath, value) {
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error(`JSON destination is not a regular file: ${filePath}`);
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx", mode });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return filePath;
}

module.exports = { readJsonObject, writeJsonAtomic };
