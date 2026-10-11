const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_FILES = new Set([
  "0.txt",
  "00.txt",
  "0.utf",
  "0.utf.txt",
  "00.utf",
  "00.utf.txt",
  "pscript.dat",
  "nscript.dat",
  "nscript.___",
  "nscr_sec.dat",
  "onscript.nt2",
  "onscript.nt3"
]);
const CONFIG_FILES = new Set(["pns.cfg", "ons.cfg"]);
const ARCHIVE_EXTS = new Set([".nsa", ".sar"]);
const SCRIPT_PRIORITY = ["0.txt", "00.txt", "0.utf", "0.utf.txt", "00.utf", "00.utf.txt", "nscr_sec.dat", "nscript.___", "nscript.dat", "pscript.dat", "onscript.nt2", "onscript.nt3"];
const MAX_DETECTION_SCRIPT_BYTES = 64 * 1024;
function readRootEntries(rootDir, helpers = {}) {
  try { return typeof helpers.readdir === "function" ? helpers.readdir(rootDir) : fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch { return []; }
}

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

function scanRoot(rootDir, helpers = {}) {
  const entries = readRootEntries(rootDir, helpers);
  const names = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  return scanEntries(names);
}

function inspectRootScript(rootDir, helpers = {}) {
  const names = readRootEntries(rootDir, helpers).filter(item => item.isFile()).map(item => item.name);
  const name = SCRIPT_PRIORITY.map(candidate => names.find(item => item.toLowerCase() === candidate)).find(Boolean);
  if (!name) return null;
  const file = path.join(rootDir, name), lower = name.toLowerCase();
  if (lower === "nscript.___" || /^onscript\.nt[23]$/.test(lower)) {
    // These formats require their interpreter/key table. A detection pass
    // must not scan a large executable merely to decrypt a possible script.
    return { type: "nscripter-script-format", path: file, format: lower === "nscript.___" ? "exe-key-table" : lower,
      validation: "reserved encrypted script path" };
  }
  const stat = typeof helpers.stat === "function" ? helpers.stat(file) : fs.statSync(file);
  if (!stat?.isFile() || stat.size === 0) return false;
  const size = Math.min(stat.size, MAX_DETECTION_SCRIPT_BYTES);
  let bytes;
  if (typeof helpers.readBytes === "function") bytes = helpers.readBytes(file, 0, size);
  else {
    const handle = fs.openSync(file, "r");
    try { bytes = Buffer.alloc(size); bytes = bytes.subarray(0, fs.readSync(handle, bytes, 0, size, 0)); }
    finally { fs.closeSync(handle); }
  }
  if (!bytes?.length) return false;
  bytes = Buffer.from(bytes);
  const format = lower === "nscr_sec.dat" ? "nscr-sec" : /^(?:nscript|pscript)\.dat$/.test(lower) ? "xor-84" : /\.utf(?:\.txt)?$/.test(lower) ? "utf8-plain" : "plain";
  if (format === "xor-84") for (let index = 0; index < bytes.length; index++) bytes[index] ^= 0x84;
  if (format === "nscr-sec") {
    const magic = [0x79, 0x57, 0x0d, 0x80, 0x04];
    for (let index = 0; index < bytes.length; index++) bytes[index] ^= magic[index % magic.length];
  }
  const text = bytes.toString("latin1").replace(/^\xEF\xBB\xBF/, "").replace(/\r\n?/g, "\n");
  const label = /(?:^|\n)[ \t]*\*(define|start)(?=[ \t:\n]|$)/i.exec(text);
  const command = /(?:^|\n)[ \t]*(game|end|nsa|caption|defsub|rmenu|setwindow|savenumber|textgosub|pretextgosub)(?=[ \t:\n]|$)/i.exec(text);
  if (!label || !command) return false;
  return { type: "nscripter-script-header", path: file, format, prefixBytes: bytes.length,
    markers: ["*" + label[1].toLowerCase(), command[1].toLowerCase()] };
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
  inspectRootScript,
  MAX_DETECTION_SCRIPT_BYTES,
  isNscripterRoot
};
