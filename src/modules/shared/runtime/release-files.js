const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Architecture = require("./architecture");
const { throwIfAborted } = require("./download-utils");

// Archive formats the shared runtime installer extracts, in preference order.
const ARCHIVE_FORMATS = Object.freeze([".zip", ".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2", ".dmg", ".tar"]);
const MAC_WORDS = "mac|macos|macosx|osx|darwin|apple";
// Files beside a Mac download: other systems and CPUs, symbols and sources.
const OTHER_WORDS = "linux|windows|win|win32|win64|android|ios|web|wasm|freebsd|debug|symbols|dsym|dbg|src|source|sources|riscv64|ppc|ppc64|ppc64le|s390x|i386|i686|armhf|armv7";
const word = (name, words) => new RegExp(`(?:^|[^a-z0-9])(?:${words})(?=[^a-z]|$)`, "i").test(name);
function archiveFormat(name, formats = ARCHIVE_FORMATS) {
  const lower = String(name || "").toLowerCase();
  return formats.find(extension => lower.endsWith(extension)) || null;
}

// A publisher's Mac downloads, one per CPU: a CPU word in the name selects it,
// a name without one serves every CPU. The publisher's current file name wins,
// then the caller's format order. A disk image needs no platform word.
function macDownloads(assets, { preferred = [], formats = ARCHIVE_FORMATS, platformWord = true } = {}) {
  const names = [].concat(preferred).filter(Boolean);
  const candidates = (Array.isArray(assets) ? assets : []).filter(asset => {
    const name = String(asset?.name || ""), extension = archiveFormat(name, formats);
    return extension && !word(name, OTHER_WORDS) && (names.includes(name) || !platformWord || extension === ".dmg" || word(name, MAC_WORDS));
  });
  const rank = asset => names.includes(asset.name) ? names.indexOf(asset.name) : names.length + formats.indexOf(archiveFormat(asset.name, formats));
  const selected = new Map();
  for (const asset of candidates.sort((a, b) => rank(a) - rank(b))) {
    const named = Architecture.assetArchitecture(asset.name), key = named === "universal" ? null : named;
    if (!selected.has(key)) selected.set(key, { asset, architecture: named });
  }
  return [...selected.values()];
}

// A publisher may move its files into a folder next to other files. The known
// relative paths win in order; otherwise a bounded breadth-first search finds
// the shallowest folder containing one. A pattern matches an entry name;
// `files` accepts regular files only. Archive metadata, hidden entries, links
// and app bundles are not searched.
function locatePackaged(root, relatives, { depth = 3, files = false } = {}) {
  const wanted = [].concat(relatives), accept = item => !item.isSymbolicLink() && (!files || item.isFile());
  const entries = directory => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).filter(item => !item.name.startsWith(".") && item.name !== "__MACOSX" && !item.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };
  let level = [root];
  for (let current = 0; current <= depth && level.length; current += 1) {
    for (const relative of wanted) for (const directory of level) {
      if (relative instanceof RegExp) {
        const match = entries(directory).find(item => relative.test(item.name) && accept(item));
        if (match) return path.join(directory, match.name);
        continue;
      }
      const candidate = path.join(directory, relative);
      try { if (accept(fs.lstatSync(candidate))) return candidate; } catch {}
    }
    level = level.flatMap(directory => entries(directory).filter(item => item.isDirectory() && !/\.app$/i.test(item.name))
      .map(item => path.join(directory, item.name))).slice(0, 256);
  }
  return null;
}

// Publishers change archive formats between releases; every listed format
// installs into a new or existing folder.
async function extractArchive(archivePath, destination, signal) {
  throwIfAborted(signal);
  const format = archiveFormat(archivePath);
  if (!format) throw new Error("Unsupported runtime archive.");
  fs.mkdirSync(destination, { recursive: true });
  if (format === ".dmg") return require("./dmg").extractDmg(archivePath, destination, signal);
  const isZip = format === ".zip";
  return new Promise((resolve, reject) => {
    const child = spawn(isZip ? "/usr/bin/ditto" : "/usr/bin/tar",
      isZip ? ["-x", "-k", archivePath, destination] : ["-xf", archivePath, "-C", destination],
      { ...(signal ? { signal } : {}), stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { if (error.length < 8192) error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Runtime extraction failed (${code}): ${error}`)));
  });
}

// Installs one named file or bundle from any supported archive at the
// destination's top level, wherever the release placed it.
async function extractPayload(archivePath, destination, signal, { payloadName, project = "Runtime", copy } = {}) {
  if (archiveFormat(archivePath) === ".dmg")
    return require("./dmg").extractDmg(archivePath, destination, signal, { payloadName, project, ...(copy ? { copy } : {}) });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".extract-"));
  try {
    await extractArchive(archivePath, staging, signal);
    const source = locatePackaged(staging, payloadName);
    if (!source) throw new Error(`The ${project} download does not contain ${payloadName}.`);
    (copy || fs.renameSync)(source, path.join(destination, payloadName));
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { ARCHIVE_FORMATS, archiveFormat, macDownloads, locatePackaged, extractArchive, extractPayload };
