// Supports replaced FVP launch views from MacLauncher 0.5.1 and later.
// Runs once through the shared game-data migration, never from current Play.
// Remove when no supported library can contain these replaced views.
// Active script/save adapters and their save folders are not obsolete state.
const fs = require("node:fs"), path = require("node:path");
const {directoryFor} = require("../prepare");
function legacyGameMirrors(entry, context) {
  const directory = directoryFor(entry, context), root = entry.contentRootDir || entry.gamePath;
  let children;
  try { children = fs.readdirSync(directory, {withFileTypes: true}); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return (children || []).filter(child => /^\.previous-[a-f0-9-]+$/.test(child.name))
    .map(child => ({mirrorRoot: path.join(directory, child.name), sourceRoot: root, generated: []}));
}
module.exports = {legacyGameMirrors};
