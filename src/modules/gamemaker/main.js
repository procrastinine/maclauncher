const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const { inspectStudio, LIMITS } = require("./inspect");
const Exports = require("./export");
const Tools = require("./tools");
const Native = require("../shared/runtime/local-native");
const GraphicsInputs = require("../shared/runtime/native-graphics-inputs");
const AppBundle = require("../shared/runtime/app-bundle");
const { getUiServices } = require("../shared/ui-services");
const Butterscotch = require("./runtime/butterscotch");
const Umt = require("./runtime/undertale-mod-tool").manager;
const Gm8 = require("./runtime/gm8-decompiler").manager;
const OpenGMK = require("./runtime/opengmk");
const ClassicLaunch = require("./runtime/classic-launch");
const Official = require("./runtime/official");
const OfficialLaunch = require("./runtime/official-launch");
const { confirmToolInstall } = require("../shared/runtime/tool-install");

function patchModuleData(entry, patch) { entry.moduleData = { ...(entry.moduleData || {}), ...patch }; }
function selectToolVersion(entry, manager, version) {
  const runtimeId = Object.entries(manifest.runtime.manager || {}).find(([, managerId]) => managerId === manager.id)?.[0] || manager.id;
  const runtimeData = { ...(entry.runtimeData || {}), [runtimeId]: { ...(entry.runtimeData?.[runtimeId] || {}), version } };
  if (runtimeId !== manager.id) delete runtimeData[manager.id];
  entry.runtimeData = runtimeData;
}

function resolveNativeLaunchPath(entry) {
  const appPath = entry?.nativeAppPath;
  if (entry?.moduleData?.sourceKind !== "app-bundle" || !appPath) return null;
  try {
    const executable = AppBundle.resolveAppBundleExecutablePath(appPath);
    if (!executable) return null;
    Native.readMachOArchitectures(executable);
    return appPath;
  } catch { return null; }
}

function nativeOptions(selection) {
  return { runtimePath: selection.install.executablePath, runtimeVersion: selection.version,
    upstreamRevision: selection.install.upstreamRevision, expectedSha256: selection.install.binarySha256 };
}

function resolveGraphicsInputs(entry, context = {}) {
  if ((context.runtimeId || entry.runtimeId || manifest.runtime.default) !== "official-studio") return null;
  const selected = Official.manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) return null;
  return GraphicsInputs.withInputs({ moduleData: { executablePath: selected.install.executablePath,
    executableArchitectures: selected.install.architectures } }, { runtimeId: "native" });
}

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId === "inspection") throw new Error(entry?.moduleData?.supportReason || "This GameMaker package supports inspection only.");
  if (runtimeId === "official-studio") return OfficialLaunch.launchOfficial(entry, context,
    Official.manager.resolveSelection(entry, context.settings, context.userDataDir));
  if (runtimeId === "opengmk") return ClassicLaunch.launchClassic(entry, context,
    OpenGMK.manager.resolveSelection(entry, context.settings, context.userDataDir));
  if (runtimeId !== "butterscotch") return null;
  const dataPath = Exports.resolveDataPath(entry);
  const inspection = inspectStudio(dataPath);
  if (!inspection.butterscotchCandidate) throw new Error(inspection.reasons.join(" "));
  const selection = Butterscotch.manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selection.install) throw new Error(selection.reason);
  const saves = path.join(Exports.resolveOutputRoot(entry, context), "saves");
  if (fs.existsSync(saves) && fs.lstatSync(saves).isSymbolicLink()) throw new Error("GameMaker save directory is a symlink.");
  fs.mkdirSync(saves, { recursive: true });
  entry.defaultSaveDir = saves;
  patchModuleData(entry, { lastRuntimeVersion: selection.version, lastRuntimeRevision: selection.install.upstreamRevision,
    lastRuntimeBackend: "appkit", lastRuntimeSha256: selection.install.binarySha256 });
  context.onEntryChange?.({ defaultSaveDir: saves, moduleData: entry.moduleData });
  return Native.launchLocalRuntime({ ...nativeOptions(selection), args: [dataPath, "--save-folder", saves, "--renderer", "legacy-gl",
    ...(context.gameArguments || []).map(argument => `--game-arg=${argument}`)],
    cwd: path.dirname(dataPath), context });
}

function rememberExport(entry, result) {
  patchModuleData(entry, { lastExportDir: result.outputDir, lastExportAt: Date.now() });
  return result;
}

async function ensureDecompiler(entry, context, requestedVersion) {
  const classic = entry?.moduleData?.executionKind === "classic";
  const inspection = classic ? Exports.inspectEntry(entry, false) :
    inspectStudio(Exports.resolveDataPath(entry), { includeNames: true, limits: { ...LIMITS, names: LIMITS.entries } });
  if (classic) {
    if (inspection.fileBytes > 128 * 1024 ** 2) throw new Error("Classic decompilation is limited to 128 MiB inputs.");
  } else {
    if (inspection.executionKind !== "studio-vm") throw new Error("YYC/native or code-free Studio data has no VM GML to decompile.");
    Tools.validateCodeNames(inspection);
  }
  const manager = classic ? Gm8 : Umt;
  let selection = manager.resolveSelection(entry, context.settings, context.userDataDir,
    requestedVersion ? { version: manager.core.normalizeVersion(requestedVersion) } : undefined);
  const version = selection.version;
  if (!selection.ready) {
    manager.core.normalizeVersion(version);
    await confirmToolInstall(context, { manager, version, detail: "Required for GameMaker decompilation." });
    await manager.installRuntime({ userDataDir: context.userDataDir, version,
      logger: context.logger, downloads: context.downloads, signal: context.signal,
      prerequisiteContext: context, confirmRuntimeInstall: context.confirmRuntimeInstall });
    context.onRuntimeStateChange?.();
    selection = manager.resolveSelection(entry, context.settings, context.userDataDir, { version });
    if (!selection.ready) throw new Error(selection.reason || "The selected decompiler did not produce an intact native installation.");
  }
  if (requestedVersion || !entry.runtimeData?.[manager.id]?.version) {
    selectToolVersion(entry, manager, version);
    context.onEntryChange?.({ runtimeData: entry.runtimeData });
  }
  return { classic, selection };
}

