const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, candidates } = require("./detect");
const manager = require("./runtime/manager");
const { publisherAppHooks, publisherAppProvider, isFile } = require("../shared/runtime/publisher-app");

const gameFile = entry => path.join(entry.contentRootDir || path.dirname(entry.gamePath), entry.moduleData?.gameFile || "");

// Raze starts in the game's folder, which it searches for game data, and
// `-gamegrp` selects the main file by name among the files it finds there. An
// add-on GRP selected this way loads the base game it depends on from the same
// folder. A full path never matches Raze's name lookup, which then asks for a
// game when the folder holds several. Configuration, saves and logs go to the
// game's engine home in the launcher data.
function launchArguments(entry) {
  return { args: ["-gamegrp", path.basename(gameFile(entry))], cwd: path.dirname(gameFile(entry)) };
}

const hooks = publisherAppHooks({ manager, moduleId: "raze", launchArguments, isGame: entry => isFile(gameFile(entry)),
    missing: "The game's GRP or RFF file is missing." });

// A DOS game whose folder holds one of this engine's main game files can
// also run here, chosen as the game's runtime.
const runtimeProvider = publisherAppProvider({ hooks, moduleId: manifest.id, runtime: manifest.runtime.entries[manifest.id], gameTypes: ["dos"],
  candidates: folder => candidates(folder),
  entryFor: (entry, file) => ({ ...entry, contentRootDir: path.dirname(file), moduleData: { ...entry.moduleData, gameFile: path.basename(file) } }) });

module.exports = { id: manifest.id, manifest, detectGame, ...hooks, runtimeProvider,
  __test: { launchArguments } };
