const GameData = require("../shared/game-data");

// Derived HashLink data; see core/storage-maintenance.js.
module.exports = [
  {
    // The game folder view staged by a launch that quit before it
    // was renamed into place. The next launch stages it again.
    id: "hashlink-staging",
    directories: context => context.gameIds().map(gameId => GameData.resolveGameModuleDir(context.userDataDir, gameId, "hashlink")),
    match: /^\.stage-[A-Za-z0-9]{6}$/,
    minAgeMs: 24 * 60 * 60 * 1000
  }
];
