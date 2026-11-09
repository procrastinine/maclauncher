const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Native = require("../shared/runtime/local-native");
const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../shared/runtime/bundled-native");
const { getUiServices } = require("../shared/ui-services");
const { runtimeVersionChoices } = require("../shared/runtime/version-choices");
const { source, prepareReleaseInstall, releaseExecutable } = require("./catalog");
const Preparation = require("./prepare");
// A prepared result belongs to one Play context and is consumed by launch.
const preparedLaunches = new WeakMap();
const MsgTool = require("../shared/runtime/msg-tool");

function resourcePin(runtimeManager, userDataDir, version) {
  const state = runtimeManager.getState({ userDataDir });
  const available = new Set(state.catalog.installableVersions || []);
  return runtimeManager.core.listCatalog({ userDataDir }).find(pin =>
    pin.kag3Resources === 1 && available.has(pin.version) && (!version || pin.version === version));
}

function createManager(dependencies = {}) {
const runtimeManager = createPinnedNativeManager({
  id: "krkrsdl2",
    versionCompatibility: () => true, // KAG scripts share the interpreter; required native feature checks remain game-specific.
     label: "KiriKiri SDL2",
  projectBuilds: { projectId: "krkrsdl2", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true },
  sourceUrl: "https://github.com/krkrsdl2/krkrsdl2",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "krkrsdl2" }),
  upstream: source, prepareInstall: prepareReleaseInstall,
  resolveExecutable: releaseExecutable,
  dependencies
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
  const required = entry.moduleData?.requiredNativeFeatures || [];
  const selected = manager.resolveSelection(effective, context.settings, context.userDataDir,
    { compatible: pin => required.every(feature => pin?.nativeFeatures?.includes(feature)) });
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

function saveConfiguration(entry) {
  const { decode } = require("./script");
  const XP3 = require("./xp3");
  let archive;
  if (entry.moduleData?.archivePath) {
    try {
      // An unexamined patch may replace the configuration; keep that route direct.
      const selected = path.resolve(entry.moduleData.archivePath);
      if (fs.readdirSync(entry.contentRootDir).some(name => /\.xp3$/i.test(name) && path.resolve(entry.contentRootDir, name) !== selected)) return null;
      archive = XP3.inspectArchive(selected);
    } catch { return null; }
  }
  for (const relative of ["Config.tjs", "system/Config.tjs"]) {
    try {
      let bytes;
      if (archive) {
        const member = archive.members.get(relative.toLowerCase());
        if (!member || member.size > 512 * 1024) continue;
        bytes = XP3.readScript(archive, member, { allowPlainProtected: true });
      } else {
        const file = path.join(entry.contentRootDir, relative), stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 512 * 1024) continue;
        bytes = fs.readFileSync(file);
      }
      return decode(bytes).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    } catch {}
  }
  return null;
}

function resolveSaveIdentity(entry, context = {}) {
  const code = saveConfiguration(entry);
  if (!code) return null;
  const assignments = name => [...code.matchAll(new RegExp(`^[\\t ]*;?[\\t ]*(?:var[\\t ]+)?${name}\\s*=\\s*([^;\\r\\n]+)`, "gm"))].at(-1)?.[1]?.trim();
  const literal = value => value?.match(/^["']([^"'\\]*)["']$/)?.[1];
  const dataName = literal(assignments("dataName"));
  if (dataName == null || /[\\/]/.test(dataName)) return null;
  let args;
  try {
    args = [...(context.runtimeSettings?.args || entry.runtimeSettings?.krkrsdl2?.args ||
      context.settings?.modules?.kirikiri?.runtimeSettings?.krkrsdl2?.args || []),
      ...(context.gameArguments || require("../shared/runtime/launch-arguments").parse(entry.launchArguments || ""))];
  } catch { return null; }
  let argumentPath;
  for (let at = 0; at < args.length; at++) {
    if (/^-datapath=/i.test(args[at])) argumentPath = args[at].slice(args[at].indexOf("=") + 1);
    else if (/^-datapath$/i.test(args[at])) argumentPath = args[++at];
  }
  const selected = entry.saveDirOverride || argumentPath;
  if (selected && !path.isAbsolute(selected)) return null;
  const base = selected || path.join(os.homedir(), "Library", "Application Support", "krkrsdl2");
  // Archived KAG3 configuration is normalized by the existing compatibility adapter.
  const expression = Preparation.needsResources(entry) ? "System.dataPath" : assignments("saveDataLocation");
  const suffix = expression?.match(/^System\.dataPath\s*\+\s*["']([^"'\\]*)["']$/)?.[1];
  const adjustable = expression === "System.dataPath" || suffix != null;
  const effective = nativeBase => path.normalize(suffix != null ? nativeBase + path.sep + suffix.replace(/^[/\\]+/, "") : nativeBase);
  const rawDirectory = adjustable ? effective(base) : literal(expression);
  if (!rawDirectory || !path.isAbsolute(rawDirectory)) return null;
  const directory = path.normalize(rawDirectory);
  return {
    namespace: "kirikiri-kag-system-files", identity: JSON.stringify([directory, dataName]),
    directory, scope: "game", explicit: Boolean(selected), hostSubstitution: false,
    createPatch: adjustable && !argumentPath && !(suffix || "").split(/[\\/]/).includes("..") ? ({ gameId }) => {
      if (!/^[A-Za-z0-9_-]+$/.test(gameId || "")) return null;
      const saveDirOverride = path.join(os.homedir(), "Library", "Application Support", "krkrsdl2", gameId);
      const actual = effective(saveDirOverride);
      return { saveDirOverride, defaultSaveDir: actual, saveLocations: [{ directory: actual, label: "KiriKiri saves" }] };
    } : undefined
  };
}

