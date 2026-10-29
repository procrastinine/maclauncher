const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame, inspectRoot } = require("./detect");
const Manager = require("./runtime/manager");
const Preparation = require("./prepare");
const Inspection = require("./inspection-tools");
const AssetTools = require("./tools");
const { selectRuntimeVersion } = require("../shared/runtime/version-choices");
module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [Manager, Inspection.WolfTL, Inspection.UberWolf],
  normalizeRuntimeId: () => "browser-woditor",
  canLaunchRuntime: (runtimeId, entry) => runtimeId === "browser-woditor" && Boolean(inspectRoot(entry.gamePath)),
  prepareLaunch: Preparation.prepareLaunch,
  getContentReadRoots: Preparation.contentReadRoots,
  resolveSaveLocations: Preparation.saveLocations,
  cleanupGameData(entry, context) {
    fs.rmSync(Preparation.moduleDir(entry, context), { recursive: true, force: true }); return true;
  },
  actions: {
    listArchive: AssetTools.listArchive,
    extractAssets: AssetTools.extractAssets,
    revealAssets: AssetTools.revealAssets,
    removeAssets: AssetTools.removeAssets,
    exportProjectJson: Inspection.exportProjectJson,
    extractAdvancedAssets: Inspection.extractAdvancedAssets,
    revealProject: Inspection.revealProject,
    runtimeStatus(entry, _payload, context) {
      const configured = context.settings?.runtimes?.["browser-woditor"];
      const { version } = selectRuntimeVersion({ manual: entry.runtimeData?.["browser-woditor"]?.version,
        defaultVersion: configured?.customDefaults?.default || configured?.defaultVersion,
        fallback: Manager.getState({ settings: configured, userDataDir: context.userDataDir }).defaultVersion });
      const install = version ? Manager.core.resolveInstalled({ userDataDir: context.userDataDir, version }) : null;
      return { ready: Boolean(install), version: install?.version || version || null };
    }
  }
};
