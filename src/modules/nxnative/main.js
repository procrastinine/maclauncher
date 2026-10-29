const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const Prepare = require("./prepare");
const Tools = require("./tools");
const Application = require("./application");
const GameSettings = require("./settings");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager, manager.toolsManager],
  normalizeRuntimeId: value => value === "inspection" ? value : "nxnative",
  filterRuntimeSupport: entry => entry.moduleData?.inspectionOnly ? ["inspection"] : ["nxnative"],
  canLaunchRuntime: (runtimeId, entry) => runtimeId === "nxnative" && entry.moduleData?.inspectionOnly === false,
  onImport: (entry, context) => { entry.defaultSaveDir = Prepare.saveDirectory(entry, context); },
  onRuntimeChange: (entry, context) => { entry.defaultSaveDir = Prepare.saveDirectory(entry, context); },
  resolveGameIcon: Application.resolveGameIcon,
  metadataSources: ["application.js"],
  resolveGraphicsInputs: () => ({ architecture: "arm64" }),
  ensureRuntime: (entry, context) => {
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selected.ready ? null : { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "nxnative") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const runtime = await Prepare.runtimeForSelection(selected, context);
    Prepare.recordSelectionUse(entry, context, selected, runtime);
    const launch = await Prepare.prepareGame(entry, context, { ...selected, runtime });
    const gameSettings = await GameSettings.launchEnvironment(entry, context, launch, runtime);
    const application = await Application.prepareApplication(entry, context, launch, { runtime });
    entry.iconPath = application.iconPath;entry.iconSource = application.iconSource;
    context.onEntryChange?.({ defaultSaveDir: entry.defaultSaveDir, moduleData: entry.moduleData, runtimeData: entry.runtimeData,
      iconPath: entry.iconPath, iconSource: entry.iconSource });
    return spawnForegroundNativeGame({ context, executablePath: application.executablePath, args: launch.args, needsRosetta: false,
      options: { cwd: launch.cwd, gameArguments: false, env: { ...process.env, ...launch.env, ...gameSettings } } });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(Prepare.gameDirectory(entry, context), { recursive: true, force: true });return true; },
  settingsActions: { pickKeysFile: Prepare.pickKeysFile, keysFileStatus: Prepare.keysFileStatus },
  actions: { runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    readGameSettings: GameSettings.read, writeGameSettings: GameSettings.write,
    pickKeysFile: (_entry, payload, context) => Prepare.pickKeysFile(payload, context),
    keysFileStatus: (_entry, payload) => Prepare.keysFileStatus(payload),
    chooseKeys: Prepare.chooseKeys, inspectProgram: Tools.inspectProgram, decompile: Tools.decompile, revealExport: Tools.revealExport }
};
