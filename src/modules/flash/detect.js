const path = require("node:path");

function detectGame(context) {
  const inputPath = typeof context?.inputPath === "string" ? context.inputPath.trim() : "";
  if (!inputPath || context?.stat?.isFile?.() !== true) return null;
  if (path.extname(inputPath).toLowerCase() !== ".swf") return null;

  const swfPath = path.resolve(inputPath);
  const contentRootDir = path.dirname(swfPath);
  const base = path.basename(swfPath, path.extname(swfPath));
  const name = base && base.trim() ? base.trim() : path.basename(swfPath);

  return {
    engine: "flash",
    gameType: "scripted",
    gamePath: swfPath,
    contentRootDir,
    name,
    moduleData: {
      swfPath
    }
  };
}

module.exports = {
  detectGame
};
