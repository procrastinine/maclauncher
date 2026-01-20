const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_FILES = new Set([
  "0.txt",
  "00.txt",
  "0.utf",
  "nscript.dat",
  "nscript.___",
  "nscr_sec.dat",
  "onscript.nt2",
  "onscript.nt3"
]);
const CONFIG_FILES = new Set(["pns.cfg", "ons.cfg"]);
const ARCHIVE_EXTS = new Set([".nsa", ".sar"]);

function scanEntries(names) {
  let hasScript = false;
  let hasArchive = false;
  let hasConfig = false;

  for (const entry of names || []) {
    const normalized = String(entry || "").replace(/\\/g, "/");
    const base = path.basename(normalized).toLowerCase();
    if (!base) continue;
    if (SCRIPT_FILES.has(base)) hasScript = true;
    if (CONFIG_FILES.has(base)) hasConfig = true;
    if (ARCHIVE_EXTS.has(path.extname(base))) hasArchive = true;
  }

  return { hasScript, hasArchive, hasConfig };
}

function scanRoot(rootDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const names = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  return scanEntries(names);
}

function isNscripterRoot(scan) {
  if (!scan) return false;
  return scan.hasScript || (scan.hasArchive && scan.hasConfig);
}

module.exports = {
  SCRIPT_FILES,
  CONFIG_FILES,
  ARCHIVE_EXTS,
  scanEntries,
  scanRoot,
  isNscripterRoot
};
