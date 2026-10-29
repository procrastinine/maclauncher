const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const Launch = require("./launch");
const rlvmManager = require("./runtime/rlvm-manager");
const RLVM = require("./rlvm-launch");
const Tools = require("./tools");
const runtimeFor = (entry, context) => context.runtimeId || entry.runtimeId || context.settings?.modules?.siglus?.defaultRuntime || manifest.runtime.default;
const backendFor = runtime => runtime === "rlvm" ? { manager: rlvmManager, launch: RLVM } : { manager, launch: Launch };
const resolveSaveLocations = (entry, context) => backendFor(runtimeFor(entry, context)).launch.resolveSaveLocations(entry, context);

module.exports = { metadataSources: ["icon.js"], resolveGameIcon: require("./icon").resolveGameIcon, id: "siglus", manifest, detectGame, runtimeManagers: [manager, rlvmManager, rlvmManager.adapterManager, Tools.manager, Tools.realLiveManager], resolveSaveLocations,
  normalizeRuntimeId: runtime => String(runtime || "siglus").toLowerCase(),
  filterRuntimeSupport: (entry, supported) => supported.filter(runtime => runtime !== "rlvm" || RLVM.supports(entry.moduleData)),
  onImport: (entry, context) => { entry.defaultSaveDir = resolveSaveLocations(entry, context).primaryDirectory; },
  ensureRuntime: (entry, context) => {
    const backend = backendFor(runtimeFor(entry, context)), info = backend.launch.inspectEntry(entry);
    entry.moduleData = { ...entry.moduleData, ...info }; context.onEntryChange?.({ moduleData: entry.moduleData });
    const selected = backend.manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selected.ready ? null : { managerId: backend.manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), requiresDownload: true, installOptions: {} };
  },
  getRuntimeRequirements: (entry, context) => {
    if (runtimeFor(entry, context) !== "rlvm") return [];
    const engine = rlvmManager.resolveSelection(entry, context.settings, context.userDataDir);
    const selected = rlvmManager.adapterSelection(engine.install, entry, context);
    return selected.ready ? [] : [{ managerId: rlvmManager.adapterManager.id, version: selected.version,
      ...(selected.discoveryRequired ? { discoveryRequired: true } : {}),
      requiresDownload: true, installOptions: {} }];
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (!["siglus", "rlvm"].includes(runtimeId)) return null;
    const backend = backendFor(runtimeId), selected = backend.manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const install = runtimeId === "rlvm" ? rlvmManager.resolveForLaunch(selected.install, entry, context) : selected.install;
    const prepared = backend.launch.prepareLaunch(entry, context, install);
    context.onEntryChange?.({ moduleData: entry.moduleData, defaultSaveDir: entry.defaultSaveDir });
    const executable = selected.install.executablePath;
    const args = runtimeId === "siglus" && context.gameArguments?.length
      ? [...prepared.args, "--", ...context.gameArguments] : prepared.args;
    return context.spawnDetachedChecked(executable, args, { cwd: prepared.directory, env: prepared.env }, selected.install.needsRosetta);
  },
  cleanupGameData: (entry, context) => { fs.rmSync(Launch.moduleRoot(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    decompile: Tools.decompile,
    revealSource: Tools.revealSource,
    inspectGame: entry => Launch.inspectEntry(entry),
    runtimeStatus: (entry, _payload, context) => backendFor(runtimeFor(entry, context)).manager.resolveSelection(entry, context.settings, context.userDataDir)
  }
};
