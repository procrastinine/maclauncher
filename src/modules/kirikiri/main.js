const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Native = require("../shared/runtime/local-native");
const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../shared/runtime/bundled-native");
const { getUiServices } = require("../shared/ui-services");
const GameData = require("../shared/game-data");
const { runtimeVersionChoices } = require("../shared/runtime/version-choices");
const { createCatalogDiscovery, prepareReleaseInstall } = require("./catalog");
const Preparation = require("./prepare");
const { prepareGame } = Preparation;
const MsgTool = require("../shared/runtime/msg-tool");

function resourcePin(runtimeManager, userDataDir, version) {
  const state = runtimeManager.getState({ userDataDir });
  const available = new Set(state.catalog.installableVersions || []);
  return runtimeManager.core.listCatalog({ userDataDir }).find(pin =>
    pin.kag3Resources === 1 && available.has(pin.version) && (!version || pin.version === version));
}

function createManager(dependencies = {}) {
const runtimeManager = createPinnedNativeManager({
  id: "krkrsdl2", label: "KiriKiri SDL2",
  projectBuilds: { projectId: "krkrsdl2", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true },
  sourceUrl: "https://github.com/krkrsdl2/krkrsdl2",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "krkrsdl2" }),
  discoverCatalog: createCatalogDiscovery(), prepareInstall: prepareReleaseInstall,
  resolveExecutable: (root, pin) => path.join(root, pin.executableRelative || "krkrsdl2"),
  catalog: [], dependencies
});
const installRuntime = runtimeManager.installRuntime.bind(runtimeManager);
runtimeManager.installRuntime = async ({ kag3Resources, ...options } = {}) => {
  if (kag3Resources !== 1) return installRuntime(options);
  // This option is used only by the consented Play dependency plan. Resource
  // discovery must not change the selected engine or its default version.
  let pin = resourcePin(runtimeManager, options.userDataDir, options.version);
  if (!pin) {
    await runtimeManager.refreshCatalog({ userDataDir: options.userDataDir, logger: options.logger,
      signal: options.signal, force: true, sourceId: "builds" });
    pin = resourcePin(runtimeManager, options.userDataDir, options.version);
  }
  if (!pin) throw new Error("No compatible KAG3 resource package is available.");
  const installed = await installRuntime({ ...options, version: pin.version });
  if (!Preparation.resources(options.userDataDir, installed)) throw new Error("The installed package has no KAG3 compatibility resources.");
  return installed;
};
return runtimeManager;
}
const manager = createManager();
manager.distributionRequired = false;

function selection(entry, context) {
  const configured = context.runtimeSettings?.version;
  const explicit = typeof configured === "string" && configured.trim() && configured !== "auto";
  const effective = explicit
    ? { ...entry, runtimeData: { ...entry.runtimeData, krkrsdl2: { ...entry.runtimeData?.krkrsdl2, version: configured.trim() } } } : entry;
  const selected = manager.resolveSelection(effective, context.settings, context.userDataDir);
  const required = entry.moduleData?.requiredNativeFeatures || [];
  const pins = manager.core.listCatalog({ userDataDir: context.userDataDir });
  const supports = version => required.every(feature => pins.find(pin => pin.version === version)?.nativeFeatures?.includes(feature));
  if (!required.length || supports(selected.version)) return selected;
  const compatible = pins.find(pin => supports(pin.version));
  const globalVersion = manager.normalizeSettings(context.settings?.runtimes?.krkrsdl2).defaultVersion;
  const gameVersion = entry.runtimeData?.krkrsdl2?.version;
  if (explicit || gameVersion && gameVersion !== "auto" || globalVersion && globalVersion !== "auto") {
    if (pins.some(pin => pin.version === selected.version))
      throw new Error(`KiriKiri ${selected.version} lacks required native APIs.${compatible ? ` Select ${compatible.version} in Runtime Settings.` : " Select a compatible version in Runtime Settings."}`);
    return selected;
  }
  return compatible ? manager.resolveSelection(effective, context.settings, context.userDataDir,
    { recommendedVersion: compatible.version }) : selected;
}

