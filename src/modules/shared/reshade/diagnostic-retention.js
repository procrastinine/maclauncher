const fs = require("node:fs"), path = require("node:path");
const LOG_NAME = /^(?:diagnostics|gpu-timing)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.([1-9][0-9]*)\.jsonl$/;
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Native streams have individual byte/record limits. Bound their history too,
// retaining recent completed streams and leaving live writers untouched.
function pruneDiagnostics(directory, { maxFiles = 32, maxBytes = 8 * 1024 * 1024, isProcessAlive = processAlive } = {}) {
  const files = [];
  let names;try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    const match = LOG_NAME.exec(name); if (!match) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || isProcessAlive(Number(match[1]))) continue;
      files.push({ file, size: stat.size, mtime: stat.mtimeMs });
    } catch { /* A writer or concurrent launch may have already removed it. */ }
  }
  files.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  let kept = 0, bytes = 0;
  for (const file of files) {
    if (kept < maxFiles && bytes + file.size <= maxBytes) { kept++; bytes += file.size; continue; }
    try { fs.unlinkSync(file.file); } catch { /* Diagnostics never prevent Play. */ }
  }
}

module.exports = { pruneDiagnostics };
