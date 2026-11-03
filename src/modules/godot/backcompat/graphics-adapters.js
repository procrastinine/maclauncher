// Backcompat: MacLauncher v0.5.1 Godot camera adapter folders,
// modules/godot/graphics/<16 hex>/, which every Godot 4.4+ Play created while a
// graphics runtime was installed. A pack folder holds a link to the PCK,
// override.cfg and camera.gdextension. A project folder holds camera.gdextension
// and project/: links to each top-level entry, override.cfg and a private copy
// of the .godot import cache. Used only by the once-per-game migration through
// this module's legacyGameMirrors, ahead of the mono-projects and
// source-projects descriptors, never Play, import or upkeep. Remove when support
// for profiles containing this released layout is retired.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const GameData = require("../../shared/game-data");

const GENERATED = ["override.cfg", "override.cfg.tmp", "camera.gdextension", "camera.gdextension.tmp"];
// A folder's name is the first 16 hex digits of sha256(kind + NUL + source).
const identity = (kind, source) => crypto.createHash("sha256").update(kind + "\0" + source).digest("hex").slice(0, 16);
const readLink = file => fs.lstatSync(file, {throwIfNoEntry: false})?.isSymbolicLink() ? fs.readlinkSync(file) : null;
// The private .godot copy was cloned from the original cache at each launch.
function cacheFiles(root) {
  const files = [], visit = relative => {
    const directory = path.join(root, relative), stat = fs.lstatSync(directory, {throwIfNoEntry: false});
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const name = path.join(relative, item.name);
      if (item.isDirectory()) visit(name);
      else if (item.isFile()) files.push(name.split(path.sep).join("/"));
    }
  };
  visit(".godot");
  return files;
}

// Each folder is matched to its source by its own links and verified by its
// name. A folder that matches neither layout is kept with a recorded reason.
function legacyGraphicsAdapters(entry, {userDataDir}) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "")) return [];
  const parent = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot"), "graphics");
  const stat = fs.lstatSync(parent, {throwIfNoEntry: false});
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("The old Godot graphics folder is not a directory.");
  const descriptors = [];
  for (const name of fs.readdirSync(parent).sort()) {
    const directory = path.join(parent, name), project = readLink(path.join(directory, "project", "project.godot"));
    const projectSource = project && path.dirname(project);
    if (/^[a-f0-9]{16}$/.test(name) && projectSource && identity("project", projectSource) === name) {
      const mirrorRoot = path.join(directory, "project");
      descriptors.push({mirrorRoot, sourceRoot: projectSource, generated: ["override.cfg", "override.cfg.tmp", ...cacheFiles(mirrorRoot)]},
        {mirrorRoot: directory, sourceRoot: projectSource, generated: GENERATED});
      continue;
    }
    const pack = /^[a-f0-9]{16}$/.test(name) && fs.lstatSync(directory).isDirectory() && fs.readdirSync(directory)
      .map(item => readLink(path.join(directory, item))).find(target => target && identity("pack", target) === name);
    descriptors.push({mirrorRoot: directory, sourceRoot: pack ? path.dirname(pack) : null, generated: GENERATED});
  }
  return descriptors;
}

module.exports = {legacyGraphicsAdapters};
