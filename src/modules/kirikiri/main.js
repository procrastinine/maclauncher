const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Native = require("../shared/runtime/local-native");
const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../shared/runtime/bundled-native");
const { getUiServices } = require("../shared/ui-services");
const GameData = require("../shared/game-data");
const { buildRuntime, buildManagedRuntime } = require("./build");
const { createCatalogDiscovery, prepareReleaseInstall } = require("./catalog");
const { prepareGame } = require("./prepare");

const manager = createPinnedNativeManager({
  id: "krkrsdl2", label: "KiriKiri SDL2",
  bundledExecution: "direct",
  recommendedVersion: "snapshot-124bdf8-macos-v3",
  sourceUrl: "https://github.com/krkrsdl2/krkrsdl2/tree/124bdf841f09e7ce02aa99b7b55791a0f7a900ff", buildRuntime: buildManagedRuntime,
  buildSourcePath: path.resolve(__dirname, "../../external/krkrsdl2"),
  buildHelpUrl: "https://github.com/krkrsdl2/krkrsdl2/blob/124bdf841f09e7ce02aa99b7b55791a0f7a900ff/README.md",
  bundledRuntime: createBundledNativeRuntime({ managerId: "krkrsdl2" }),
  discoverCatalog: createCatalogDiscovery(), prepareInstall: prepareReleaseInstall,
  resolveExecutable: (root, pin) => path.join(root, pin.executableRelative || "krkrsdl2"),
  catalog: [
    { version: "snapshot-124bdf8-macos-v3", upstreamRevision: "124bdf841f09e7ce02aa99b7b55791a0f7a900ff", buildProfile: "macos-storage-font-monitor-v3", overlayRevision: "macos-storage-font-monitor-v1", nativeFeatures: ["storage.dirlist", "system.addFont", "monitor.adjust"],
      sourceArtifact: { directoryRelative: "krkrsdl2/snapshot-124bdf8-macos-v3-source.tar.gz",
        sha256: "cff10bee4d38e70e8cb6ae80ecec1d1110834612e0f7879bebdd9fcc1d442316", bytes: 35969784 } },
    { version: "snapshot-124bdf8-macos-v2", upstreamRevision: "124bdf841f09e7ce02aa99b7b55791a0f7a900ff", buildProfile: "macos-full-presentation-v2" },
    { version: "snapshot-124bdf8", upstreamRevision: "124bdf841f09e7ce02aa99b7b55791a0f7a900ff" }
  ]
});
manager.distributionRequired = true;
manager.distributionVersions = ["snapshot-124bdf8-macos-v3"];

