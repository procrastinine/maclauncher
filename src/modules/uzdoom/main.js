const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, candidates } = require("./detect");
const manager = require("./runtime/manager");
const { publisherAppHooks, publisherAppProvider, isFile } = require("../shared/runtime/publisher-app");

const gameFile = entry => path.join(entry.contentRootDir || path.dirname(entry.gamePath), entry.moduleData?.gameFile || "");

// UZDoom reads the main game file in place with `-iwad`; its configuration
// and saves go to the game's engine home in the launcher data.
function launchArguments(entry) {
  return { args: ["-iwad", gameFile(entry)], cwd: path.dirname(gameFile(entry)) };
}

const hooks = publisherAppHooks({ manager, moduleId: "uzdoom", launchArguments, isGame: entry => isFile(gameFile(entry)),
    missing: "The game's WAD or IPK3 file is missing." });

// A DOS game whose folder holds one of this engine's main game files can
// also run here, chosen as the game's runtime.
const runtimeProvider = publisherAppProvider({ hooks, moduleId: manifest.id, runtime: manifest.runtime.entries[manifest.id], gameTypes: ["dos"],
  candidates: folder => candidates(folder),
  entryFor: (entry, file) => ({ ...entry, contentRootDir: path.dirname(file), moduleData: { ...entry.moduleData, gameFile: path.basename(file) } }) });

module.exports = { id: manifest.id, manifest, detectGame, ...hooks, runtimeProvider,
  __test: { launchArguments } };
