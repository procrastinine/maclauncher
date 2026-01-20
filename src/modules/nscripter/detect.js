const path = require("node:path");

const { inspectExe } = require("./extract");
const { scanRoot, isNscripterRoot } = require("./scan");

function detectGame(context) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;
  if (context?.isAppBundle) return null;

  if (context?.stat?.isFile && context.stat.isFile()) {
    const inputPath = context?.inputPath;
    const ext = path.extname(String(inputPath || "")).toLowerCase();
    if (ext === ".exe") {
      const packaged = inputPath ? inspectExe(inputPath) : null;
      if (packaged) {
        return {
          gameType: "scripted",
          engine: "nscripter",
          gamePath: inputPath,
          contentRootDir: rootDir,
          name: path.basename(inputPath, path.extname(inputPath)),
          indexDir: null,
          indexHtml: null,
          // TODO: Confirm NScripter save location; this uses the root directory.
          defaultSaveDir: rootDir,
          moduleData: {
            packagedPath: inputPath,
            packagedType: packaged.packagedType || null
          }
        };
      }
    }
  }

  const scan = scanRoot(rootDir);
  if (!isNscripterRoot(scan)) return null;

  return {
    gameType: "scripted",
    engine: "nscripter",
    gamePath: rootDir,
    contentRootDir: rootDir,
    name: path.basename(rootDir),
    indexDir: null,
    indexHtml: null,
    defaultSaveDir: rootDir
  };
}

module.exports = {
  detectGame
};
