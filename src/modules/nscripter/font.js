const fs = require("node:fs"), path = require("node:path"), File = require("../shared/runtime/pinned-file");
const asset = Object.freeze({ id: "nscripter-umeplus", label: "UmePlus Gothic fallback font", filename: "umeplus-gothic.ttf", bytes: 4557928,
  sha256: "4253ed2d08a97e6bb39e7d5ef422fe30abf93fb87a57ae8c055df00f4047a623",
  url: "https://github.com/procrastinine/maclauncher-builds/releases/download/upstream-mirrors-1/umeplus-gothic.ttf" });
function ownFont(rootDir) { try { return fs.statSync(path.join(rootDir, "default.ttf")).isFile(); } catch { return false; } }
module.exports = { asset, resolve: userDataDir => File.resolve(asset, userDataDir), ensure: (rootDir, context) =>
  (typeof context.moduleSettings?.defaultFontPath === "string" && context.moduleSettings.defaultFontPath.trim()) || ownFont(rootDir)
    ? null : File.ensure(asset, context) };
