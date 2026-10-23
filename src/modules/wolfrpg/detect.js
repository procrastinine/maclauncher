const fs = require("node:fs");
const path = require("node:path");
function findName(root, name) {
  try { const value = fs.readdirSync(root).find(item => item.toLowerCase() === name.toLowerCase()); return value ? path.join(root, value) : null; } catch { return null; }
}
function file(value) { try { return Boolean(value && fs.statSync(value).isFile()); } catch { return false; } }
function directory(value) { try { return Boolean(value && fs.statSync(value).isDirectory()); } catch { return false; } }
function inspectRoot(root) {
  const archivePath = findName(root, "Data.wolf"), dataDir = findName(root, "Data"), basic = directory(dataDir) && findName(dataDir, "BasicData");
  const gameDataPath = directory(basic) && findName(basic, "Game.dat"), gameIni = findName(root, "Game.ini");
  if (!file(archivePath) && !file(gameDataPath) && !(directory(dataDir) && file(findName(dataDir, "BasicData.wolf")))) return null;
  if (!file(gameIni) && !file(gameDataPath)) return null;
  return { archivePath: file(archivePath) ? archivePath : null, dataDir: directory(dataDir) ? dataDir : null, gameIni: file(gameIni) ? gameIni : null, gameDataPath: file(gameDataPath) ? gameDataPath : null };
}
function detectGame(context) {
  if (context?.isAppBundle) return null;
  const root = context?.rootDir;
  if (!root) return null;
  const data = inspectRoot(root);
  if (!data) return null;
  return { moduleId: "wolfrpg", engine: "wolfrpg", gameType: "web", gamePath: root, contentRootDir: root,
    name: path.basename(root), runtimeId: "browser-woditor", indexHtml: null, indexDir: null,
    moduleData: { ...data, dataLayout: data.archivePath ? "Data.wolf archive" : "Data folder" } };
}
module.exports = { detectGame, inspectRoot, findName };
