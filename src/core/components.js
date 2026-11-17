const fs = require("node:fs"), path = require("node:path");
const Components = require("../modules/shared/runtime/runtime-components");

// Components owned by core services; see component-service.js.
const tools = ({ userDataDir }) => path.join(userDataDir, "external", "tools");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

module.exports = [
  {
    // Legendary copies use the existing store-helper management route.
    id: "external-download-helpers",
    label: "Epic download helper",
    description: "Legendary downloads Epic Games Store games. It is downloaded with the first store action that needs it.",
    list(context) {
      return Components.storeEntries(tools(context)).flatMap(directory => {
        const name = path.basename(directory);
        const legendary = /^legendary-([\w.+-]+)-([0-9a-f]{12})$/.exec(name);
        return legendary ? [{ id: name, label: "Legendary", version: `Legendary ${legendary[1]}`, path: directory,
          source: { url: "https://pypi.org/project/legendary-gl/" }, users: ["Epic Games Store downloads"] }] : [];
      });
    },
    remove(item, context) { return Components.removeOwned(item.path, tools(context)); },
    // Refresh reads both helpers' catalogs; the next store download installs a newer helper.
    async refresh({ signal, logger } = {}) {
      const newest = rows => rows.map(row => String(row.version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || null;
      const legendary = await require("./external-store-downloads").LEGENDARY.discover({ signal, logger }).then(newest);
      const found = [legendary && `Legendary ${legendary}`].filter(Boolean);
      return found.length ? `Newest: ${found.join(", ")}. The next store download installs a newer helper.` : "No helper release is listed.";
    }
  },
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
