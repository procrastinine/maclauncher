// Backcompat: MacLauncher app v0.5.1 FNA overlays/<runtime> and previous-overlays/<runtime>-<timestamp>, plus schema-1 shared writable views.
// Runs only during the one-time profile data migration, never from Play.
// Delete with that migration after profiles using these released layouts are no longer supported.
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/writable-input");
const LegacyWritable = require("../../shared/backcompat/writable-input");

function legacyGameMirrors(entry, {userDataDir} = {}) {
  const assembly = entry?.moduleData?.assemblyPath || entry?.gamePath;
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(userDataDir || "") || !path.isAbsolute(assembly || ""))
    throw new Error("The location of this FNA game is unknown, so files kept by an earlier MacLauncher version were left in place. Copy any needed files from this folder before removing the game.");
  const view = entry.moduleData?.writableInput;
  const inside = (root, file) => {const relative = path.relative(root, file);return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);};
  let original = path.resolve(assembly);
  if (view?.schemaVersion === 1 && path.isAbsolute(view.root || "") && path.isAbsolute(view.sourceRoot || "") && inside(view.root, original))
    original = path.join(view.sourceRoot, path.relative(view.root, original));
  const sourceRoot = path.dirname(original), root = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "fna");
  if (inside(userDataDir, sourceRoot)) throw new Error("The original folder of this FNA game is inside the MacLauncher data folder, so files kept by an earlier version were left in place. Copy any needed files from this folder before removing the game.");
  Writable.assertOwnDirectory(userDataDir, root, {create: false});
  const descriptors = LegacyWritable.legacyGameMirrors({...entry, moduleId: "fna", gamePath: sourceRoot, contentRootDir: sourceRoot}, {userDataDir});
  for (const descriptor of descriptors) Writable.assertOwnDirectory(userDataDir, descriptor.mirrorRoot, {create: false});
  let discovered = 0;
  for (const name of ["overlays", "previous-overlays"]) {
    const directory = path.join(root, name);
    Writable.assertOwnDirectory(userDataDir, directory, {create: false});
    let handle;
    try {handle = fs.opendirSync(directory);} catch (error) {if (error.code === "ENOENT") continue;throw error;}
    try {
      let child;
      while ((child = handle.readSync())) {
        if (++discovered > 1024) throw new Error("The folders that an earlier MacLauncher version kept for this FNA game hold too many entries to recover automatically, so they were left in place. Copy any needed files from this folder before removing the game.");
        const mirrorRoot = path.join(directory, child.name), stat = fs.lstatSync(mirrorRoot);
        if (stat.isSymbolicLink()) throw new Error("A folder that an earlier MacLauncher version kept for this FNA game is a symbolic link, so it was left in place. Copy any needed files from this folder before removing the game.");
        if (!stat.isDirectory()) continue;
        Writable.assertOwnDirectory(userDataDir, mirrorRoot, {create: false});
        descriptors.push({mirrorRoot, sourceRoot,
          generated: [".maclauncher-fna.json", ".maclauncher-fna-baseline.json", ".maclauncher-fna-carried-forward.json"]});
      }
    } finally {handle.closeSync();}
  }
  return descriptors;
}

module.exports = {legacyGameMirrors};
