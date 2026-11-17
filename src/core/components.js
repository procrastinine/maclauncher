const fs = require("node:fs"), path = require("node:path");
const Components = require("../modules/shared/runtime/runtime-components");

// Components owned by core services; see component-service.js.

module.exports = [
  {
    // The version lists of Steam games that the Steam window reads, for each
    // account. The window reads a deleted list again when it needs it.
    id: "steam-catalogs",
    label: "Steam game versions",
    cache: true,
    description: "The lists of game versions that the Steam window reads from Steam for each signed-in account. The window reads a deleted list again when it needs it.",
    // The shared list is named by the label alone; each account's list says so.
    list({ userDataDir }) {
      const steam = path.join(userDataDir, "steam"), shared = path.join(steam, "catalog");
      return [shared, ...Components.storeEntries(path.join(steam, "accounts")).map(account => path.join(account, "catalog"))]
        .filter(directory => fs.existsSync(directory)).map(directory => ({ id: path.relative(steam, directory),
          version: directory === shared ? "" : "for a signed-in account", path: directory, source: { url: "https://store.steampowered.com" }, users: ["Steam window"] }));
    },
    remove(item, { userDataDir }) { return Components.removeOwned(item.path, path.join(userDataDir, "steam")); }
  }
];
