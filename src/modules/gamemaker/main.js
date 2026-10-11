const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const { inspectStudio, LIMITS } = require("./inspect");
const Exports = require("./export");
const Tools = require("./tools");
const Native = require("../shared/runtime/local-native");
const AppBundle = require("../shared/runtime/app-bundle");
const { getUiServices } = require("../shared/ui-services");
const Butterscotch = require("./runtime/butterscotch");
const Umt = require("./runtime/undertale-mod-tool").manager;
const Gm8 = require("./runtime/gm8-decompiler").manager;
const OpenGMK = require("./runtime/opengmk");
const ClassicLaunch = require("./runtime/classic-launch");
const Official = require("./runtime/official");
const OfficialPackages = require("./runtime/official-packages");
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

function runtimeStatus(entry, _payload, context) {
  const selection = Butterscotch.manager.resolveSelection(entry, context.settings, context.userDataDir);
  const build = Butterscotch.manager.core.catalog.find(item => item.version === selection.version);
  let inspection;
  try { inspection = inspectStudio(Exports.resolveDataPath(entry)); } catch (error) {
    return { ready: false, installed: Boolean(selection.install), version: selection.version, reason: error.message };
  }
  return { ready: Boolean(selection.install && inspection.butterscotchCandidate), installed: Boolean(selection.install),
    version: selection.version, upstreamRevision: build?.upstreamRevision, backend: build?.backend,
    binarySha256: selection.install?.binarySha256 || null, sourceBuildVerified: Boolean(selection.install?.sourceBuildVerified || selection.install?.buildProvenance?.verifiedBuild),
    compatibility: "experimental-unverified", reason: !inspection.butterscotchCandidate ? inspection.reasons.join(" ") : selection.reason || "Experimental runtime; game compatibility varies." };
}

async function register(entry, payload, context, manager) {
  const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  const version = manager.core.normalizeVersion(payload?.version || selection.version);
  let runtimePath = payload?.runtimePath;
  if (!runtimePath) {
    const picked = await getUiServices(context).dialog.showOpenDialog({ title: `Register ${manager.label} ${version}`, properties: ["openFile"] });
    if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true };
    runtimePath = picked.filePaths[0];
  }
  const install = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath });
  selectToolVersion(entry, manager, version);
  context.onRuntimeStateChange?.();
  return { version, upstreamRevision: install.upstreamRevision, binarySha256: install.binarySha256,
    executablePath: install.executablePath, provenanceVerified: install.provenanceVerified };
}

