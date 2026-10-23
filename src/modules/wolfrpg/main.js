const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame, inspectRoot } = require("./detect");
const Manager = require("./runtime/manager");
const Preparation = require("./prepare");
module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [Manager],
  normalizeRuntimeId: () => "browser-woditor",
  canLaunchRuntime: (runtimeId, entry) => runtimeId === "browser-woditor" && Boolean(inspectRoot(entry.gamePath)),
  prepareLaunch: Preparation.prepareLaunch,
  getContentReadRoots: Preparation.contentReadRoots,
  resolveSaveLocations: Preparation.saveLocations,
  cleanupGameData(entry, context) {
    fs.rmSync(Preparation.moduleDir(entry, context), { recursive: true, force: true }); return true;
  },
  actions: {
    ...require("./tools"),
    runtimeStatus(entry, _payload, context) {
      const version = entry.runtimeData?.["browser-woditor"]?.version;
      const install = Manager.core.resolveInstalled({ userDataDir: context.userDataDir, version });
      return { ready: Boolean(install), version: install?.version || version || null };
    }
  }
};