function resolveSaveLocations(entry) {
  const override = typeof entry.saveDirOverride === "string" && path.isAbsolute(entry.saveDirOverride) ? path.normalize(entry.saveDirOverride) : null;
  const known = typeof entry.defaultSaveDir === "string" ? path.normalize(entry.defaultSaveDir) : null;
  const directory = override && known && (known === override || known.startsWith(override + path.sep)) ? known : override;
  return { primaryDirectory: directory, directories: directory ? [{ directory, label: "KiriKiri saves" }] : [] };
}

function preparationKey(entry, context, selected) {
  return JSON.stringify([context.userDataDir, entry.gameId, entry.contentRootDir, entry.moduleData?.archivePath,
    selected.version, selected.install.runtimePath, context.runtimeSettings?.args || [], context.gameArguments || []]);
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
  for (let at = 0; at < extraArgs.length; at++) {
    if (typeof extraArgs[at] !== "string" || !extraArgs[at].startsWith("-")) throw new Error("KiriKiri options must be separate arguments beginning with '-'.");
    if (/^-datapath$/i.test(extraArgs[at]) && typeof extraArgs[++at] !== "string") throw new Error("KiriKiri -datapath needs a path.");
  }
  const selected = selection(entry, context);
  if (!selected.install) throw new Error(`${selected.reason} Install a compatible version in Runtimes.`);
  const cached = preparedLaunches.get(context);
  preparedLaunches.delete(context);
  const prepared = cached?.key === preparationKey(entry, context, selected) ? cached.prepared
    : Preparation.prepareGame(entry, context, preparationInstall(entry, context, selected, true));
  const rootDir = prepared?.preparedRoot || entry.contentRootDir;
  const inputPath = prepared?.preparedRoot || entry.moduleData?.archivePath || rootDir;
  const detected = detectGame({ rootDir, inputPath, stat: fs.statSync(inputPath) });
  assertCompatibleProject(detected?.moduleData);
  const defaultSaveDir = resolveSaveLocations(entry).primaryDirectory;
  const override = typeof entry.saveDirOverride === "string" ? entry.saveDirOverride.trim() : "";
  if (override && !path.isAbsolute(override)) throw new Error("Save directory override must be an absolute local path.");
  if (override) fs.mkdirSync(override, { recursive: true });
  entry.defaultSaveDir = defaultSaveDir;
  context.onEntryChange?.({ defaultSaveDir });
  return Native.launchLocalRuntime({
    runtimePath: selected.install.runtimePath, runtimeVersion: selected.version,
    upstreamRevision: selected.install.upstreamRevision, expectedSha256: selected.install.binarySha256,
    // No override preserves the direct upstream route; a selected folder keeps
    // its final slash because KAG appends filenames to System.dataPath.
    args: [...extraArgs, ...(override ? [`-datapath=${override}${path.sep}`] : []), detected.moduleData.launchTarget], cwd: rootDir, context
  });
}

module.exports = {
  id: manifest.id, manifest, detectGame, resolveSaveLocations, resolveSaveIdentity, runtimeManagers: [manager, MsgTool], createManager, getRuntimeRequirements,
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
  prepareLaunch: async (entry, context) => {
    if (context.runtimeId !== "krkrsdl2") return null;
    const selected = selection(entry, context);
    if (!selected.install) throw new Error(`${selected.reason} Install a compatible version in Runtimes.`);
    if (Preparation.needsResources(entry)) await Preparation.ensureResources(context, preparationInstall(entry, context, selected) || selected.install);
    preparedLaunches.delete(context);
    const prepared = Preparation.prepareGame(entry, context, preparationInstall(entry, context, selected, true));
    preparedLaunches.set(context, { key: preparationKey(entry, context, selected), prepared });
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
