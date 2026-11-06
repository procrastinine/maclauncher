const fs = require("node:fs"), path = require("node:path");
const Components = require("../modules/shared/runtime/runtime-components");

// Components owned by core services; see component-service.js.
const tools = ({ userDataDir }) => path.join(userDataDir, "external", "tools");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

module.exports = [
  {
    // gogdl (GOG) and Legendary (Epic) download store games. Each download
    // checks for the newest helper and installs it after the store action.
    id: "external-download-helpers",
    label: "Store download helpers",
    description: "Heroic's gogdl downloads GOG games, and Legendary downloads Epic Games Store games. A helper is downloaded with the first store download that needs it.",
    list(context) {
      return Components.storeEntries(tools(context)).flatMap(directory => {
        const name = path.basename(directory);
        const gogdl = /^gogdl-([\w.+-]+)-(arm64|x64)-([0-9a-f]{12})$/.exec(name);
        if (gogdl) {
          const record = readJson(path.join(directory, "source.json")) || {};
          return [{ id: name, label: "gogdl", version: `gogdl ${gogdl[1]}`, architecture: gogdl[2],
            identity: /^[a-f0-9]{64}$/.test(record.sha256 || "") ? `SHA-256 ${record.sha256}` : null, path: directory,
            source: /^https:\/\//.test(record.url || "") ? { url: record.url } : { url: "https://github.com/Heroic-Games-Launcher/heroic-gogdl" },
            users: ["GOG downloads"] }];
        }
        const legendary = /^legendary-([\w.+-]+)-([0-9a-f]{12})$/.exec(name);
        return legendary ? [{ id: name, label: "Legendary", version: `Legendary ${legendary[1]}`, path: directory,
          source: { url: "https://pypi.org/project/legendary-gl/" }, users: ["Epic Games Store downloads"] }] : [];
      });
    },
    remove(item, context) { return Components.removeOwned(item.path, tools(context)); }
  }
];
