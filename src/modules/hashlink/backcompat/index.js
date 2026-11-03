// MacLauncher 0.5.1 private game/save layouts. Runs once through persisted data
// migration after original-path restoration, never on import or Play. Remove
// after support for upgrading those released layouts is explicitly retired.
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/backcompat/writable-input");
const manifest = require("../manifest.json");

function originalBytecodePath(entry) {
  let bytecodePath = entry.moduleData?.bytecodePath;
  const view = entry.moduleData?.writableInput;
  if (view?.schemaVersion === 1 && path.isAbsolute(view.root || "") && path.isAbsolute(view.sourceRoot || "") && path.isAbsolute(bytecodePath || "")) {
    const relative = path.relative(view.root, bytecodePath);
    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) bytecodePath = path.join(view.sourceRoot, relative);
  }
  return bytecodePath;
}
function legacyGameMirrors(entry, { userDataDir }) {
  if (!path.isAbsolute(userDataDir || "") || !entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) return [];
  const bytecodePath = originalBytecodePath(entry), view = entry.moduleData?.writableInput;
  if (!path.isAbsolute(bytecodePath || "")) return [];
  const sourceRoot = path.dirname(bytecodePath), profile = path.resolve(userDataDir);
  if (path.resolve(sourceRoot) === profile || path.resolve(sourceRoot).startsWith(profile + path.sep)) return [];
  const mirrors = [{ mirrorRoot: path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, manifest.id), "game"), sourceRoot }];
  if (view?.schemaVersion === 1) mirrors.push(...Writable.legacyGameMirrors(entry, { userDataDir }));
  const override = path.isAbsolute(entry.saveDirOverride || "") ? path.resolve(entry.saveDirOverride) : null;
  const active = mirrors.filter(({ mirrorRoot }) => !override || !(override === mirrorRoot || override.startsWith(mirrorRoot + path.sep) || mirrorRoot.startsWith(override + path.sep)));
  // The generic runner remaps visible save paths after each successful root.
  // Bytecode is opaque engine metadata, so its recorded view path is patched
  // only together with successful restoration of that exact retired view.
  if (bytecodePath !== entry.moduleData?.bytecodePath && path.isAbsolute(view?.root || "")) {
    const index = active.findIndex(row => path.resolve(row.mirrorRoot) === path.resolve(view.root));
    if (index >= 0) active[index] = { ...active[index], entryPatch: { moduleData: { bytecodePath } } };
  }
  return active;
}

module.exports = { legacyGameMirrors };
