const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../writable-input"), Native = require("../runtime/bundled-native");
const LIMITS = Object.freeze({ files: 4096, bytes: 256 * 1024 * 1024, metadata: 4 * 1024 * 1024 });
function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_")) delete env[key];
  return env;
}
function verify(directory, { parseMetadata, entryFile, label }) {
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`The ${label} shader resources must be an ordinary directory.`);
  const record = parseMetadata(JSON.parse(Native.readRegular(path.join(directory, "metadata.json"), LIMITS.metadata).bytes));
  if (!Array.isArray(record.files) || !record.files.length || record.files.length > LIMITS.files)
    throw new Error(`The ${label} shader resource inventory is invalid.`);
  const names = new Set(); let size = 0;
  const files = record.files.map(row => {
    const relative = Native.relativeFile(row.path);
    if (relative === "metadata.json" || names.has(relative) || !Number.isSafeInteger(row.size) || row.size < 0 ||
        (size += row.size) > LIMITS.bytes || !/^[a-f0-9]{64}$/.test(row.sha256 || ""))
      throw new Error(`The ${label} shader resource inventory is invalid.`);
    names.add(relative);return { path: relative, size: row.size, sha256: row.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (!names.has(entryFile)) throw new Error(`The prepared ${label} shader is missing.`);
  let entries = 0;
  function visit(relative = "", depth = 0) {
    if (depth > 64) throw new Error("The shader resource folders exceed their depth limit.");
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (++entries > LIMITS.files * 2) throw new Error("The shader contains too many resource entries.");
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) visit(name, depth + 1);
      else if (!entry.isFile() || name !== "metadata.json" && !names.has(name)) throw new Error(`The ${label} shader contains an undeclared resource.`);
    }
  }
  // Reject aliases before reading declared resources through parent folders.
  visit();
  for (const row of files) {
    const stored = Native.readRegular(path.join(directory, row.path), LIMITS.bytes);
    if (stored.sha256 !== row.sha256 || stored.size !== row.size) throw new Error(`A prepared ${label} shader resource changed.`);
  }
  const revision = crypto.createHash("sha256").update(JSON.stringify([1, files])).digest("hex");
  return { metadata: record, files, revision, effect: path.join(directory, entryFile), directory };
}
async function prepare(file, options, provider) {
  const { root, userDataDir, execute, signal } = options, directory = path.join(userDataDir, "graphics", "shaders", provider.id);
  Writable.assertOwnDirectory(userDataDir, directory);
  const temporary = path.join(directory, ".prepare-" + crypto.randomUUID());
  try {
    await execute(path.join(root, provider.helper), ["--prepare", provider.input(file), temporary],
      { env: environment(), signal, timeout: 120000, maxBuffer: LIMITS.metadata });
    const result = verify(temporary, provider), destination = path.join(directory, result.revision);
    if (fs.existsSync(destination)) { const previous = verify(destination, provider);if (previous.revision !== result.revision) throw new Error("The prepared shader cache changed."); }
    else {
      try { await fs.promises.rename(temporary, destination); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;verify(destination, provider); }
    }
    return { ...result, directory: destination, effect: path.join(destination, provider.entryFile) };
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
module.exports = { LIMITS, environment, verify, prepare };
