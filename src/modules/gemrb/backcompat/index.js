// MacLauncher 0.5.1 private game/save layouts. Runs once through persisted data
// migration after original-path restoration, never on import or Play. Remove
// after support for upgrading those released layouts is explicitly retired.
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/backcompat/writable-input");
const manifest = require("../manifest.json");

function moduleDirectory(entry, context) {
  if (!entry.gameId || !context.userDataDir || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("GemRB requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function legacyGameMirrors(entry, { userDataDir }) {
  const original = Writable.sourceEntry(entry), sourceRoot = original.contentRootDir || original.gamePath;
  const outside = root => typeof root === "string" && path.isAbsolute(root) && path.resolve(root) !== path.resolve(userDataDir) && !path.resolve(root).startsWith(path.resolve(userDataDir) + path.sep);
  if (!path.isAbsolute(userDataDir || "") || !outside(sourceRoot)) return [];
  const directory = moduleDirectory(entry, { userDataDir });
  const mirrors = [{ mirrorRoot: path.join(directory, "game"), sourceRoot },
    { mirrorRoot: path.join(directory, "saves"), sourceRoot }];
  let scripts = original.moduleData?.bundledScriptsRoot && path.join(original.moduleData.bundledScriptsRoot, "GUIScripts");
  const marker = path.join(directory, "scripts-source.json");
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isFile() && stat.size <= 65536) scripts = JSON.parse(fs.readFileSync(marker, "utf8")).source || scripts;
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (outside(scripts)) mirrors.push({ mirrorRoot: path.join(directory, "scripts", "GUIScripts"), sourceRoot: scripts });
  else if (fs.lstatSync(path.join(directory, "scripts", "GUIScripts"), { throwIfNoEntry: false }))
    mirrors.push({ mirrorRoot: path.join(directory, "scripts", "GUIScripts"), sourceRoot: null });
  if (entry.moduleData?.writableInput?.schemaVersion === 1) mirrors.push(...Writable.legacyGameMirrors(entry, { userDataDir }));
  // The released cwd also held arbitrary relative writes beside today's live
  // configuration/cache. That mixed root cannot be retired as a game mirror.
  const known = new Set(["game", "saves", "scripts", "cache", "GemRB.cfg", ".GemRB.cfg.tmp", "game-root.json", "scripts-source.json"]);
  let names = [];
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (names.some(name => !known.has(name))) mirrors.push({ mirrorRoot: directory, sourceRoot: null });
  const override = path.isAbsolute(entry.saveDirOverride || "") ? path.resolve(entry.saveDirOverride) : null;
  const active = mirrors.filter(({ mirrorRoot }) => !override || !(override === mirrorRoot || override.startsWith(mirrorRoot + path.sep) || mirrorRoot.startsWith(override + path.sep)));
  return active;
}

module.exports = { legacyGameMirrors };
