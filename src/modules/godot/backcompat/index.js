// Backcompat: MacLauncher v0.5.1 Godot Mono mono-projects/<24hex>/project,
// Godot4 source-projects/<20hex>/{project,previous,preparing-*,editor-home},
// and schema-1 shared writable views. Runs only in the once-per-game profile
// migration, never import or Play. Delete after these released layouts leave support.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/writable-input");
const LegacyWritable = require("../../shared/backcompat/writable-input");

// Called only by the shared one-time migration, never import or Play. The
// mirror namespaces are obsolete; packs, recovered projects and tools are not.
function legacyGameMirrors(entry, {userDataDir, homeDir = os.homedir()}) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "")) return [];
  if (!path.isAbsolute(userDataDir || "")) throw Error("The MacLauncher data folder for this Godot game is unknown, so files kept by an earlier version were left in place. Copy any needed files from this folder before removing the game.");
  const data = entry.moduleData || {};
  const view = data.writableInput;
  const originalPath = value => {
    if (!path.isAbsolute(value || "")) return null;
    if (view?.schemaVersion === 1 && path.isAbsolute(view.root || "") && path.isAbsolute(view.sourceRoot || "")) {
      const relative = path.relative(view.root, value);
      if (relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return path.join(view.sourceRoot, relative);
    }
    return value;
  };
  const projectRoot = originalPath(data.projectRoot), packPath = originalPath(data.packPath), gamePath = originalPath(entry.gamePath);
  const sourceRoot = projectRoot || (packPath ? path.dirname(packPath) : originalPath(entry.contentRootDir) || (gamePath ? path.dirname(gamePath) : null));
  if (!sourceRoot) throw Error("The original Godot game folder is unknown, so files kept by an earlier MacLauncher version were not restored to it. Copy any needed files from this folder before removing the game.");
  const root = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot");
  const descriptors = [...require("./graphics-adapters").legacyGraphicsAdapters(entry, {userDataDir}),
    ...LegacyWritable.legacyGameMirrors({...entry, moduleId: "godot", contentRootDir: sourceRoot}, {userDataDir})];
  let count = 0;
  function directories(directory) {
    Writable.assertOwnDirectory(userDataDir, directory, {create: false});
    if (!fs.lstatSync(directory, {throwIfNoEntry: false})) return [];
    const handle = fs.opendirSync(directory), result = [];
    try {
      let item;
      while ((item = handle.readSync())) {
        if (++count > 1024) throw Error("The folders that an earlier MacLauncher version kept for this Godot game hold too many entries to recover automatically, so they were left in place. Copy any needed files from this folder before removing the game.");
        if (item.isSymbolicLink()) throw Error("A folder that an earlier MacLauncher version kept for this Godot game contains a symbolic link, so it was left in place. Copy any needed files from this folder before removing the game.");
        if (item.isDirectory()) result.push(item.name);
      }
    } finally {handle.closeSync();}
    return result.sort();
  }
  function recordedSource(directory) {
    const file = path.join(directory, "prepared.json"), stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 16384) {
      try {return originalPath(JSON.parse(fs.readFileSync(file, "utf8")).source) || sourceRoot;} catch {}
    }
    return sourceRoot;
  }
  function editorHome(directory) {
    Writable.assertOwnDirectory(userDataDir, directory, {create: false});
    if (!fs.lstatSync(directory, {throwIfNoEntry: false})) return false;
    const handle = fs.opendirSync(directory);
    let occupied;
    try {occupied = !!handle.readSync();} finally {handle.closeSync();}
    if (!occupied) return false;
    if (!path.isAbsolute(homeDir || "")) throw Error("Godot editor recovery requires an absolute original home directory.");
    // v0.5.1 changed HOME during import. macOS Godot uses these exact paths;
    // XDG-root/plugin bytes have no proven destination and stay pending.
    for (const relative of ["Library/Application Support/Godot", "Library/Caches/Godot"]) {
      const mirrorRoot = path.join(directory, relative);
      Writable.assertOwnDirectory(userDataDir, mirrorRoot, {create: false});
      if (fs.lstatSync(mirrorRoot, {throwIfNoEntry: false})) descriptors.push({mirrorRoot, sourceRoot: path.join(homeDir, relative), createSourceWithin: homeDir, generated: []});
    }
    return true;
  }
  for (const [namespace, pattern] of [["mono-projects", /^[a-f0-9]{24}$/], ["source-projects", /^[a-f0-9]{20}$/]]) {
    const parent = path.join(root, namespace);
    for (const name of directories(parent).filter(name => pattern.test(name))) {
      const generation = path.join(parent, name), source = recordedSource(generation);
      for (const child of directories(generation)) {
        const directory = path.join(generation, child);
        if (child === "project" || child === "previous" || /^preserved-[a-f0-9]{16}$/.test(child) || /^preparing-[a-f0-9]{16}$/.test(child))
          descriptors.push({mirrorRoot: directory, sourceRoot: source, generated: []});
        else if (/^\.preparing-[A-Za-z0-9]{6}$/.test(child)) {
          descriptors.push({mirrorRoot: path.join(directory, "project"), sourceRoot: source, generated: []});
          descriptors.push({mirrorRoot: directory, sourceRoot: source, generated: ["prepared.json"]});
        }
      }
      const retainedHome = namespace === "source-projects" && editorHome(path.join(generation, "editor-home"));
      // BLOCKED: the shared helper has no retained-directory support yet.
      // A null source prevents it from misrouting tool HOME bytes into a game;
      // parent-cwd files remain private until that generic boundary supports it.
      descriptors.push({mirrorRoot: generation, sourceRoot: retainedHome ? null : source,
        generated: namespace === "source-projects" ? ["prepared.json", "import.log"] : ["prepared.json"],
        ...(retainedHome ? {retainedDirectories: ["editor-home"]} : {})});
    }
  }
  return descriptors;
}

module.exports = {legacyGameMirrors};
