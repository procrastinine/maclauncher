const fs = require("node:fs"), path = require("node:path");
const GameData = require("../shared/game-data");

// Derived MKXP-Z data; see core/storage-maintenance.js.
module.exports = [
  {
    // One configuration, launch snapshot and native log per launch. The two
    // newest sessions of each runtime version stay for their logs.
    id: "mkxpz-sessions",
    directories(context) {
      const folders = [];
      for (const gameId of context.gameIds()) {
        const runtime = GameData.resolveGameRuntimeDir(context.userDataDir, gameId, "mkxpz");
        let versions = [];
        try { versions = fs.readdirSync(runtime, { withFileTypes: true }); } catch {}
        for (const version of versions) if (version.isDirectory()) folders.push(path.join(runtime, version.name, "sessions"));
      }
      return folders;
    },
    match: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    newest: 2
  },
  {
    // A shared asset generation staged by a launch that quit before it was
    // renamed into place. A later launch stages its own.
    id: "rgss-asset-staging",
    directories: context => [path.join(context.userDataDir, "modules", "rgss", "assets", "generations")],
    match: /^\.prepare-[A-Za-z0-9]{6}$/,
    minAgeMs: 24 * 60 * 60 * 1000
  },
  {
    // An RTP pack deleted in Downloaded files is renamed to trash beside its
    // version first; a removal that stopped is finished here. Nothing else matches.
    id: "rgss-rtp-removals",
    directories: context => {
      const root = path.join(context.userDataDir, "modules", "rgss", "assets", "rtp-packs");
      try { return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith(".")).map(item => path.join(root, item.name)); }
      catch { return []; }
    },
    match: require("../../core/storage-maintenance").TRASH
  }
];
