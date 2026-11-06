const fs = require("node:fs"), path = require("node:path");
const { TRASH } = require("../../../core/storage-maintenance");

// Deleting a downloaded file in Runtimes → Tools → Downloaded files renames it
// to trash in its own folder first; a removal that stopped is finished by the
// next upkeep pass. These stores match nothing else.
const folders = root => { try { return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith(".")).map(item => path.join(root, item.name)); } catch { return []; } };
module.exports = [
  {
    // One folder per shared asset (pinned-file.js).
    id: "shared-asset-removals",
    directories: ({ userDataDir }) => folders(path.join(userDataDir, "assets")),
    match: TRASH
  },
  {
    // Caches such as translator descriptions.
    id: "cache-removals",
    directories: ({ userDataDir }) => [path.join(userDataDir, "cache")],
    match: TRASH
  }
];
