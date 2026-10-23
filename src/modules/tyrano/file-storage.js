const fs = require("node:fs");
const path = require("node:path");

// Older Tyrano exports derive file saves from the runner executable directory.
// Preserve their escaped JSON format while using the game's managed directory.
function install(target, saveDir, fileSystem = fs) {
  if (!target || typeof saveDir !== "string" || !path.isAbsolute(saveDir)) return false;
  const root = path.resolve(saveDir);
  const filePath = key => {
    if (typeof key !== "string" || !key || /[\\/\0]/.test(key) || key === "." || key === "..") throw new Error("Invalid Tyrano save key.");
    return path.join(root, `${key}.sav`);
  };
  const write = (key, value) => {
    const file = filePath(key);
    fileSystem.mkdirSync(root, { recursive: true });
    fileSystem.writeFileSync(file, escape(JSON.stringify(value)));
  };
  const read = key => {
    try { return unescape(fileSystem.readFileSync(filePath(key), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const apply = () => {
    const jquery = target.jQuery || target.$;
    if (!jquery) return;
    if (typeof jquery.setStorageFile === "function") jquery.setStorageFile = write;
    if (typeof jquery.getStorageFile === "function") jquery.getStorageFile = read;
    if (typeof jquery.getProcessPath === "function") jquery.getProcessPath = () => root;
    if (typeof jquery.localFilePath === "function") jquery.localFilePath = () => root;
  };
  apply();
  target.document?.addEventListener?.("load", apply, true);
  target.document?.addEventListener?.("DOMContentLoaded", apply, { once: true });
  return true;
}

module.exports = { install };
