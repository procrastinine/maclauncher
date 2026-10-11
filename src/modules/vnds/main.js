const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Love = require("../love/main");
const Manager = require("../love/runtime/love-runtime-manager");
const Preparation = require("./prepare");
const Save = require("./save");
const Ui = require("../shared/ui-services");
const RUNTIME = "vnds_love";
function hostEntry(entry) {
  return { ...entry, runtimeId: "love", moduleData: { detectedVersion: "11.5", detectedVersionNormalized: "11.5", resolvedChannel: "stable" },
    runtimeData: { love: { ...entry.runtimeData?.[RUNTIME] } } };
}
function hostStatus(entry, context) { return Love.actions.runtimeStatus(hostEntry(entry), {}, context); }
function resolveInstalled(entry, context) {
  const status = hostStatus(entry, context);
  const install = Manager.core.resolveInstalled({ userDataDir: context.userDataDir, channel: status.resolvedChannel || status.installChannel, version: status.resolvedVersion });
  if (!install?.appPath) throw new Error("A compatible LÖVE runtime is not installed.");
  return install;
}
module.exports = {
  id: manifest.id, manifest, detectGame, save: Save,
  normalizeRuntimeId: () => RUNTIME,
  resolveSaveLocations: Preparation.saveLocations,
  onImport: (entry, context) => { const locations = Preparation.saveLocations(entry, context); entry.defaultSaveDir = locations.primaryDirectory; entry.saveLocations = locations.directories; },
  ensureRuntime: (entry, context) => Love.ensureRuntime(hostEntry(entry), { ...context, runtimeId: "love" }),
  async launchRuntime(runtimeId, entry, context) {
    if (runtimeId !== RUNTIME) return null;
    const install = resolveInstalled(entry, context), executable = Manager.core.resolveExecutablePath(install.appPath);
    if (!executable) throw new Error("The managed LÖVE executable is missing.");
    const framework = path.join(install.appPath, "Contents", "Frameworks", "love.framework", "Versions", "A", "love");
    if (!fs.statSync(framework).isFile()) throw new Error("This LÖVE runtime has no supported native filesystem library.");
    const prepared = await Preparation.prepare(entry, context);
    return context.spawnDetachedChecked(executable, [prepared.engine], { cwd: prepared.working, env: { ...process.env,
      MACLAUNCHER_VNDS_PHYSFS: framework, MACLAUNCHER_VNDS_ROOT: prepared.root, MACLAUNCHER_VNDS_SAVES: prepared.saveRoot,
      MACLAUNCHER_VNDS_MOUNTS: prepared.mountFile, MACLAUNCHER_VNDS_TITLE: entry.name || "VNDS",
      MACLAUNCHER_VNDS_FULLSCREEN: context.runtimeSettings?.fullscreen ? "1" : "0" } }, Boolean(install.requiresRosetta));
  },
  actions: {
    runtimeStatus: (entry, _payload, context) => ({ ...hostStatus(entry, context), adapterVersion: Preparation.PROFILE, sourceRevision: Preparation.REVISION }),
    showScripts: (entry, _payload, context) => { const file = entry.moduleData?.scriptPath || path.join(entry.contentRootDir || entry.gamePath, "script"); Ui.getUiServices(context).shell.showItemInFolder(file); return { path: file }; }
  },
  __test: { hostEntry, hostStatus, resolveInstalled }
};
