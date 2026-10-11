const path = require("node:path");

const { inspectExe } = require("./extract");
const { scanRoot, inspectRootScript, isNscripterRoot } = require("./scan");

function detectGame(context, helpers = {}) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;
  if (context?.isAppBundle) return null;

  // A loose script/archive export already supplies the game root. Only inspect
  // an executable container when those cheap markers are absent; dragging its
  // ordinary nscr.exe must not run archive probes unnecessarily.
  const probes = { ...context?.detection, ...helpers };
  const scan = scanRoot(rootDir, probes);
  const script = scan?.hasScript ? inspectRootScript(rootDir, probes) : null;
  if (isNscripterRoot(scan)) {
    if (script === false) return null;
    return {
      gameType: "scripted", engine: "nscripter", gamePath: rootDir, contentRootDir: rootDir,
      name: path.basename(rootDir), indexDir: null, indexHtml: null, defaultSaveDir: rootDir,
      detectionEvidence: script ? [script, ...(script.type === "nscripter-script-header" ? [{ type: "selected-artifact", path: script.path }] : [])]
        : [{ type: "nscripter-archive-config", path: rootDir }],
      moduleData: script ? { scriptPath: script.path, scriptFormat: script.format } : {}
    };
  }

  if (context?.stat?.isFile && context.stat.isFile()) {
    const inputPath = context?.inputPath;
    const ext = path.extname(String(inputPath || "")).toLowerCase();
    if (ext === ".exe") {
      const packaged = inputPath ? inspectExe(inputPath, helpers) : null;
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

  return null;
}

module.exports = {
  detectGame
};
