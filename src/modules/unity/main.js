const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const Launch = require("./launch");
const { resolveSaveLocations } = require("./save-location");
const Decompiler = require("../shared/runtime/managed-decompiler");
const AppBundle = require("../shared/runtime/app-bundle");
const GraphicsInputs = require("../shared/runtime/native-graphics-inputs");
const Steam = require("./steam");
const AssetRipper = require("./tools/assetripper-manager");
const AssetTools = require("./tools/assets");

function refreshEntry(entry, context) {
  const info = Launch.inspectEntry(entry);
  entry.moduleData = { ...entry.moduleData, ...info };
  context.onEntryChange?.({ moduleData: entry.moduleData });
  return info;
}
function runtimeStatus(entry, context) {
  const info = Launch.inspectEntry(entry), selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  const blocked = info.scriptingBackend !== "mono" || info.graphics.status === "requires-shader-conversion" || info.windowsApis.length;
  return { version: selected.version, ready: selected.ready && !blocked, installed: selected.ready,
    reason: blocked ? info.compatibility : selected.reason, compatibility: info.compatibility,
    nativeImports: info.nativeImports, nativePlugins: info.nativePlugins };
}

function resolveGraphicsInputs(entry, context = {}) {
  const runtimeId = context.runtimeId || entry.runtimeId || manifest.runtime.default;
  let executablePath, architectures, needsRosetta = false;
  if (runtimeId === "native") {
    if (!entry.nativeAppPath) return null;
    executablePath = AppBundle.resolveAppBundleExecutablePath(entry.nativeAppPath);
  } else if (runtimeId === "unity") {
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) return null;
    ({ executablePath, architectures, needsRosetta } = selection.install);
  } else return null;
  // Match the player launch policy, including an explicitly selected Intel
  // slice. Imported Windows/Linux metadata does not describe this executable.
  return GraphicsInputs.withInputs({ moduleData: { executablePath, executableArchitectures: architectures } }, {
    runtimeId: "native", declaredArchitecture: needsRosetta ? "x86_64" : undefined
  });
}

module.exports = {
  id: "unity", manifest, detectGame, runtimeManagers: [manager, AssetRipper], resolveSaveLocations,
  resolveGraphicsInputs,
  normalizeRuntimeId: value => value === "native" ? "native" : "unity",
  canLaunchRuntime: (runtimeId, entry) => runtimeId !== "native" || Boolean(entry.nativeAppPath),
  ensureRuntime: async (entry, context) => {
    if (context.runtimeId === "native") return null;
    const info = Launch.preflight(entry);
    entry.moduleData = { ...entry.moduleData, ...info };
    context.onEntryChange?.({ moduleData: entry.moduleData });
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.version) throw new Error(selection.reason);
    if (selection.version !== info.detectedVersion) throw new Error(selection.reason);
    if (selection.ready) return null;
    await manager.ensureCatalogVersion({ userDataDir: context.userDataDir, version: selection.version, signal: context.signal, logger: context.logger });
    context.onRuntimeStateChange?.();
    return { managerId: "unity", version: selection.version, requiresDownload: true, installOptions: { sectionId: "default" } };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId === "native") {
      if (!entry.nativeAppPath) throw new Error("This game does not include a native Mac app.");
      const executable = AppBundle.resolveAppBundleExecutablePath(entry.nativeAppPath);
      return context.spawnDetachedChecked(executable, context.gameArguments || [], { cwd: path.dirname(executable) }, false);
    }
    if (runtimeId !== "unity") return null;
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir), info = Launch.preflight(entry);
    Launch.validateSelection(info, selection);
    const root = Launch.moduleRoot(entry, context);
    const steam = await Steam.prepareLaunch({ info, entry, context, selection, baseEnvironment: { ...process.env } });
    const prepared = await Launch.prepareLaunch(entry, context, selection, { steam });
    const logPath = path.join(root, "Player.log"), settings = context.runtimeSettings || {};
    const args = ["-logFile", logPath, ...Launch.rendererArguments(prepared.info, settings), ...(settings.windowed === false ? [] : ["-screen-fullscreen", "0"]), ...(context.gameArguments || [])];
    return context.spawnDetachedChecked(prepared.executablePath, args, { cwd: root, env: steam?.environment || { ...process.env } }, selection.install.needsRosetta);
  },
  cleanupGameData: (entry, context) => { fs.rmSync(Launch.moduleRoot(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    inspectGame: (entry, _payload, context) => refreshEntry(entry, context),
    runtimeStatus: (entry, _payload, context) => runtimeStatus(entry, context),
    decompile: (entry, payload, context) => {
      const info = Launch.inspectEntry(entry);
      if (info.scriptingBackend !== "mono" || !info.assemblyPath) throw new Error("This game does not contain a Mono game assembly.");
      return Decompiler.decompileAssembly({ entry, payload: payload || {}, context, moduleId: "unity", assemblyPath: info.assemblyPath });
    },
    revealDecompiled: (entry, _payload, context) => Decompiler.revealSource({ entry, context, moduleId: "unity" }),
    openAssetInspector: AssetTools.openInspector,
    closeAssetInspector: AssetTools.closeInspector,
    exportAssets: AssetTools.exportAssets,
    revealAssets: AssetTools.revealAssets
  },
  __test: { refreshEntry, runtimeStatus }
};
