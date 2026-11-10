const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const { publisherAppHooks } = require("../shared/runtime/publisher-app");

const gameFolder = entry => entry.contentRootDir || entry.gamePath;

// `dreamm -run <folder>` identifies the game in the folder and starts it
// without the Game Manager. DREAMM keeps the files a game writes in its own
// user folder, so the game folder stays unchanged.
function launchArguments(entry) {
  return { args: ["-run", gameFolder(entry)], cwd: gameFolder(entry) };
}

module.exports = { id: manifest.id, manifest, detectGame,
  ...publisherAppHooks({ manager, runtimeId: "dreamm", launchArguments,
    isGame: entry => { try { return fs.statSync(gameFolder(entry)).isDirectory(); } catch { return false; } },
    missing: "The game folder is missing." }),
  __test: { launchArguments } };