module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [Butterscotch.manager, Umt, Gm8, Official.manager, OpenGMK.manager],
  distributionSupplementals: require('./runtime/distribution-supplementals'),
  normalizeRuntimeId: value => ["opengmk", "butterscotch", "official-studio", "native", "inspection"].includes(value) ? value : "butterscotch",
  filterRuntimeSupport: (entry, supported) => supported.filter(id => id === "inspection" ||
    (id === "opengmk" && entry?.moduleData?.executionKind === "classic") ||
    (id === "official-studio" && entry?.moduleData?.executionKind === "studio-vm") ||
    (id === "butterscotch" && entry?.moduleData?.butterscotchCandidate === true) || (id === "native" && resolveNativeLaunchPath(entry))),
  canLaunchRuntime: (id, entry) => id === "inspection" || (id === "opengmk" && entry?.moduleData?.executionKind === "classic") || (id === "official-studio" && entry?.moduleData?.executionKind === "studio-vm") || (id === "butterscotch" && entry?.moduleData?.butterscotchCandidate === true) || (id === "native" && Boolean(resolveNativeLaunchPath(entry))),
  ensureRuntime: async (entry, context) => {
    const id = context.runtimeId;
    if (id === "opengmk") {
      const selected = OpenGMK.manager.resolveSelection(entry, context.settings, context.userDataDir);
      await OpenGMK.preflight(Exports.resolveDataPath(entry), selected, { signal: context.signal });
      return selected.ready ? null : { managerId: OpenGMK.manager.id, version: selected.version, installOptions: {} };
    }
    if (!["butterscotch", "official-studio"].includes(id)) return null;
    const dataPath = Exports.resolveDataPath(entry);
    if (id === "butterscotch") {
      const inspection = inspectStudio(dataPath);
      if (!inspection.butterscotchCandidate) throw new Error(inspection.reasons.join(" "));
      const selected = Butterscotch.manager.resolveSelection(entry, context.settings, context.userDataDir);
      return selected.ready ? null : { managerId: Butterscotch.manager.id, version: selected.version, installOptions: {} };
    }
    // Reject unsupported bytecode/extensions before an explicit Play can download.
    // Use the current archive's format evidence, even if its import is older.
    const inspection = OfficialLaunch.preflight(dataPath);
    const inspectedEntry = { ...entry, moduleData: { ...entry.moduleData,
      executionKind: inspection.executionKind, wadVersion: inspection.wadVersion,
      minimumEngineVersion: inspection.minimumEngineVersion,
      maximumOfficialRuntimeExclusive: inspection.maximumOfficialRuntimeExclusive,
      spriteSequenceLayout: inspection.spriteSequenceLayout } };
    let selected = Official.manager.resolveSelection(inspectedEntry, context.settings, context.userDataDir);
    if (!selected.version) throw new Error(selected.reason);
    // A missing native game dependency is not fixed by downloading another
    // runner. Reject it before Play starts a catalog refresh or installation.
    OfficialLaunch.validateNativeDependencies(inspection, dataPath, selected.install, { context, runnerVersion: selected.version });
    if (selected.selectionSource === "explicit-selection" || selected.ready) {
      OfficialLaunch.preflight(dataPath, selected.version);
      if (selected.ready) return null;
    }
    if (selected.selectionSource !== "explicit-selection" && !selected.ready && !selected.catalogReady) {
      await Official.manager.refreshCatalog({ userDataDir: context.userDataDir, logger: context.logger });
      selected = Official.manager.resolveSelection(inspectedEntry, context.settings, context.userDataDir);
    }
    if (!selected.version) throw new Error(selected.reason);
    OfficialLaunch.preflight(dataPath, selected.version);
    return selected.ready ? null : { managerId: Official.manager.id, version: selected.version, installOptions: {} };
  },
  cleanupGameData: OfficialLaunch.cleanupGameData,
  resolveNativeLaunchPath, resolveGraphicsInputs, launchRuntime,
  actions: {
    inspect: (entry, _payload, context) => rememberExport(entry, Exports.exportInspection(entry, context)),
    exportChunks: (entry, _payload, context) => rememberExport(entry, Exports.exportChunks(entry, context)),
    revealExport: (entry, _payload, context) => {
      const outputDir = entry?.moduleData?.lastExportDir;
      if (!outputDir || !fs.existsSync(outputDir)) throw new Error("No GameMaker export is available.");
      getUiServices(context).shell.showItemInFolder(outputDir);
      return { outputDir };
    },
    decompile: async (entry, payload, context) => {
      const { classic, selection } = await ensureDecompiler(entry, context, payload?.version);
      return rememberExport(entry, await (classic ? Tools.decompileClassic : Tools.decompileStudio)(entry, context, selection));
    }
  }
};
