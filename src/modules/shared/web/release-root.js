const fs = require("node:fs");
const path = require("node:path");

// A game folder can be the app package of an NW.js build around it: the folder
// that the parent's package.json names as the location of its start page, such
// as RPG Maker's www folder, or a package.nw folder, which NW.js loads from
// beside its executable. The parent then holds the release, including its
// launchers. Any other layout has no release folder beyond the game's own.
function nwjsReleaseRoot(gameDir) {
  if (typeof gameDir !== "string" || !path.isAbsolute(gameDir)) return null;
  const parent = path.dirname(gameDir);
  if (parent === gameDir) return null;
  try {
    if (!fs.statSync(gameDir).isDirectory()) return null;
    if (path.basename(gameDir).toLowerCase() === "package.nw") return parent;
    const file = path.join(parent, "package.json"), info = fs.statSync(file);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const main = JSON.parse(fs.readFileSync(file, "utf8"))?.main;
    if (typeof main !== "string" || !main.trim()) return null;
    const relative = path.relative(gameDir, path.resolve(parent, main));
    return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) ? parent : null;
  } catch {
    return null;
  }
}

// Detection records the release folder without changing the game's identity:
// gamePath and contentRootDir stay as the module reported them.
function withReleaseRoot(detected) {
  if (!detected || typeof detected !== "object" || detected.releaseRootDir) return detected;
  const releaseRootDir = nwjsReleaseRoot(detected.gamePath);
  return releaseRootDir ? { ...detected, releaseRootDir } : detected;
}

module.exports = { nwjsReleaseRoot, withReleaseRoot };
