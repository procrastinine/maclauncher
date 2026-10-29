const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Only disposable reports use this writer. Editable exports keep their own lifecycle.
function writeLatestReport(directory, name, report, { legacyFiles, legacyDirectories } = {}) {
  if (path.basename(name) !== name || !name.endsWith(".json")) throw new Error("Invalid report name.");
  const text = JSON.stringify(report, null, 2) + "\n";
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Report directory contains a symlink.");
  const previous = fs.readdirSync(directory);
  const outputPath = path.join(directory, name), temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  // Publish first; a failed report must leave the previous successful result intact.
  for (const oldName of previous) {
    if (oldName === name) continue;
    const oldPath = path.join(directory, oldName);
    try {
      const stat = fs.lstatSync(oldPath);
      if (stat.isFile() && legacyFiles?.test(oldName)) fs.unlinkSync(oldPath);
      else if (stat.isDirectory() && legacyDirectories?.test(oldName)) {
        // Preserve anything added to an old output by its owner.
        const contents = fs.readdirSync(oldPath);
        if (contents.length !== 1 || contents[0] !== name || !fs.lstatSync(path.join(oldPath, name)).isFile()) continue;
        fs.unlinkSync(path.join(oldPath, name));
        fs.rmdirSync(oldPath);
      }
    } catch { /* A concurrent reader/removal or a retained file must not hide the new report. */ }
  }
  return outputPath;
}

module.exports = { writeLatestReport };
