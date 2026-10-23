const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("./game-data");

// A completed container is source data. Its identity receipt must survive
// launches, patching and portable saves. Modules describe the few inputs they
// need to own; every other file remains an immutable asset link.
const INPUT_FIELDS = new Set(["gameId", "gamePath", "importPath", "containerData", "contentRootDir", "indexDir", "indexHtml"]);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function immutableRoot(entry) {
  const data = entry?.containerData;
  if (!data || data.immutable === false || typeof data.extractedRoot !== "string") return null;
  if (!path.isAbsolute(data.extractedRoot)) throw new Error("Container input must have an absolute source directory.");
  return path.resolve(data.extractedRoot);
}
function sourceRoot(entry) {
  const previous = entry?.moduleData?.writableInput;
  if (previous?.schemaVersion === 1 && entry.contentRootDir === previous.root) return previous.sourceRoot;
  return entry?.contentRootDir || entry?.gamePath;
}
function describeView(entry, { userDataDir, moduleId, policyId, contentRoot = sourceRoot(entry) }) {
  const containerRoot = immutableRoot(entry);
  if (!containerRoot) return null;
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "") || !/^[\w-]+$/.test(moduleId || "")) {
    throw new Error("Writable game input needs its owned game data directory.");
  }
  if (typeof policyId !== "string" || !policyId || !path.isAbsolute(contentRoot || "") || !inside(containerRoot, path.resolve(contentRoot))) {
    throw new Error("Writable input must describe content inside its source container.");
  }
  const directory = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, moduleId), "writable-input");
  return { schemaVersion: 1, sourceRoot: path.resolve(contentRoot), containerRoot, containerKey: entry.containerData.key || null,
    policyId, directory, root: path.join(directory, "files"),
    identity: hash([containerRoot, entry.containerData.key || null, path.resolve(contentRoot), policyId]) };
}
function readReceipt(view) {
  const file = path.join(view.directory, "input.json"), stat = lstat(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) return null;
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return value?.schemaVersion === 1 ? value : null; } catch { return null; }
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
function assertOutsideSource(view) {
  const original = fs.realpathSync(view.containerRoot);
  let parent = view.directory, parts = [];
  while (!lstat(parent)) { parts.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const destination = path.join(fs.realpathSync(parent), ...parts);
  if (inside(original, destination)) throw new Error("Writable game data must be outside its source container.");
}
function atomicCopy(source, destination, { root = path.dirname(destination), preserveTimes = true } = {}) {
  assertOwnDirectory(root, path.dirname(destination));
  const existing = lstat(destination);
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new Error("File output conflicts with a directory.");
  const temporary = path.join(path.dirname(destination), ".maclauncher-copy-" + crypto.randomUUID());
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_FICLONE || 0);
    const stat = fs.statSync(source);
    fs.chmodSync(temporary, stat.mode | 0o600);
    if (preserveTimes) fs.utimesSync(temporary, stat.atime, stat.mtime);
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
function linkAsset(source, destination) {
  const stat = lstat(destination);
  if (stat?.isSymbolicLink()) {
    if (path.resolve(path.dirname(destination), fs.readlinkSync(destination)) === source) return;
    fs.unlinkSync(destination);
  } else if (stat?.isFile()) {
    // A module may have detached this asset for an explicit edit. Keep its
    // private output across launches instead of restoring a source alias.
    return;
  } else if (stat) throw new Error("Asset output conflicts with a directory.");
  fs.symlinkSync(source, destination, "file");
}
function ensureView(entry, context, { moduleId, policyId, privateFile = () => false, seedFile = () => false,
  omitTree = () => false, emptyDirectories = [], overlayTree, contentRoot } = {}) {
  const view = describeView(entry, { userDataDir: context.userDataDir, moduleId, policyId, contentRoot });
  if (!view) return null;
  context.signal?.throwIfAborted();
  const gameRoot = GameData.resolveGameDir(context.userDataDir, entry.gameId);
  assertOwnDirectory(context.userDataDir, gameRoot, { create: false });
  assertOwnDirectory(gameRoot, view.root, { create: false });
  const previous = readReceipt(view), ready = previous?.identity === view.identity &&
    lstat(view.root)?.isDirectory() && !lstat(view.root)?.isSymbolicLink();
  if (context.readOnly === true) return { ...view, ready: Boolean(ready) };
  assertOutsideSource(view);
  assertOwnDirectory(context.userDataDir, view.root);
  if (ready) return { ...view, ready: true };
  const inputs = Object.create(null), overlays = Object.create(null);
  let completed = 0;
  function visit(source, destination, relative = "") {
    context.signal?.throwIfAborted();
    assertOwnDirectory(gameRoot, destination);
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      context.signal?.throwIfAborted();
      if (item.name.toLowerCase() === ".ds_store") continue;
      const name = relative ? path.join(relative, item.name) : item.name;
      const from = path.join(source, item.name), to = path.join(destination, item.name);
      if (item.isSymbolicLink()) throw new Error("Immutable container inputs must not contain aliases.");
      if (item.isDirectory()) {
        assertOwnDirectory(gameRoot, to);
        if (omitTree(name)) continue;
        const custom = overlayTree?.(name, { sourceDir: from, destinationDir: to, previousInputs: previous?.overlays?.[name] || {}, signal: context.signal });
        if (custom) overlays[name] = custom;
        else visit(from, to, name);
      } else if (item.isFile()) {
        const seed = seedFile(name), own = seed || privateFile(name);
        if (own) {
          const stat = lstat(to);
          if (!seed || !stat?.isFile() || stat.isSymbolicLink()) atomicCopy(from, to, { root: gameRoot });
          inputs[name] = { kind: seed ? "seed" : "private" };
        } else {
          linkAsset(from, to); inputs[name] = { kind: "asset" };
        }
      } else throw new Error("Immutable container inputs must be regular files and directories.");
      completed++;
      if (completed % 128 === 0) context.onProgress?.({ phase: "prepare", completed, label: "Starting game…" });
    }
  }
  visit(view.sourceRoot, view.root);
  for (const relative of emptyDirectories) assertOwnDirectory(gameRoot, path.join(view.root, relative));
  // Removed source links can be discarded safely; private/generated outputs
  // and seeded saves survive a new source generation.
  for (const [relative, old] of Object.entries(previous?.inputs || {})) {
    const file = path.resolve(view.root, relative);
    if (!inside(view.root, file) || Object.hasOwn(inputs, relative) || old.kind !== "asset") continue;
    const stat = lstat(file);
    if (stat?.isSymbolicLink()) fs.unlinkSync(file);
  }
  context.signal?.throwIfAborted();
  atomicWrite(path.join(view.directory, "input.json"), JSON.stringify({ ...view, inputs, overlays }) + "\n", { root: gameRoot });
  return { ...view, ready: true };
}
function rememberView(entry, view) {
  if (view) {
    entry.moduleData = { ...entry.moduleData, writableInput: view };
    if (typeof entry.saveDirOverride === "string" && inside(view.containerRoot, entry.saveDirOverride)) {
      if (!inside(view.sourceRoot, entry.saveDirOverride)) throw new Error("Save output must be outside installer data.");
      entry.saveDirOverride = path.join(view.root, path.relative(view.sourceRoot, entry.saveDirOverride));
    }
  }
  return view;
}
function runtimeEntry(entry) {
  const view = entry?.moduleData?.writableInput;
  if (!immutableRoot(entry) || view?.schemaVersion !== 1 || !view.ready || view.containerKey !== (entry.containerData.key || null)) return entry;
  const remap = file => typeof file === "string" && inside(view.sourceRoot, file) ? path.join(view.root, path.relative(view.sourceRoot, file)) : file;
  return { ...entry, contentRootDir: view.root, indexDir: remap(entry.indexDir), indexHtml: remap(entry.indexHtml) };
}
function sourceEntry(entry) {
  const view = entry?.moduleData?.writableInput;
  if (!immutableRoot(entry) || view?.schemaVersion !== 1 || !view.ready) return entry;
  const remap = file => typeof file === "string" && inside(view.root, file) ? path.join(view.sourceRoot, path.relative(view.root, file)) : file;
  return { ...entry, contentRootDir: view.sourceRoot, indexDir: remap(entry.indexDir), indexHtml: remap(entry.indexHtml) };
}
function contentReadRoots(entry) {
  const view = entry?.moduleData?.writableInput, container = immutableRoot(entry);
  if (!container || view?.schemaVersion !== 1 || !view.ready || view.containerKey !== (entry.containerData.key || null)) return [];
  const original = fs.realpathSync(view.sourceRoot), containerRoot = fs.realpathSync(container);
  if (!inside(containerRoot, original)) throw new Error("Content read roots must stay inside this game's source container.");
  return [original];
}
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

module.exports = { immutableRoot, sourceRoot, describeView, ensureView, rememberView, runtimeEntry, sourceEntry,
  contentReadRoots, prepareModuleInput, applyInputChanges, runPrepared, atomicCopy, atomicWrite, assertOwnDirectory };
