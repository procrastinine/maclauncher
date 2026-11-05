const fs = require("node:fs");
const { cloneOrCopySync } = require("./copy-file");
const path = require("node:path");
const crypto = require("node:crypto");

// Current game paths are authoritative. Normal preparation does not read or
// load historical layouts; the one-time migration owns their conversion.
const INPUT_FIELDS = new Set(["gameId", "gamePath", "importPath", "containerData", "contentRootDir", "indexDir", "indexHtml"]);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function assertPreservesExternalEnvironments(entry, target) {
  const rows = [...Object.values(entry?.runtimeSettings || {}), ...Object.values(entry?.runtimeData || {})];
  for (const row of rows) {
    let reference = row?.environmentReference;
    if (typeof reference === "string") { try { reference = JSON.parse(reference); } catch { continue; } }
    if (!reference || reference.kind === "private" || !path.isAbsolute(reference.path || "")) continue;
    const canonical = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
    const root = canonical(reference.path), candidate = canonical(target);
    if (inside(root, candidate) || inside(candidate, root)) throw new Error("This operation would remove or move an external Windows environment. Its directory was left in place.");
  }
}
function assertOwnDirectory(root, directory, { create = true } = {}) {
  root = path.resolve(root); directory = path.resolve(directory);
  if (!inside(root, directory)) throw new Error("Output escapes its owned game directory.");
  // The configured userData parent may itself be an alias. Everything below
  // the game directory must be real, so relative writes cannot escape it.
  let current = root;
  for (const component of ["", ...path.relative(root, directory).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = lstat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Writable game directories must not be aliases.");
    if (!stat && create) {
      try { fs.mkdirSync(current, { recursive: current === root, mode: 0o700 }); }
      catch (error) {
        // Independent workers may create a shared parent after lstat. Accept
        // only the same ordinary directory we would have accepted above.
        const published = error.code === "EEXIST" ? lstat(current) : null;
        if (!published?.isDirectory() || published.isSymbolicLink()) throw error;
      }
    }
  }
}
function atomicCopy(source, destination, { root = path.dirname(destination), preserveTimes = true } = {}) {
  assertOwnDirectory(root, path.dirname(destination));
  const existing = lstat(destination);
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new Error("File output conflicts with a directory.");
  const temporary = path.join(path.dirname(destination), ".maclauncher-copy-" + crypto.randomUUID());
  try {
    cloneOrCopySync(source, temporary);
    const stat = fs.statSync(source);
    fs.chmodSync(temporary, stat.mode | 0o600);
    if (!preserveTimes) { const now = new Date(); fs.utimesSync(temporary, now, now); }
    // rename replaces a leaf link, rather than modifying its original target.
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function atomicWrite(destination, contents, { root = path.dirname(destination), encoding = "utf8" } = {}) {
  assertOwnDirectory(root, path.dirname(destination));
  const existing = lstat(destination);
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new Error("File output conflicts with a directory.");
  const temporary = path.join(path.dirname(destination), ".maclauncher-write-" + crypto.randomUUID());
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600, encoding });
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function sourceRoot(entry) { return entry?.contentRootDir || entry?.gamePath; }
function sourceEntry(entry) { return entry; }
function runtimeEntry(entry) { return entry; }
function contentReadRoots() { return []; }
function prepareModuleInput(entry, registry, context = {}) {
  context.signal?.throwIfAborted();
  const mod = registry.getModule(entry.moduleId || entry.engine);
  if (typeof mod?.prepareInput !== "function") return entry;
  const canonical = JSON.stringify(Object.fromEntries([...INPUT_FIELDS].map(field => [field, entry[field]])));
  const input = mod.prepareInput(entry, context) || entry;
  if (typeof input?.then === "function") throw new Error("Module input preparation must return synchronously.");
  if (JSON.stringify(Object.fromEntries([...INPUT_FIELDS].map(field => [field, entry[field]]))) !== canonical) {
    throw new Error("Module input preparation changed a canonical game identity.");
  }
  for (const field of ["gameId", "gamePath", "importPath", "containerData"]) {
    if (input[field] !== entry[field]) throw new Error("Module input preparation changed a canonical game identity.");
  }
  return input;
}
function applyInputChanges(entry, input) {
  if (entry !== input) for (const [key, value] of Object.entries(input)) if (!INPUT_FIELDS.has(key)) entry[key] = value;
}
function runPrepared(entry, context, prepare, action) {
  const input = prepare(entry, context) || entry;
  try {
    const result = action(input);
    if (result && typeof result.then === "function") return result.finally(() => applyInputChanges(entry, input));
    applyInputChanges(entry, input); return result;
  } catch (error) { applyInputChanges(entry, input); throw error; }
}

module.exports = { sourceRoot, runtimeEntry, sourceEntry,
  contentReadRoots, prepareModuleInput, applyInputChanges, runPrepared, atomicCopy, atomicWrite, assertOwnDirectory, assertPreservesExternalEnvironments };
