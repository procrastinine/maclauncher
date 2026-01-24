const fs = require("node:fs");
const path = require("node:path");
const { createCheatsHelpers } = require("../../shared/cheats/cheats");

const cheatsSchema = require("./schema.json");
const cheatsHelpers = createCheatsHelpers(cheatsSchema);

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function ensureCheatsRuntime(userDataDir) {
  if (!userDataDir) return null;
  const sourcePath = path.resolve(__dirname, "runtime.rb");
  const source = readText(sourcePath);
  if (!source) return null;
  const destDir = path.join(userDataDir, "modules", "rgss", "cheats");
  const destPath = path.join(destDir, "maclauncher-cheats.rb");
  fs.mkdirSync(destDir, { recursive: true });
  const existing = readText(destPath);
  if (existing !== source) {
    fs.writeFileSync(destPath, source, "utf8");
  }
  return destPath;
}

module.exports = {
  cheatsSchema,
  cheatsHelpers,
  ensureCheatsRuntime
};
