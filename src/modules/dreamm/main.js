const path = require("node:path");
const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame, candidates } = require("./detect");
const manager = require("./runtime/manager");
const { publisherAppHooks, publisherAppProvider } = require("../shared/runtime/publisher-app");

const gameFolder = entry => entry.contentRootDir || entry.gamePath;

// `dreamm -run <folder>` identifies the game in the folder and starts it
// without the Game Manager. DREAMM keeps the files a game writes in the
// game's engine home in the launcher data, so the game folder stays unchanged.
function launchArguments(entry) {
  return { args: ["-run", gameFolder(entry)], cwd: gameFolder(entry) };
}

const hooks = publisherAppHooks({ manager, moduleId: "dreamm", launchArguments,
    isGame: entry => { try { return fs.statSync(gameFolder(entry)).isDirectory(); } catch { return false; } },
    missing: "The game folder is missing." });

// A DOS game whose folder holds one of the games DREAMM runs can also run
// here, chosen as the game's runtime.
const runtimeProvider = publisherAppProvider({ hooks, moduleId: manifest.id, runtime: manifest.runtime.entries[manifest.id], gameTypes: ["dos"],
  candidates: folder => candidates(folder), entryFor: (entry, file) => ({ ...entry, contentRootDir: path.dirname(file) }) });

module.exports = { id: manifest.id, manifest, detectGame, ...hooks, runtimeProvider,
  __test: { launchArguments } };