function preparationInstall(entry, context, selected, recordUse = false) {
  const needsResources = Preparation.needsResources(entry);
  const install = !needsResources || Preparation.resources(context.userDataDir, selected.install) ? selected.install
    : manager.core.listInstalled(context.userDataDir).find(install => Preparation.resources(context.userDataDir, install)) || null;
  if (recordUse && needsResources && install) context.recordRuntimeUse?.({ managerId: manager.id, version: install.version,
    sectionId: "default", sourcePath: install.installDir });
  return install;
}

function getRuntimeRequirements(entry, context) {
  if (context.runtimeId !== "krkrsdl2" || !Preparation.needsResources(entry)) return [];
  const selected = selection(entry, context);
  if (Preparation.resources(context.userDataDir, selected.install) || preparationInstall(entry, context, selected)) return [];
  if (!selected.install && selected.discoveryRequired) return [];
  // A missing selected host carrying the resource contract installs both at once.
  if (manager.core.listCatalog({ userDataDir: context.userDataDir }).some(pin => pin.version === selected.version && pin.kag3Resources === 1)) return [];
  const donor = resourcePin(manager, context.userDataDir);
  return [{ managerId: manager.id, version: donor?.version || null, ...(!donor ? { discoveryRequired: true } : {}),
    label: "KAG3 compatibility resources", requiresDownload: true, installOptions: { kag3Resources: 1 } }];
}

function saveDirectory(entry, context) {
  if (!entry.gameId || !context.userDataDir) throw new Error("Import this game before launching so saves have a stable directory.");
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id), "saves");
}

function assertCompatibleProject(data) {
  if (!data) throw new Error("KiriKiri startup.tjs or a runnable XP3 archive was not found.");
  if (data.protectedEntries && data.xp3ContentProfile !== "verified-plain-v1") throw new Error("Protected XP3 archives require unsupported game-specific filters.");
  if (data.unsafeRuntimeSavePath) throw new Error("This loose project's saveDataLocation writes into the runtime. It must use System.dataPath.");
  if (data.tjsVersion === "1" || data.kagVersion?.startsWith("2.")) {
    throw new Error("This project's TJS1/KAG2 generation is unsupported by KiriKiri SDL2.");
  }
}

async function registerRuntime(entry, payload, context) {
  const requested = payload?.version || context.runtimeSettings?.version;
  const version = requested && requested !== "auto" ? requested : selection(entry, context).version;
  let runtimePath = payload?.runtimePath || context.runtimeSettings?.runtimePath;
  if (!runtimePath) {
    const result = await getUiServices(context).dialog.showOpenDialog({
      title: `Select KiriKiri SDL2 ${version} macOS build`, properties: ["openFile", "openDirectory"]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    runtimePath = result.filePaths[0];
  }
  const installed = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath });
  entry.runtimeData = { ...entry.runtimeData, krkrsdl2: { ...entry.runtimeData?.krkrsdl2, version } };
  context.onRuntimeStateChange?.();
  return { ready: true, version: installed.version, upstreamRevision: installed.upstreamRevision, sha256: installed.sha256, provenance: "Local build identity supplied by user" };
}

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "krkrsdl2") return null;
  assertCompatibleProject(entry.moduleData);
  const configuredArgs = context.runtimeSettings?.args || [];
  if (!Array.isArray(configuredArgs)) throw new Error("KiriKiri options must be separate arguments beginning with '-'.");
  const extraArgs = [...configuredArgs, ...(context.gameArguments || [])];
  if (extraArgs.some(arg => typeof arg === "string" && /^-datapath(?:=|$)/i.test(arg))) throw new Error("The launcher manages KiriKiri's save directory; remove -datapath from extra arguments.");
  if (extraArgs.some(arg => typeof arg !== "string" || !arg.startsWith("-"))) throw new Error("KiriKiri options must be separate arguments beginning with '-'.");
  const selected = selection(entry, context);
  if (!selected.install) throw new Error(`${selected.reason} Install a compatible version in Runtimes.`);
  const prepared = prepareGame(entry, context, preparationInstall(entry, context, selected, true));
  const rootDir = prepared?.preparedRoot || entry.contentRootDir;
  const inputPath = prepared?.preparedRoot || entry.moduleData?.archivePath || rootDir;
  const detected = detectGame({ rootDir, inputPath, stat: fs.statSync(inputPath) });
  assertCompatibleProject(detected?.moduleData);
  const defaultSaveDir = saveDirectory(entry, context);
  const override = typeof entry.saveDirOverride === "string" ? entry.saveDirOverride.trim() : "";
  if (override && !path.isAbsolute(override)) throw new Error("Save directory override must be an absolute local path.");
  const saveDir = override || defaultSaveDir;
  fs.mkdirSync(saveDir, { recursive: true });
  entry.defaultSaveDir = defaultSaveDir;
  context.onEntryChange?.({ defaultSaveDir });
  return Native.launchLocalRuntime({
    runtimePath: selected.install.runtimePath, runtimeVersion: selected.version,
    upstreamRevision: selected.install.upstreamRevision, expectedSha256: selected.install.binarySha256,
    // The SDL2 port preserves a supplied datapath verbatim. KAG appends filenames
    // directly to System.dataPath, so the directory must retain its final slash.
    args: [...extraArgs, `-datapath=${saveDir}${path.sep}`, detected.moduleData.launchTarget], cwd: rootDir, context
  });
}

