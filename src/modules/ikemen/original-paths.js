const path = require("node:path");

// The engine's assets sit beside its executable or app, wherever a release places them.
function distributionRoot(install) {
  const macos = path.dirname(install.executablePath);
  const app = path.resolve(macos, "..", "..");
  return app.toLowerCase().endsWith(".app") ? path.dirname(app) : macos;
}
function originalSaveDirectory(entry, install) {
  const root = entry.contentRootDir || entry.gamePath;
  const saveRoot = path.join(root, "save");
  return install?.executablePath && path.resolve(distributionRoot(install)) === path.resolve(root) &&
    (!entry.saveDirOverride || (path.isAbsolute(entry.saveDirOverride) && path.resolve(entry.saveDirOverride) === path.resolve(saveRoot))) ? saveRoot : null;
}
module.exports = { distributionRoot, originalSaveDirectory };
