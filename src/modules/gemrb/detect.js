const fs = require("node:fs");
const path = require("node:path");
const { inspectGame } = require("./inspect");

function findName(root, name) {
  try {
    const found = fs.readdirSync(root).find(value => value.toLowerCase() === name.toLowerCase());
    return found ? path.join(root, found) : null;
  } catch { return null; }
}

function inspectKey(keyPath) {
  const size = fs.statSync(keyPath).size;
  if (size < 24) return null;
  const fd = fs.openSync(keyPath, "r");
  try {
    const header = Buffer.alloc(24);
    if (fs.readSync(fd, header, 0, 24, 0) !== 24 || header.toString("ascii", 0, 8) !== "KEY V1  ") return null;
    const archives = header.readUInt32LE(8), resources = header.readUInt32LE(12);
    const archiveOffset = header.readUInt32LE(16), resourceOffset = header.readUInt32LE(20);
    if (!resources || (archives && (archiveOffset < 24 || archiveOffset + archives * 12 > size)) ||
      resourceOffset < 24 || resourceOffset + resources * 14 > size) return null;
    return { archives, resources };
  } finally { fs.closeSync(fd); }
}

function detectGame(context) {
  if (context.isAppBundle) return null;
  let root = context.rootDir;
  try {
    // Standalone games may package resources in game/ alongside GUIScripts/.
    // Inspect that declared layout without scanning unrelated directories.
    if (!findName(root, "chitin.key")) {
      const game = findName(root, "game");
      if (game && fs.lstatSync(game).isDirectory() && findName(game, "chitin.key")) root = game;
    }
    const keyPath = findName(root, "chitin.key");
    if (!keyPath || !fs.statSync(keyPath).isFile()) return null;
    const key = inspectKey(keyPath);
    if (!key) return null;
    const languageRoot = findName(root, "lang");
    let dialogPath = findName(root, "dialog.tlk");
    if (!dialogPath && languageRoot) {
      for (const name of fs.readdirSync(languageRoot)) {
        dialogPath = findName(path.join(languageRoot, name), "dialog.tlk");
        if (dialogPath) break;
      }
    }
    if (!dialogPath) return null;
    const signature = Buffer.alloc(8);
    const fd = fs.openSync(dialogPath, "r");
    try { fs.readSync(fd, signature, 0, 8, 0); } finally { fs.closeSync(fd); }
    if (signature.toString("ascii") !== "TLK V1  ") return null;
    const demo = Boolean(findName(root, "gem-demo.ini"));
    const version = inspectGame(root);
    const profile = findBundledProfile(root);
    return { moduleId: "gemrb", engine: "gemrb", gamePath: root, contentRootDir: root,
      name: path.basename(context.rootDir), runtimeId: "gemrb", moduleData: { keyPath, dialogPath,
        ...version, gameType: demo ? "demo" : version.detectedGameType,
        ...(profile || {}),
        archiveCount: key.archives, resourceCount: key.resources } };
  } catch { return null; }
}

function findBundledProfile(root) {
  for (const parent of [root, path.dirname(root)]) {
    const scripts = findName(parent, "GUIScripts");
    if (!scripts || !fs.lstatSync(scripts).isDirectory()) continue;
    const profiles = fs.readdirSync(scripts, { withFileTypes: true }).filter(entry => entry.isDirectory() &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(entry.name) && fs.existsSync(path.join(scripts, entry.name, "Start.py")));
    if (profiles.length === 1) return { bundledGameProfile: profiles[0].name, bundledScriptsRoot: parent,
      gameProfileSource: "unique bundled GUIScripts/<profile>/Start.py" };
  }
  return null;
}

module.exports = { detectGame, inspectKey, findBundledProfile };