module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [manager, MsgTool], createManager, getRuntimeRequirements,
  ensureRuntime: async (entry, context) => {
    if (context.runtimeId !== "krkrsdl2") return null;
    const inputPath = entry.moduleData?.archivePath || entry.gamePath;
    const detected = detectGame({ rootDir: entry.contentRootDir, inputPath, stat: fs.statSync(inputPath) });
    assertCompatibleProject(detected?.moduleData);
    if (detected?.moduleData && (entry.moduleData?.kagVersion !== detected.moduleData.kagVersion ||
        JSON.stringify(entry.moduleData?.requiredNativeFeatures) !== JSON.stringify(detected.moduleData.requiredNativeFeatures) ||
        detected.moduleData.xp3ContentProfile && entry.moduleData?.xp3ContentProfile !== detected.moduleData.xp3ContentProfile)) {
      entry.moduleData = { ...entry.moduleData, ...detected.moduleData };
      context.onEntryChange?.({ moduleData: entry.moduleData });
    }
    const selected = selection(entry, context);
    if (selected.ready) return null;
    return { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}) };
  },
  prepareLaunch: (entry, context) => {
    if (context.runtimeId !== "krkrsdl2") return null;
    const selected = selection(entry, context);
    if (!selected.install) throw new Error(`${selected.reason} Install a compatible version in Runtimes.`);
    const prepared = prepareGame(entry, context, preparationInstall(entry, context, selected, true));
    if (prepared) {
      entry.moduleData = { ...entry.moduleData, preparedRoot: prepared.preparedRoot, preparationProfile: prepared.profile, preparationWarnings: prepared.warnings.join(" "),
        compatibility: prepared.warnings.join(" "),
        ...(prepared.kagVersion ? { kagVersion: prepared.kagVersion, detectedVersion: `KAG ${prepared.kagVersion}`, detectedVersionConfidence: "declared",
          detectedVersionSource: prepared.versionSource, engineGeneration: "KAG 3 on KiriKiri/TJS (host generation unknown)" } : {}) };
      context.onEntryChange?.({ moduleData: entry.moduleData });
    }
    return prepared;
  },
  normalizeRuntimeId: () => "krkrsdl2", launchRuntime,
  settingsActions: {
    listRuntimeVersions: (_payload, context) => runtimeVersionChoices(manifest, manager, context)
  },
  actions: {
    listRuntimeVersions: (_entry, _payload, context) => runtimeVersionChoices(manifest, manager, context),
    exportScripts: (entry, payload, context) => require("./tools").exportScripts(entry, payload, context),
    revealScripts: (entry, payload, context) => require("./tools").revealScripts(entry, payload, context),
    registerRuntime,
    runtimeStatus: (entry, _payload, context) => {
      const selected = selection(entry, context);
      return { ready: selected.ready, version: selected.version, runtimePath: selected.install?.runtimePath || null,
        upstreamRevision: selected.install?.upstreamRevision || manager.core.catalog.find(row => row.version === selected.version)?.upstreamRevision || null,
        sha256: selected.install?.sha256 || null, reason: selected.reason };
    }
  }
};
