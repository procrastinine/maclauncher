const fs = require("node:fs");
const path = require("node:path");

function makeExecutable(entry) {
  const scriptPath = entry?.moduleData?.executablePath;
  if (entry?.moduleData?.launchKind !== "script" || typeof scriptPath !== "string" || !scriptPath ||
    typeof entry.gamePath !== "string" || path.resolve(scriptPath) !== path.resolve(entry.gamePath)) {
    throw new Error("Select an imported script to change its executable permissions.");
  }
  const stat = fs.statSync(scriptPath);
  if (!stat.isFile()) throw new Error("The selected script is not a regular file.");
  fs.chmodSync(scriptPath, (stat.mode & 0o7777) | 0o111);
  return { executable: true, executablePath: scriptPath };
}

module.exports = { makeExecutable };
