const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Bundled = require("../../../shared/runtime/bundled-native");
const { assertOwnDirectory } = require("../../../shared/writable-input");
const compatibility = require("./image-cache.json");

// This locates a preparation, not a replacement image validator. The original
// prepare helper still verifies the archive identity and complete overlay plan
// under its image leases before returning a usable derived image.
function imageIdentity(runtime, image) {
  const inventory = new Map(runtime.manifest.files.map(file => [file.path, file]));
  const inputs = new Map(), visited = new Set();
  function manifest(relative, included = false) {
    relative = Bundled.relativeFile(relative);
    if (visited.has(relative)) throw new Error("The AIM image overlay contains a repeated manifest.");
    visited.add(relative);
    const record = input(relative), stored = Bundled.readRegular(path.join(runtime.root, relative), Bundled.LIMITS.manifestBytes);
    if (stored.sha256 !== record.sha256) throw new Error("The AIM image overlay changed.");
    let table;
    for (const raw of stored.bytes.toString("utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[[")) table = line.match(/^\[\[(add|replace|remove|include)\]\](?:\s*(?:#.*)?)$/)?.[1];
      if (!/^source\s*=/.test(line)) continue;
      // AIM accepts single-line TOML basic/literal source strings. Cache keys
      // deliberately fail closed on syntax the launcher cannot enumerate.
      const match = line.match(/^source\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
      if (!match || !table || table === "remove") throw new Error("The AIM image overlay source format is unsupported.");
      const source = match[1][0] === "'" ? match[1].slice(1, -1) : JSON.parse(match[1]);
      if (table === "include") {
        if (included) throw new Error("The AIM image overlay contains nested manifests.");
        manifest(source, true);
      } else input(source);
    }
  }
  function input(relative) {
    relative = Bundled.relativeFile(relative);
    const record = inventory.get(relative);
    if (!record || !/^[a-f0-9]{64}$/.test(record.sha256 || "")) throw new Error("The AIM image source inventory is incomplete.");
    inputs.set(relative, record.sha256); return record;
  }
  manifest("image/overlay.toml");
  return crypto.createHash("sha256").update(JSON.stringify([1, image.sha256, compatibility.profile,
    [...inputs].sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}

function directoryForImage(userDataDir, runtime, image, legacy = compatibility.legacy) {
  const identity = imageIdentity(runtime, image), root = path.join(userDataDir, "android", "runtimes", "aim");
  const directory = path.join(root, "images", identity);
  assertOwnDirectory(userDataDir, directory, { create: false });
  function prepared(candidate) {
    let stored;
    try { stored = fs.lstatSync(path.join(candidate, "system.dmg")); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    return stored.isFile() && !stored.isSymbolicLink();
  }
  if (prepared(directory)) return directory;
  const compatible = legacy.find(row => row.identity === identity);
  for (const version of compatible?.versions || []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version) || version.includes("..")) throw new Error("The AIM image cache location is invalid.");
    const candidate = path.join(root, version);
    assertOwnDirectory(userDataDir, candidate, { create: false });
    if (prepared(candidate)) return candidate;
  }
  return directory;
}

module.exports = { imageIdentity, directoryForImage };
