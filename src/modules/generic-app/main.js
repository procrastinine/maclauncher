const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const AppBundle = require("../shared/runtime/app-bundle");

function detectGame(context) {
  if (!context?.isAppBundle) return null;
  const appPath = context.rootDir;
  const directory = path.join(appPath, "Contents", "MacOS");
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  const plist = AppBundle.readInfoPlist(appPath);
  const plistName = typeof plist?.CFBundleExecutable === "string" ? plist.CFBundleExecutable.trim() : "";
  if (plistName && (path.basename(plistName) !== plistName || plistName.includes("\0") || plistName === "." || plistName === "..")) return null;
  const executableFiles = entries.filter(entry => {
    if (!entry.isFile()) return false;
    try { return Boolean(fs.statSync(path.join(directory, entry.name)).mode & 0o111); } catch { return false; }
  });
  const executable = plistName ? executableFiles.find(entry => entry.name === plistName)
    : executableFiles.find(entry => entry.name === path.basename(appPath, ".app")) || (executableFiles.length === 1 ? executableFiles[0] : null);
  if (!executable) return null;
  return {
    engine: manifest.id, moduleId: manifest.id, gameType: "native", name: plist?.CFBundleDisplayName || plist?.CFBundleName || path.basename(appPath, ".app"),
    gamePath: appPath, nativeAppPath: appPath, contentRootDir: appPath,
    moduleData: { bundleVersion: plist?.CFBundleShortVersionString || plist?.CFBundleVersion || null,
      bundleIdentifier: plist?.CFBundleIdentifier || null, executablePath: path.join(directory, executable.name) }
  };
}

module.exports = { id: manifest.id, manifest, detectGame };
