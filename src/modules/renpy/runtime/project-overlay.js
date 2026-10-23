const fs = require("node:fs");
const path = require("node:path");

// Ren'Py writes compiled scripts beside their sources and caches below game/.
// Keep those paths private; archives, images, audio and other assets stay in
// the original game. Directories are real so new runtime files cannot escape
// through a directory alias.
const PRIVATE_EXTENSIONS = new Set([
  ".rpy", ".rpyc", ".rpym", ".rpymc", ".rpyb",
  ".py", ".pyc", ".pyo", ".json", ".ini", ".cfg", ".toml",
  ".yaml", ".yml", ".txt", ".log", ".save", ".persistent"
]);
const GENERATED_DIRECTORIES = new Set(["cache", "__pycache__"]);

function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function remove(file) {
  fs.rmSync(file, { recursive: true, force: true });
}

function ensurePrivateDirectory(directory) {
  const stat = lstat(directory);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) remove(directory);
  fs.mkdirSync(directory, { recursive: true });
}

function signature(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

function copyPrivateFile(source, destination, oldInput, { preserveExisting = false } = {}) {
  const sourceStat = fs.statSync(source);
  const sourceSignature = signature(sourceStat);
  const destinationStat = lstat(destination);
  if (destinationStat?.isSymbolicLink() || (destinationStat && !destinationStat.isFile())) remove(destination);
  const privateFile = destinationStat?.isFile() && !destinationStat.isSymbolicLink();
  if (!privateFile || (!preserveExisting && oldInput?.signature !== sourceSignature)) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE || 0);
    // The script loader compares source/compiled timestamps. Preserve the
    // game's timestamps instead of making every copied source appear newer.
    fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
  }
  return { kind: "private", signature: sourceSignature, preserveExisting };
}

function linkAsset(source, destination) {
  const stat = lstat(destination);
  if (stat?.isSymbolicLink()) {
    const target = path.resolve(path.dirname(destination), fs.readlinkSync(destination));
    if (target === path.resolve(source)) return;
  }
  if (stat) remove(destination);
  // A failed link must not silently duplicate a potentially huge game.
  fs.symlinkSync(path.resolve(source), destination, "file");
}

function isPrivateFile(name) {
  return PRIVATE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function generatedCompanions(relative) {
  if (relative.endsWith("_ren.py")) return [relative.slice(0, -7) + ".rpyc"];
  if (relative.endsWith(".rpy") || relative.endsWith(".rpym")) return [relative + "c"];
  if (relative.endsWith(".py")) return [relative + "c", relative + "o"];
  return [];
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertOutsideOriginal(sourceDir, destinationDir) {
  const sourceRoot = fs.realpathSync(sourceDir);
  // Resolve existing parent aliases before creating anything. The final
  // destination may be an old game-directory alias which migration unlinks.
  let parent = path.dirname(path.resolve(destinationDir));
  const parts = [path.basename(destinationDir)];
  let destinationRoot;
  for (;;) {
    try {
      destinationRoot = path.join(fs.realpathSync(parent), ...parts);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      parts.unshift(path.basename(parent));
      const nextParent = path.dirname(parent);
      if (nextParent === parent) throw error;
      parent = nextParent;
    }
  }
  if (isWithin(sourceRoot, destinationRoot)) {
    throw new Error("Ren'Py runtime data must be outside the original game folder.");
  }
}

function ensureGameOverlay({ sourceDir, destinationDir, previousInputs = {}, signal }) {
  signal?.throwIfAborted();
  assertOutsideOriginal(sourceDir, destinationDir);
  ensurePrivateDirectory(destinationDir);
  const inputs = {};

  function visit(source, destination, relative, ancestors, privateTree = false) {
    signal?.throwIfAborted();
    const realDirectory = fs.realpathSync(source);
    if (ancestors.has(realDirectory)) throw new Error("Ren'Py game contains a directory link cycle.");
    const nextAncestors = new Set(ancestors).add(realDirectory);
    ensurePrivateDirectory(destination);
    const entries = fs.readdirSync(source, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const name = entry.name;
      if (name.toLowerCase() === ".ds_store") continue;
      const childRelative = relative ? path.join(relative, name) : name;
      const childSource = path.join(source, name);
      const childDestination = path.join(destination, name);
      const stat = entry.isSymbolicLink() ? fs.statSync(childSource) : entry;
      if (stat.isDirectory()) {
        inputs[childRelative] = { kind: "directory" };
        ensurePrivateDirectory(childDestination);
        // Caches belong to the selected SDK. They are regenerated, rather
        // than importing bytecode for another Python/runtime version.
        if (GENERATED_DIRECTORIES.has(name.toLowerCase()) && (!relative || name.toLowerCase() === "__pycache__")) continue;
        visit(childSource, childDestination, childRelative, nextAncestors,
          privateTree || (!relative && name.toLowerCase() === "saves"));
      } else if (stat.isFile()) {
        if (privateTree || isPrivateFile(name)) {
          inputs[childRelative] = copyPrivateFile(childSource, childDestination,
            previousInputs[childRelative], { preserveExisting: privateTree });
        } else {
          linkAsset(childSource, childDestination);
          inputs[childRelative] = { kind: "asset" };
        }
      }
    }
  }

  visit(sourceDir, destinationDir, "", new Set());
  ensurePrivateDirectory(path.join(destinationDir, "cache"));
  ensurePrivateDirectory(path.join(destinationDir, "saves"));

  for (const [relative, previous] of Object.entries(previousInputs)) {
    if (Object.hasOwn(inputs, relative) || previous?.preserveExisting || previous?.kind === "directory") continue;
    const destination = path.resolve(destinationDir, relative);
    if (!isWithin(path.resolve(destinationDir), destination)) continue;
    remove(destination);
    for (const companion of generatedCompanions(relative)) {
      if (!Object.hasOwn(inputs, companion)) remove(path.join(destinationDir, companion));
    }
  }
  return inputs;
}

module.exports = {
  ensureGameOverlay,
  assertOutsideOriginal,
  ensurePrivateDirectory,
  copyPrivateFile,
  isPrivateFile,
  linkAsset
};