function selection(entry, context) {
  const configured = context.runtimeSettings?.version;
  const explicit = typeof configured === "string" && configured.trim() && configured !== "auto";
  const effective = explicit
    ? { ...entry, runtimeData: { ...entry.runtimeData, krkrsdl2: { ...entry.runtimeData?.krkrsdl2, version: configured.trim() } } } : entry;
  const selected = manager.resolveSelection(effective, context.settings, context.userDataDir);
  const required = entry.moduleData?.requiredNativeFeatures || [];
  const supports = version => required.every(feature => manager.core.catalog.find(pin => pin.version === version)?.nativeFeatures?.includes(feature));
  if (!required.length || supports(selected.version)) return selected;
  const compatible = manager.core.catalog.find(pin => supports(pin.version));
  if (explicit || entry.runtimeData?.krkrsdl2?.version || !compatible) throw new Error(`KiriKiri ${selected.version} lacks required native APIs.${compatible ? ` Select ${compatible.version} in Runtime Settings.` : ""}`);
  return manager.resolveSelection({ ...entry, runtimeData: { ...entry.runtimeData, krkrsdl2: { version: compatible.version } } }, context.settings, context.userDataDir);
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
  const prepared = prepareGame(entry, context);
  const rootDir = prepared?.preparedRoot || entry.contentRootDir;
  const inputPath = prepared?.preparedRoot || entry.moduleData?.archivePath || rootDir;
  const detected = detectGame({ rootDir, inputPath, stat: fs.statSync(inputPath) });
  assertCompatibleProject(detected?.moduleData);
  const selected = selection(entry, context);
  if (!selected.install) throw new Error(`${selected.reason} Select Automatic in Runtime Settings to use the included runtime.`);
  const defaultSaveDir = saveDirectory(entry, context);
  const override = typeof entry.saveDirOverride === "string" ? entry.saveDirOverride.trim() : "";
  if (override && !path.isAbsolute(override)) throw new Error("Save directory override must be an absolute local path.");
  const saveDir = override || defaultSaveDir;
  fs.mkdirSync(saveDir, { recursive: true });
  entry.defaultSaveDir = defaultSaveDir;
  context.onEntryChange?.({ defaultSaveDir });
  const extraArgs = context.runtimeSettings?.args || [];
  if (!Array.isArray(extraArgs) || extraArgs.some(arg => typeof arg !== "string" || !arg.startsWith("-"))) throw new Error("KiriKiri options must be separate arguments beginning with '-'.");
  if (extraArgs.some(arg => /^-datapath(?:=|$)/i.test(arg))) throw new Error("The launcher manages KiriKiri's save directory; remove -datapath from extra arguments.");
  return Native.launchLocalRuntime({
    runtimePath: selected.install.runtimePath, runtimeVersion: selected.version,
    upstreamRevision: selected.install.upstreamRevision, expectedSha256: selected.install.binarySha256,
    // The SDL2 port preserves a supplied datapath verbatim. KAG appends filenames
    // directly to System.dataPath, so the directory must retain its final slash.
    args: [...extraArgs, `-datapath=${saveDir}${path.sep}`, detected.moduleData.launchTarget], cwd: rootDir, context
  });
}

module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  ensureRuntime: async (entry, context) => {
    if (context.runtimeId !== "krkrsdl2") return null;
    const inputPath = entry.moduleData?.archivePath || entry.gamePath;
    const detected = detectGame({ rootDir: entry.contentRootDir, inputPath, stat: fs.statSync(inputPath) });
    assertCompatibleProject(detected?.moduleData);
    if (detected?.moduleData && (JSON.stringify(entry.moduleData?.requiredNativeFeatures) !== JSON.stringify(detected.moduleData.requiredNativeFeatures) ||
        detected.moduleData.xp3ContentProfile && entry.moduleData?.xp3ContentProfile !== detected.moduleData.xp3ContentProfile)) {
      entry.moduleData = { ...entry.moduleData, ...detected.moduleData };
      context.onEntryChange?.({ moduleData: entry.moduleData });
    }
    const selected = selection(entry, context);
    if (selected.ready) return null;
    if (!manager.core.catalog.some(row => row.version === selected.version)) throw new Error(selected.reason);
    return { managerId: manager.id, version: selected.version };
  },
  prepareLaunch: (entry, context) => {
    if (context.runtimeId !== "krkrsdl2") return null;
    const prepared = prepareGame(entry, context);
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
  actions: {
    exportScripts: (entry, payload, context) => require("./tools").exportScripts(entry, payload, context),
    revealScripts: (entry, payload, context) => require("./tools").revealScripts(entry, payload, context),
    buildRuntime: (entry, payload, context) => buildRuntime(manager, entry, payload, context),
    registerRuntime,
    runtimeStatus: (entry, _payload, context) => {
      const selected = selection(entry, context);
      return { ready: selected.ready, version: selected.version, runtimePath: selected.install?.runtimePath || null,
        upstreamRevision: selected.install?.upstreamRevision || manager.core.catalog.find(row => row.version === selected.version)?.upstreamRevision || null,
        sha256: selected.install?.sha256 || null, reason: selected.reason };
    }
  }
};