async function selectOfficialRoot(payload, context) {
  if (payload?.runtimeRoot) return payload.runtimeRoot;
  const picked = await getUiServices(context).dialog.showOpenDialog({ title: "Select installed official GameMaker runtime (runtime-version folder)", properties: ["openDirectory"] });
  return picked.canceled ? null : picked.filePaths?.[0] || null;
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
  return Native.launchLocalRuntime({ ...nativeOptions(selection), args: [dataPath, "--save-folder", saves, "--renderer", "legacy-gl"],
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
  resolveNativeLaunchPath, launchRuntime,
  actions: {
    inspect: (entry, _payload, context) => rememberExport(entry, Exports.exportInspection(entry, context)),
    exportChunks: (entry, _payload, context) => rememberExport(entry, Exports.exportChunks(entry, context)),
    revealExport: (entry, _payload, context) => {
      const outputDir = entry?.moduleData?.lastExportDir;
      if (!outputDir || !fs.existsSync(outputDir)) throw new Error("No GameMaker export is available.");
      getUiServices(context).shell.showItemInFolder(outputDir);
      return { outputDir };
    },
    runtimeStatus,
    classicRuntimeStatus: async (entry, _payload, context) => {
      const selection = OpenGMK.manager.resolveSelection(entry, context.settings, context.userDataDir);
      const inspection = await OpenGMK.preflight(Exports.resolveDataPath(entry), selection, { signal: context.signal });
      return { ready: selection.ready && inspection.parserAvailable, version: selection.version,
        backend: "AppKit / OpenGL 4.1 / CoreAudio", assetsVerified: inspection.assetsVerified,
        extensionCount: inspection.extensionCount ?? null, externalDefinitionCount: inspection.externalDefinitionCount ?? null,
        unsupportedLibraries: inspection.unsupportedLibraries || [],
        binarySha256: selection.install?.binarySha256 || null, reason: selection.reason || inspection.qualification };
    },
    registerClassicRuntime: (entry, payload, context) => register(entry, payload, context, OpenGMK.manager),
    officialRuntimeStatus: (entry, _payload, context) => {
      const selection = Official.manager.resolveSelection(entry, context.settings, context.userDataDir);
      let reason = selection.reason;
      try { OfficialLaunch.preflight(Exports.resolveDataPath(entry), selection.version); } catch (error) { reason = error.message; }
      return { ready: Boolean(selection.install && !reason), version: selection.version, runtimeReady: Boolean(selection.install),
        gameplayQualified: false, gameVersionMatch: "unverified", binarySha256: selection.install?.binarySha256,
        capability: selection.capability, reason: reason || selection.install?.qualification || null };
    },
    installOfficialRuntime: async (entry, payload, context) => {
      const selection = Official.manager.resolveSelection(entry, context.settings, context.userDataDir);
      const version = payload?.version || selection.version;
      if (!version) throw new Error(selection.reason);
      OfficialLaunch.preflight(Exports.resolveDataPath(entry), version);
      const installed = await Official.manager.installRuntime({ ...context, userDataDir: context.userDataDir,
        version, downloads: context.downloads });
      selectToolVersion(entry, Official.manager, installed.version);
      context.onRuntimeStateChange?.();
      return installed;
    },
    buildOpenGLFallback: async (_entry, _payload, context) => require("./runtime/opengl-fallback").buildFallback({ userDataDir: context.userDataDir, logger: context.logger }),
    openGLFallbackStatus: (_entry, _payload, context) => require("./runtime/opengl-fallback").getFallbackStatus({ userDataDir: context.userDataDir }),
    downloadOfficialRuntime: async (entry, payload, context) => {
      const result = await OfficialPackages.downloadOfficialRuntime({ userDataDir: context.userDataDir,
        version: payload?.version || Official.manager.resolveSelection(entry, context.settings, context.userDataDir).version,
        downloads: context.downloads });
      patchModuleData(entry, { officialPackagesRoot: result.packagesRoot, officialPackagesVersion: result.version });
      return result;
    },
    revealOfficialPackages: (entry, _payload, context) => {
      const version = entry?.moduleData?.officialPackagesVersion;
      const result = OfficialPackages.cachedPackages(context.userDataDir, version);
      if (!result) throw new Error("No verified official runtime package cache is available.");
      getUiServices(context).shell.showItemInFolder(result.packagesRoot);
      return { packagesRoot: result.packagesRoot, version };
    },
    inspectOfficialRuntime: async (_entry, payload, context) => {
      const root = await selectOfficialRoot(payload, context);
      if (!root) return { canceled: true };
      return Official.inspectOfficialRuntime(root);
    },
    registerOfficialRuntime: async (entry, payload, context) => {
      const root = await selectOfficialRoot(payload, context);
      if (!root) return { canceled: true };
      const result = await Official.importOfficialRuntime({ userDataDir: context.userDataDir, runtimeRoot: root });
      selectToolVersion(entry, Official.manager, result.version);
      patchModuleData(entry, { officialRuntimeVersion: result.version, officialRuntimeRoot: result.runtimeRoot,
        officialRuntimeQualification: result.qualification });
      context.onRuntimeStateChange?.();
      return result;
    },
    registerRuntime: (entry, payload, context) => register(entry, payload, context, Butterscotch.manager),
    buildRuntime: async (entry, payload, context) => {
      const selection = Butterscotch.manager.resolveSelection(entry, context.settings, context.userDataDir);
      const install = await Butterscotch.buildRuntime({ userDataDir: context.userDataDir, version: payload?.version || selection.version, logger: context.logger });
      selectToolVersion(entry, Butterscotch.manager, install.version);
      context.onRuntimeStateChange?.();
      return { version: install.version, upstreamRevision: install.upstreamRevision, backend: "appkit", binarySha256: install.binarySha256, sourceBuildVerified: true };
    },
    toolStatus: (entry, _payload, context) => {
      const manager = entry?.moduleData?.executionKind === "classic" ? Gm8 : Umt;
      const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
      return { ready: selection.ready, version: selection.version, reason: selection.reason,
        binarySha256: selection.install?.binarySha256 || null, upstreamRevision: selection.install?.upstreamRevision || null };
    },
    installDecompiler: async (entry, payload, context) => {
      const { selection } = await ensureDecompiler(entry, context, payload?.version);
      return { version: selection.version, upstreamRevision: selection.install.upstreamRevision, binarySha256: selection.install.binarySha256 };
    },
    registerDecompiler: (entry, payload, context) => register(entry, payload, context, entry?.moduleData?.executionKind === "classic" ? Gm8 : Umt),
    decompile: async (entry, payload, context) => {
      const { classic, selection } = await ensureDecompiler(entry, context, payload?.version);
      return rememberExport(entry, await (classic ? Tools.decompileClassic : Tools.decompileStudio)(entry, context, selection));
    }
  }
};
