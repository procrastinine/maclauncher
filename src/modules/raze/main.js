const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const { publisherAppHooks, isFile } = require("../shared/runtime/publisher-app");

const gameFile = entry => path.join(entry.contentRootDir || path.dirname(entry.gamePath), entry.moduleData?.gameFile || "");

// Raze reads the game data in place with `-gamegrp` and starts in the game's
// folder, where it also finds the game's other files; it keeps its
// configuration and saves in its own user folders.
function launchArguments(entry) {
  return { args: ["-gamegrp", gameFile(entry)], cwd: path.dirname(gameFile(entry)) };
}

module.exports = { id: manifest.id, manifest, detectGame,
  ...publisherAppHooks({ manager, runtimeId: "raze", launchArguments, isGame: entry => isFile(gameFile(entry)),
    missing: "The game's GRP or RFF file is missing." }),
  __test: { launchArguments } };
