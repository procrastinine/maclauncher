const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const { publisherAppHooks, isFile } = require("../shared/runtime/publisher-app");

const gameFile = entry => path.join(entry.contentRootDir || path.dirname(entry.gamePath), entry.moduleData?.gameFile || "");

// UZDoom reads the main game file in place with `-iwad`; it keeps its
// configuration and saves in its own user folders.
function launchArguments(entry) {
  return { args: ["-iwad", gameFile(entry)], cwd: path.dirname(gameFile(entry)) };
}

module.exports = { id: manifest.id, manifest, detectGame,
  ...publisherAppHooks({ manager, runtimeId: "uzdoom", launchArguments, isGame: entry => isFile(gameFile(entry)),
    missing: "The game's WAD or IPK3 file is missing." }),
  __test: { launchArguments } };
