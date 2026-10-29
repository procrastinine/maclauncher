const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Custom = require("../shared/runtime/custom-runtime");
const { selectRuntimeVersion } = require("../shared/runtime/version-choices");
const { getUiServices } = require("../shared/ui-services");
const manifest = require("./manifest.json");
const GameData = require("../shared/game-data");
const { detectGame, resolveRenpyVersion } = require("./detect");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  extractRenpyGame
} = require("./extract");
const { inspectRenpySave, listRenpySaves } = require("./save-inspect");
const { getDeveloperToolsStatus, installDeveloperTools, removeDeveloperTools } = require("./developer-tools");
const { resolveConfiguredSaveLocation } = require("./save-location");
const {
  resolveConfigValueFromRoots,
  resolveRenpyIconPath
} = require("./options");
const { runDownloadTask } = require("../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../shared/runtime/runtime-downloads");
const { confirmToolInstall } = require("../shared/runtime/tool-install");

const LegacySdkManager = require("./runtime/sdk-manager");
const PatchSdk = require("./runtime/patch-sdk");
const RuntimePatcher = require("./runtime/patcher");
const RuntimeSdk = require("./runtime/sdk");
const { launchScript } = require("../shared/runtime/launch-script");
const { ensureTranslation } = require("./runtime/translation");
const SdkRuntimeManager = require("./runtime/sdk-runtime-manager");
const Live2D = require("./live2d");
const SteamConsumer = require("./steam-consumer");
const Writable = require("../shared/writable-input");
const { prepareInput } = require("./writable-input");
const { readMachOArchitectures } = require("../shared/runtime/local-native");
const GraphicsInputs = require("../shared/runtime/native-graphics-inputs");
const { cheatsSchema, cheatsHelpers } = require("./cheats");

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

const URW_RESOURCE_DIR = path.join("universal-renpy-walkthrough", "__urw");
const URW_FILES = ["urw_core.rpy", "urw_processor.rpy", "urw_screens.rpy", "urw_updater.rpy", "urw_utils.rpy"];
const URW_LEGACY_FILES = ["_urw.rpy", "_urwdisp.rpy"];
const URM_FILE = "0x52_URM.rpa";
const EXTRACTED_OVERRIDE_FLAG = "extractedOverridesFromExtraction";
const WEBP_ICON_EXT = ".webp";

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

function normalizeRuntimeId(input, fallback = "sdk") {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  return raw || fallback;
}

function mergeEntry(existing, merged, settings, context) {
  // Refresh source-backed locations for older records, including records whose
  // blank default or title guess predates archive configuration inspection.
  resolveSaveLocations(merged, { settings, ...context });
  return merged;
}

function normalizeSdkVersion(version) {
  try { return SdkRuntimeManager.core.normalizeVersion(version); } catch {}
  const v = String(version || "").trim().replace(/^v/i, "");
  const match = v.match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function resolveVersion(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.version === "string" && moduleData.version.trim()) {
    return moduleData.version.trim();
  }
  return null;
}

// The SDK the game's own data recommends: the SDK that rebuilt it, otherwise
// its detected Ren'Py version.
function recommendedSdkVersion(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  return normalizeSdkVersion(
    typeof moduleData.builtSdkVersion === "string" ? moduleData.builtSdkVersion : resolveDetectedVersion(entry) || ""
  );
}

const resolveEntrySdkVersion = Custom.createSelector(SdkRuntimeManager, function managedSdkVersion(entry, settings, userDataDir) {
  const major = resolveMajor(entry), cfg = SdkRuntimeManager.normalizeSettings(settings?.runtimes?.sdk);
  return selectRuntimeVersion({ manual: normalizeSdkVersion(entry?.runtimeData?.sdk?.version ?? ""),
    recommended: recommendedSdkVersion(entry),
    defaultVersion: normalizeSdkVersion(cfg[major === 7 ? "v7" : "v8"]?.defaultVersion),
    fallback: SdkRuntimeManager.getState({ settings: settings?.runtimes?.sdk, userDataDir }).sections?.find(section => section.id === (major === 7 ? "v7" : "v8"))?.defaultVersion }).version;
}, { context: ([entry, settings, userDataDir]) => ({ entry: userDataDir ? entry : null, settings: userDataDir ? settings : null, userDataDir,
  options: { recommended: () => userDataDir ? recommendedSdkVersion(entry) : null } }), required: true,
  result: selection => selection.version });

function resolveDetectedVersion(entry) {
  const direct = resolveVersion(entry);
  if (direct) return direct;

  const contentRootDir = Writable.sourceRoot(entry);
  if (!contentRootDir) return null;
  return resolveRenpyVersion(contentRootDir);
}

function normalizeRenpyMajor(input) {
  const major = Number(input);
  if (!Number.isFinite(major)) return null;
  if (major >= 8) return 8;
  if (major >= 1) return 7;
  return null;
}

function resolveMajor(entry) {
  const override = normalizeRenpyMajor(entry?.runtimeData?.sdk?.major);
  if (override) return override;

  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const direct = normalizeRenpyMajor(moduleData.major);
  if (direct) return direct;

  const candidates = [resolveDetectedVersion(entry), normalizeSdkVersion(entry?.runtimeData?.sdk?.version), normalizeSdkVersion(moduleData.builtSdkVersion)];
  for (const version of candidates) {
    const match = version ? version.match(/^(\d+)\./) : null;
    const major = match ? Number(match[1]) : null;
    const normalized = normalizeRenpyMajor(major);
    if (normalized) return normalized;
  }

  return null;
}

function resolveBaseName(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.baseName === "string" && moduleData.baseName.trim()) {
    return moduleData.baseName.trim();
  }
  return null;
}

function resolveGameOnly(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  return moduleData.gameOnly === true;
}

function resolveContentRoot(entry) {
  return entry?.contentRootDir || entry?.gamePath || null;
}

function resolveGameDir(entry) {
  const root = resolveContentRoot(entry);
  if (!root) return null;
  return resolveGameOnly(entry) ? root : path.join(root, "game");
}

function patchedProjectVersion(entry) {
  return `patched-${normalizeSdkVersion(resolveDetectedVersion(entry)) || resolveMajor(entry)}`;
}

function resolveSaveLocations(entry, context = {}) {
  const input = context.userDataDir ? prepareInput(entry, { ...context, readOnly: true }) : Writable.runtimeEntry(entry);
  const root = Writable.sourceRoot(entry), gameDir = root ? resolveGameOnly(entry) ? root : path.join(root, "game") : null;
  if (!gameDir) return { primaryDirectory: null, directories: [], confidence: "unknown", source: null, error: "Game content directory is unavailable." };
  const runtimeId = context.runtimeId || entry.runtimeId || "sdk";
  const major = resolveMajor(entry);
  const sdk = runtimeId === "sdk" && major && context.userDataDir
    ? findInstalledSdk(context.userDataDir, major, resolveEntrySdkVersion(entry, context.settings, context.userDataDir)) : null;
  const sdkVersion = sdk?.version || resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
  let wrapper = runtimeId === "sdk" && sdkVersion && context.userDataDir && entry.gameId
    ? RuntimeSdk.resolveWrapperDir(context.userDataDir, entry.gameId, sdkVersion) : null;
  if (runtimeId === "patched" && context.userDataDir && entry.gameId) {
    const project = RuntimeSdk.resolveWrapperDir(context.userDataDir, entry.gameId, patchedProjectVersion(entry));
    if (SteamConsumer.hasPreparedBootstrap(project)) wrapper = project;
  }
  const privateRoot = entry.moduleData?.writableInput?.root;
  const runtimeGameDir = wrapper ? path.join(wrapper, "game") : privateRoot
    ? resolveGameOnly(entry) ? privateRoot : path.join(privateRoot, "game") : resolveGameDir(input);
  const extracted = entry.moduleData?.extractedReady && entry.moduleData?.extractedRoot && existsDir(entry.moduleData.extractedRoot)
    ? entry.moduleData.extractedRoot : null;
  const location = resolveConfiguredSaveLocation([extracted, gameDir].filter(Boolean), {
    gameDir: runtimeGameDir, renpyBaseDir: sdk?.installDir || (entry.moduleData?.writableInput?.ready ? privateRoot : root),
    isMacApp: runtimeId === "native" && String(entry.nativeAppPath || entry.gamePath).toLowerCase().endsWith(".app"),
    ...(context.homeDir ? { homeDir: context.homeDir } : {}),
    ...(context.env ? { env: context.env } : {})
  });
  if (privateRoot) {
    const remap = directory => typeof directory === "string" && (directory === root || directory.startsWith(root + path.sep))
      ? path.join(privateRoot, path.relative(root, directory)) : directory;
    location.directory = remap(location.directory);
    location.primaryDirectory = remap(location.primaryDirectory);
    location.directories = location.directories.map(item => ({ ...item, directory: remap(item.directory) }));
  }
  const originalSaves = path.join(gameDir, "saves");
  if (wrapper && !Writable.immutableRoot(entry) && existsDir(originalSaves) && !location.directories.some(item => item.directory === originalSaves)) {
    location.directories.push({ directory: originalSaves, role: "original", source: "Existing original game saves", confidence: "exact" });
  }
  entry.defaultSaveDir = location.primaryDirectory;
  updateModuleData(entry, { saveDirectorySource: location.source, saveDirectoryConfidence: location.confidence,
    saveDirectoryWarning: location.error, saveDirectories: location.directories, configuredSaveDirectory: location.name });
  return location;
}

function resolveCheatResourceFile(relPath) {
  const candidate = path.join(__dirname, "resources", relPath);
  return existsFile(candidate) ? candidate : null;
}

function resolveCheatResourceDir(relDir, files) {
  const isPackaged = Boolean(process.versions?.electron) && !process.defaultApp;
  const root = isPackaged
    ? process.resourcesPath && path.join(process.resourcesPath, "renpy-cheats")
    : path.join(__dirname, "resources");
  if (!root) return null;
  const candidate = path.join(root, relDir);
  return files.every(name => existsFile(path.join(candidate, name))) ? candidate : null;
}

function resolveCheatsGameDir(entry) {
  const gameDir = resolveGameDir(entry);
  if (!gameDir || !existsDir(gameDir)) throw new Error("Game directory missing.");
  return gameDir;
}

function getRenpyCheatsStatus(entry) {
  const gameDir = resolveGameDir(entry);
  if (!gameDir) {
    return { urwInstalled: false, urwPresent: false, urmInstalled: false, urmPresent: false };
  }
  const urwDir = path.join(gameDir, "__urw");
  const urwSourcePaths = URW_FILES.map(name => path.join(urwDir, name));
  const urwPaths = [];
  for (const name of [...URW_FILES, ...URW_LEGACY_FILES]) {
    const parsed = path.parse(name);
    const base = parsed.name;
    urwPaths.push(path.join(urwDir, name));
    urwPaths.push(path.join(urwDir, `${base}.rpyc`));
    urwPaths.push(path.join(urwDir, `${base}.rpyb`));
  }
  const urwFound = urwPaths.map(p => existsFile(p));
  const urwInstalled = urwSourcePaths.every(p => existsFile(p));
  const urwPresent = urwFound.some(Boolean);
  const urmPath = path.join(gameDir, URM_FILE);
  const urmPresent = existsFile(urmPath);
  return {
    ...getDeveloperToolsStatus(gameDir),
    urwInstalled,
    urwPresent,
    urmInstalled: urmPresent,
    urmPresent
  };
}

function installRenpyWalkthrough(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  const sourceDir = resolveCheatResourceDir(URW_RESOURCE_DIR, URW_FILES);
  if (!sourceDir) throw new Error("Universal Ren'Py Walkthrough System files not found.");
  const destDir = path.join(gameDir, "__urw");
  ensureDir(destDir);
  for (const name of URW_FILES) {
    let source = fs.readFileSync(path.join(sourceDir, name), "utf8");
    // Keep the vendor checkout pristine. Updates go through the launcher so
    // the upstream updater cannot bypass TLS or overwrite compatibility fixes.
    if (name === "urw_updater.rpy") {
      source = fs.readFileSync(path.join(__dirname, "overlays", "urw_updater.rpy"), "utf8");
    }
    fs.writeFileSync(path.join(destDir, name), source, "utf8");
  }
  // Old compiled scripts would otherwise run alongside v2 and duplicate hooks.
  for (const name of URW_LEGACY_FILES) {
    for (const ext of [".rpy", ".rpyc", ".rpyb"]) {
      safeRm(path.join(destDir, `${path.parse(name).name}${ext}`));
    }
  }
  return getRenpyCheatsStatus(entry);
}

function removeRenpyWalkthrough(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  const destDir = path.join(gameDir, "__urw");
  safeRm(destDir);
  return getRenpyCheatsStatus(entry);
}

function installRenpyMod(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  const sourcePath = resolveCheatResourceFile(URM_FILE);
  if (!sourcePath) throw new Error("Universal Ren'Py Mod file not found.");
  Writable.atomicCopy(sourcePath, path.join(gameDir, URM_FILE));
  return getRenpyCheatsStatus(entry);
}

function removeRenpyMod(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  safeRm(path.join(gameDir, URM_FILE));
  return getRenpyCheatsStatus(entry);
}

function isWebpIconPath(iconPath) {
  return path.extname(String(iconPath || "")).toLowerCase() === WEBP_ICON_EXT;
}

function resolvePngSiblingPath(iconPath) {
  const parsed = path.parse(String(iconPath || ""));
  if (!parsed.name) return null;
  return path.join(parsed.dir, `${parsed.name}.png`);
}

function convertIconToPng(sourcePath, outputPath, context) {
  if (!sourcePath || !outputPath) return null;
  const { nativeImage } = getUiServices(context);
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") return null;
  try {
    const img = nativeImage.createFromPath(sourcePath);
    if (!img || img.isEmpty()) return null;
    const png = img.toPNG();
    if (!png || png.length === 0) return null;
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, png);
    return outputPath;
  } catch {
    return null;
  }
}

function resolveIconCachePath(entry, userDataDir, iconPath) {
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) return null;
  const sourceExt = path.extname(String(iconPath || "")).toLowerCase();
  const ext = sourceExt === WEBP_ICON_EXT ? ".png" : sourceExt || ".png";
  const iconsRoot = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"), "icons");
  return path.join(iconsRoot, `window-icon${ext}`);
}

function cacheIconForEntry(entry, userDataDir, iconPath, context) {
  if (!iconPath || !userDataDir) return null;
  if (!existsFile(iconPath)) return null;
  const cachePath = resolveIconCachePath(entry, userDataDir, iconPath);
  if (!cachePath) return null;
  try {
    if (isWebpIconPath(iconPath)) {
      if (!convertIconToPng(iconPath, cachePath, context)) return null;
    } else if (path.resolve(iconPath) !== path.resolve(cachePath)) {
      ensureDir(path.dirname(cachePath));
      fs.copyFileSync(iconPath, cachePath);
    }
  } catch {
    return null;
  }
  updateModuleData(entry, { extractedIconPath: cachePath });
  entry.iconPath = cachePath;
  entry.iconSource = "module";
  return cachePath;
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = entry?.gameId;
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"));
  return true;
}

function resolveGameIcon(entry, context) {
  const root = Writable.sourceRoot(entry);
  if (!root) return null;
  const gameDir = resolveGameOnly(entry) ? root : path.join(root, "game");
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extracted = moduleData.extractedReady && existsDir(moduleData.extractedRoot) ? moduleData.extractedRoot : null;
  const nativeImage = context?.ui?.nativeImage || context?.nativeImage;
  const resolved = require("./icon").resolveRenpyIcon({ roots: [extracted, gameDir].filter(Boolean),
    userDataDir: context?.userDataDir, gameId: entry?.gameId,
    validateImage: bytes => !nativeImage?.createFromBuffer || !nativeImage.createFromBuffer(bytes).isEmpty() });
  if (resolved) {
    if (!isWebpIconPath(resolved.path)) return resolved.path;
    if (!context?.userDataDir) return resolved.path;
    const output = resolveIconCachePath(entry, context.userDataDir, resolved.path);
    try { if (output && existsFile(output) && fs.statSync(output).mtimeMs >= fs.statSync(resolved.path).mtimeMs) return output; } catch {}
    return output && convertIconToPng(resolved.path, output, context) || resolved.path;
  }
  const cachedIcon =
    typeof moduleData.extractedIconPath === "string" && moduleData.extractedIconPath.trim()
      ? moduleData.extractedIconPath.trim()
      : null;
  if (cachedIcon && existsFile(cachedIcon)) {
    if (!isWebpIconPath(cachedIcon)) return cachedIcon;
    const convertedPath = resolvePngSiblingPath(cachedIcon);
    if (convertedPath && existsFile(convertedPath)) return convertedPath;
    if (convertedPath) {
      const converted = convertIconToPng(cachedIcon, convertedPath, context);
      if (converted && existsFile(converted)) return converted;
    }
  }
  return null;
}

function isX64Platform(platform) {
  const p = String(platform || "");
  return p.includes("x86_64") || p.includes("x86-64");
}

function findInstalledSdk(userDataDir, major, version) {
  const installed = SdkRuntimeManager.core.listInstalled(userDataDir, major).filter(item => item.ready !== false);
  if (version) return installed.find(i => i.version === version) || null;
  return installed[0] || null;
}

async function ensureSdkAvailable({
  settings,
  userDataDir,
  major,
  version,
  allowInstall,
  logger,
  onState,
  downloads,
  consent
}) {
  const existing = findInstalledSdk(userDataDir, major, version);
  if (existing) return existing;
  if (!allowInstall) {
    const suffix = version ? ` v${version}` : "";
    throw new Error(`Ren'Py SDK${suffix} is not installed. Install it from Runtimes.`);
  }
  await confirmToolInstall(consent || {}, { managerId: "sdk", version, label: `Ren'Py SDK${version ? ` ${version}` : ""}`,
    installOptions: { major }, requiresDownload: true, detail: "Required to build the app bundle." });
  onState?.();
  const installed = await SdkRuntimeManager.installRuntime({
    userDataDir,
    major,
    version,
    logger,
    downloads
  });
  onState?.();
  return installed;
}

function resolvePatchVersion(entry) {
  const v = normalizeSdkVersion(resolveDetectedVersion(entry));
  return v || null;
}

function formatPatchStatusLabel(status) {
  if (!status) return null;
  if (status.patched) return "Patched";
  if (status.partial) return "Partial";
  return "Not patched";
}

function decoratePatchStatus(entry, status) {
  const renpyVersion =
    resolveDetectedVersion(entry) || status?.renpyVersion || status?.sdkVersion || null;
  return {
    ...status,
    renpyVersion,
    patchStatusLabel: formatPatchStatusLabel(status)
  };
}

function formatExtractStatusLabel(status) {
  if (!status) return null;
  return status.extractedReady ? "Extracted" : "Not extracted";
}

function decorateExtractionStatus(status) {
  return {
    ...status,
    extractStatusLabel: formatExtractStatusLabel(status)
  };
}

function applyPatchStatus(entry, status) {
  updateModuleData(entry, {
    patched: Boolean(status?.patched),
    partial: Boolean(status?.partial)
  });
}

function applyExtractionStatus(entry, status) {
  updateModuleData(entry, {
    extractedReady: Boolean(status?.extractedReady),
    extractedRoot: status?.extractedRoot || null,
    extractedAt: Number.isFinite(status?.extractedAt) ? status.extractedAt : null,
    extractionReportPath: status?.reportPath || null
  });
}

function applyExtractedOverrides(entry, { userDataDir, extractedRoot, gameDir }, context) {
  const extractedRoots = extractedRoot ? [extractedRoot] : [];
  const gameRoots = gameDir ? [gameDir] : [];
  if (extractedRoots.length === 0 && gameRoots.length === 0) return null;

  let usedExtracted = false;

  const saveLocation = resolveSaveLocations(entry, { ...context, userDataDir });
  if (saveLocation.found) {
    entry.defaultSaveDir = saveLocation.directory;
    updateModuleData(entry, { saveDirectorySource: saveLocation.source,
      saveDirectoryConfidence: saveLocation.confidence, saveDirectoryWarning: saveLocation.error });
    updateModuleData(entry, { saveDirectories: saveLocation.directories, configuredSaveDirectory: saveLocation.name });
    if (extractedRoots.some(root => saveLocation.source.startsWith(root + path.sep))) usedExtracted = true;
  }

  const extractedIconValue = extractedRoots.length
    ? resolveConfigValueFromRoots(extractedRoots, "window_icon")
    : null;
  let iconPath = extractedRoots.length
    ? resolveRenpyIconPath(extractedRoots, extractedIconValue)
    : null;
  if (iconPath) {
    usedExtracted = true;
  } else {
    const iconValue = resolveConfigValueFromRoots(gameRoots, "window_icon");
    iconPath = resolveRenpyIconPath(gameRoots, iconValue);
  }
  const cachedIcon = iconPath ? cacheIconForEntry(entry, userDataDir, iconPath, context) : null;
  if (usedExtracted) {
    updateModuleData(entry, { [EXTRACTED_OVERRIDE_FLAG]: true });
  }

  return {
    saveDirName: saveLocation.name || null,
    iconPath: cachedIcon || null
  };
}

async function ensurePatched(entry, { userDataDir, logger, allowDownload, downloads, consent } = {}) {
  if (resolveGameOnly(entry)) {
    throw new Error("Patching is not available for game-only imports.");
  }
  const contentRootDir = resolveContentRoot(entry);
  const major = resolveMajor(entry);
  const baseName = resolveBaseName(entry);
  if (!contentRootDir || !baseName) {
    throw new Error("Game metadata missing.");
  }

  const status = RuntimePatcher.buildPatchStatus({
    userDataDir,
    gameId: entry.gameId,
    gamePath: entry.gamePath,
    contentRootDir,
    renpyBaseName: baseName,
    renpyMajor: major
  });
  if (status.patched) return status;

  if (!major) throw new Error("Runtime version not detected.");
  const patchVersion = resolvePatchVersion(entry);
  if (!patchVersion) throw new Error("Runtime version is missing or unsupported for patching.");
  if (!allowDownload) {
    throw new Error("Game is not patched. Use Patch… to download runtime files.");
  }
  await confirmToolInstall(consent || {}, { managerId: "sdk", version: patchVersion, label: "Ren'Py patch SDK",
    installOptions: { sectionId: "patch" }, requiresDownload: true, detail: "Required to patch this game." });

  const sdk = await runDownloadTask(
    downloads,
    buildRuntimeDownloadMeta({
      label: "Ren'Py patch SDK",
      managerId: "sdk",
      sectionId: "patch",
      version: patchVersion
    }),
    ({ signal, onProgress }) =>
      PatchSdk.preparePatchSdk({
        version: patchVersion,
        logger,
        onProgress,
        signal
      })
  );
  try {
    return RuntimePatcher.patchGame({
      userDataDir,
      gameId: entry.gameId,
      gamePath: entry.gamePath,
      contentRootDir,
      renpyBaseName: baseName,
      renpyMajor: major,
      sdkInstallDir: sdk.sdkRoot,
      sdkVersion: sdk.sdkVersion,
      renpyVersion: resolveDetectedVersion(entry)
    });
  } finally {
    sdk.cleanup?.();
  }
}

function parseBuiltAt(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function applyBuildMeta(entry, build) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  moduleData.builtSdkVersion =
    build && typeof build.sdkVersion === "string" && build.sdkVersion.trim()
      ? build.sdkVersion.trim()
      : null;
  entry.moduleData = moduleData;
  entry.lastBuiltAt = build ? parseBuiltAt(build.builtAt) : null;
  if (!String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
    entry.nativeAppPath =
      build && typeof build.appPath === "string" && build.appPath.trim()
        ? build.appPath.trim()
        : null;
  }
}

function refreshBuildState(entry, userDataDir) {
  const meta = RuntimeSdk.pruneBuildsMeta(userDataDir, entry.gameId);
  const builds = Array.isArray(meta.builds) ? meta.builds : [];
  const latest = builds[0] || null;
  applyBuildMeta(entry, latest);
  return latest;
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => {
      stdout = (stdout + data.toString("utf8")).slice(-256 * 1024);
    });
    child.stderr.on("data", data => {
      stderr = (stderr + data.toString("utf8")).slice(-256 * 1024);
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (${code})`);
      err.stdout = stdout;
      err.stderr = stderr;
      err.exitCode = code;
      reject(err);
    });
  });
}

function resolveGraphicsInputs(entry, context = {}) {
  const runtimeId = normalizeRuntimeId(context.runtimeId || entry.runtimeId);
  let lib, executablePath, platform;
  if (runtimeId === "sdk") {
    const major = resolveMajor(entry), version = resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
    const install = findInstalledSdk(context.userDataDir, major, version);
    if (!install) return null;
    lib = RuntimePatcher.findMacLibDir(install.installDir, major);
    if (!lib) return null;
    executablePath = path.join(lib.dir, "renpy");
    platform = lib.platform;
  } else if (runtimeId === "patched") {
    entry = Writable.runtimeEntry(entry);
    const contentRootDir = resolveContentRoot(entry), baseName = resolveBaseName(entry);
    if (!contentRootDir || !baseName) return null;
    const status = RuntimePatcher.buildPatchStatus({ userDataDir: context.userDataDir, gameId: entry.gameId,
      gamePath: entry.gamePath, contentRootDir, renpyBaseName: baseName, renpyMajor: resolveMajor(entry) });
    if (!status.patched) return null;
    const directory = path.join(contentRootDir, "lib", status.macLibDir);
    executablePath = path.join(directory, existsFile(path.join(directory, baseName)) ? baseName : "renpy");
    platform = status.platform;
  } else return null;
  return GraphicsInputs.withInputs({ moduleData: { executablePath } }, {
    runtimeId: "native", declaredArchitecture: isX64Platform(platform) ? "x86_64" : undefined
  });
}

async function launchPatched(entry, context) {
  const status = await ensurePatched(entry, {
    userDataDir: context.userDataDir,
    logger: context.logger,
    allowDownload: false
  });

  const contentRootDir = resolveContentRoot(entry);
  const baseName = resolveBaseName(entry);
  const shPath = path.join(contentRootDir, `${baseName}.sh`);
  if (!fs.existsSync(shPath)) throw new Error("Launcher script not found.");

  const platform = status.platform || null;
  const needsRosetta = process.arch === "arm64" && isX64Platform(platform);
  let env = platform ? { ...process.env, RENPY_PLATFORM: platform } : process.env;

  await ensureTranslation({ dir: path.join(contentRootDir, "lib", status.macLibDir), platform }, context, baseName);
  const source = Writable.sourceEntry(entry);
  const consumer = SteamConsumer.inspectGameSteamConsumer({ gameRoot: source.contentRootDir || source.gamePath, gameDir: resolveGameDir(source) });
  let wrapperDir = null;
  if (consumer.required && env.RENPY_NO_STEAM === undefined) {
    const libDir = path.join(contentRootDir, "lib", status.macLibDir);
    const runtimeExecutable = fs.existsSync(path.join(libDir, baseName)) ? path.join(libDir, baseName) : path.join(libDir, "renpy");
    const architectures = readMachOArchitectures(runtimeExecutable);
    const arch = architectures.includes(process.arch) ? process.arch : "x86_64";
    wrapperDir = RuntimeSdk.ensureWrapper({ userDataDir: context.userDataDir, gameId: entry.gameId,
      gamePath: entry.gamePath, contentRootDir, sdkVersion: patchedProjectVersion(entry) });
    const steam = await SteamConsumer.prepareGameSteam({ consumer, gameRoot: source.contentRootDir || source.gamePath,
      python: path.join(libDir, "python"), runtimeExecutable, major: resolveMajor(entry), arch, wrapperDir, context, baseEnvironment: env });
    if (steam) env = steam.environment;
    else wrapperDir = null;
  } else if (context.userDataDir && entry.gameId) {
    const previous = RuntimeSdk.resolveWrapperDir(context.userDataDir, entry.gameId, patchedProjectVersion(entry));
    if (SteamConsumer.hasPreparedBootstrap(previous)) SteamConsumer.removeBootstrap(previous);
  }
  resolveSaveLocations(entry, { ...context, runtimeId: "patched" });
  context.logger?.info?.(`[runtime] launch patched ${shPath}`);
  return launchScript(shPath, [...(wrapperDir ? [wrapperDir, "run"] : []), ...(context.gameArguments || [])],
    { cwd: wrapperDir || contentRootDir, env }, needsRosetta, context);
}

async function launchSdk(entry, context) {
  const contentRootDir = resolveContentRoot(entry);
  if (!contentRootDir) throw new Error("Game directory missing.");

  const major = resolveMajor(entry);
  if (!major) throw new Error("Runtime version not detected.");

  const sdkVersion = resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
  const sdkInstall = await ensureSdkAvailable({
    settings: context.settings,
    userDataDir: context.userDataDir,
    major,
    version: sdkVersion,
    allowInstall: false,
    logger: context.logger,
    onState: context.onRuntimeStateChange,
    downloads: context.downloads
  });

  const wrapperDir = RuntimeSdk.ensureWrapper({
    userDataDir: context.userDataDir,
    gameId: entry.gameId,
    gamePath: entry.gamePath,
    contentRootDir,
    sdkVersion: sdkInstall.version
  });

  const renpySh = path.join(sdkInstall.installDir, "renpy.sh");
  if (!fs.existsSync(renpySh)) throw new Error("Ren'Py SDK missing launcher script.");

  const platform = RuntimeSdk.detectSdkPlatform(sdkInstall.installDir, major);
  const needsRosetta = process.arch === "arm64" && isX64Platform(platform);
  let env = platform ? { ...process.env, RENPY_PLATFORM: platform } : process.env;

  const libInfo = RuntimePatcher.findMacLibDir(sdkInstall.installDir, major);
  await ensureTranslation(libInfo, context);
  const source = Writable.sourceEntry(entry);
  const consumer = SteamConsumer.inspectGameSteamConsumer({ gameRoot: source.contentRootDir || source.gamePath, gameDir: resolveGameDir(source) });
  const runtimeExecutable = path.join(libInfo.dir, "renpy");
  const architectures = consumer.required ? readMachOArchitectures(runtimeExecutable) : [];
  const arch = architectures.includes(process.arch) ? process.arch : "x86_64";
  const steam = await SteamConsumer.prepareGameSteam({
    consumer,
    gameRoot: source.contentRootDir || source.gamePath, python: path.join(libInfo.dir, "python"), runtimeExecutable, major, arch,
    wrapperDir, context, baseEnvironment: env
  });
  if (steam) env = steam.environment;
  context.logger?.info?.(`[runtime] launch sdk ${renpySh} ${wrapperDir}`);
  return launchScript(renpySh, [wrapperDir, "run", ...(context.gameArguments || [])], { cwd: wrapperDir, env }, needsRosetta, context);
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  prepareInput,
  mergeEntry,
  resolveSaveLocations,
  normalizeRuntimeId,
  resolveGraphicsInputs,
  runtimeRecommendation: entry => {
    const version = recommendedSdkVersion(entry);
    return version && entry.runtimeId === "sdk" ? { version, sectionId: resolveMajor(entry) === 7 ? "v7" : "v8" } : null;
  },
  ensureRuntime: async (entry, context) => {
    if (context.runtimeId !== "sdk") return null;
    const major = resolveMajor(entry);
    if (!major) throw new Error("Ren'Py's major version is unknown. Choose Ren'Py 7 or 8 before installing an SDK.");
    const selected = resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
    if (findInstalledSdk(context.userDataDir, major, selected)) return null;
    let version = selected;
    if (!version) {
      const state = SdkRuntimeManager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.sdk });
      const catalog = state[major === 7 ? "v7" : "v8"]?.catalog;
      version = catalog?.latestStableVersion || catalog?.versions?.[0] || null;
      if (!version) return { managerId: "sdk", version: null, discoveryRequired: true,
        installOptions: { major, sectionId: major === 7 ? "v7" : "v8" } };
    }
    if (!version) throw new Error(`No Ren'Py ${major} SDK version is available.`);
    return { managerId: "sdk", version, installOptions: { major, sectionId: major === 7 ? "v7" : "v8" } };
  },
  prepareLaunch: async (entry, context) => {
    if (context.runtimeId !== "sdk") return null;
    const major = resolveMajor(entry), version = resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
    const install = findInstalledSdk(context.userDataDir, major, version);
    if (!install) throw new Error("Install the selected Ren'Py SDK first.");
    await context.useRuntime?.({ managerId: "sdk", version: install.version, sectionId: major === 7 ? "v7" : "v8", sourcePath: install.installDir });
    const models = Live2D.detectModels(resolveGameDir(entry));
    if (!models.detected) return models;
    return Live2D.ensureSdkLibrary(install, context);
  },
  resolveGameIcon,
  filterRuntimeSupport: (entry, supported) => {
    const isApp =
      String(entry?.gamePath || "").toLowerCase().endsWith(".app") ||
      String(entry?.nativeAppPath || "").toLowerCase().endsWith(".app");
    if (resolveGameOnly(entry)) return supported.filter(rt => rt === "sdk");
    if (isApp) return supported.filter(rt => rt !== "patched");
    return supported;
  },
  canLaunchRuntime: (runtimeId, entry) => {
    const root = resolveContentRoot(entry);
    if (!root) return false;
    const isApp =
      String(entry?.gamePath || "").toLowerCase().endsWith(".app") ||
      String(entry?.nativeAppPath || "").toLowerCase().endsWith(".app");
    if (runtimeId === "patched") {
      if (resolveGameOnly(entry)) return false;
      return !isApp;
    }
    if (runtimeId === "sdk") {
      return true;
    }
    return true;
  },
  resolveNativeLaunchPath: (entry, context) => {
    const userDataDir = context?.userDataDir;
    const direct = typeof entry?.nativeAppPath === "string" ? entry.nativeAppPath.trim() : "";
    if (direct && direct.toLowerCase().endsWith(".app")) return direct;
    try {
      const meta = RuntimeSdk.readBuildsMeta(userDataDir, entry.gameId);
      const build = Array.isArray(meta?.builds) ? meta.builds[0] : null;
      const appPath =
        build && typeof build.appPath === "string" && build.appPath ? build.appPath : null;
      if (appPath && appPath.toLowerCase().endsWith(".app")) return appPath;
    } catch {}
    const fallback = typeof context?.resolveNativeLaunchPath === "function"
      ? context.resolveNativeLaunchPath(entry)
      : null;
    return direct || fallback || null;
  },
  runtimeManagers: [SdkRuntimeManager],
  save: { extensions: ["save"], names: ["persistent"] },
  cheats: {
    schema: cheatsSchema,
    defaults: cheatsHelpers.defaults,
    normalize: cheatsHelpers.normalizeCheats,
    equals: cheatsHelpers.cheatsEqual
  },
  cleanupGameData,
  launchRuntime: (runtimeId, entry, context) => {
    entry = prepareInput(entry, context);
    if (runtimeId === "patched") return launchPatched(entry, context);
    if (runtimeId === "sdk") return launchSdk(entry, context);
    return null;
  },
  actions: {
    refreshSaveLocations: (entry, _payload, context) => resolveSaveLocations(entry, context),
    patchStatus: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Patching is not available for game-only imports.");
      }
      const contentRootDir = resolveContentRoot(entry);
      const baseName = resolveBaseName(entry);
      if (!contentRootDir || !baseName) throw new Error("Game metadata missing.");
      const status = RuntimePatcher.buildPatchStatus({
        userDataDir: context.userDataDir,
        gameId: entry.gameId,
        gamePath: entry.gamePath,
        contentRootDir,
        renpyBaseName: baseName,
        renpyMajor: resolveMajor(entry)
      });
      applyPatchStatus(entry, status);
      return decoratePatchStatus(entry, status);
    },
    patch: async (entry, _payload, context) => {
      const status = await ensurePatched(entry, {
        userDataDir: context.userDataDir,
        logger: context.logger,
        allowDownload: true,
        downloads: context.downloads,
        consent: context
      });
      applyPatchStatus(entry, status);
      return decoratePatchStatus(entry, status);
    },
    unpatch: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Patching is not available for game-only imports.");
      }
      const contentRootDir = resolveContentRoot(entry);
      const baseName = resolveBaseName(entry);
      if (!contentRootDir || !baseName) throw new Error("Game metadata missing.");
      const status = RuntimePatcher.unpatchGame({
        userDataDir: context.userDataDir,
        gameId: entry.gameId,
        gamePath: entry.gamePath,
        contentRootDir,
        renpyBaseName: baseName,
        renpyMajor: resolveMajor(entry)
      });
      applyPatchStatus(entry, status);
      return decoratePatchStatus(entry, status);
    },
    buildApp: async (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Packaging is not available for game-only imports.");
      }
      if (String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
        throw new Error("Packaging is disabled for imported app bundles.");
      }
      const contentRootDir = resolveContentRoot(entry);
      if (!contentRootDir) throw new Error("Game directory missing.");

      const major = resolveMajor(entry);
      if (!major) throw new Error("Runtime version not detected.");

      const sdkVersion = resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
      const sdkInstall = await ensureSdkAvailable({
        settings: context.settings,
        userDataDir: context.userDataDir,
        major,
        version: sdkVersion,
        allowInstall: true,
        logger: context.logger,
        onState: context.onRuntimeStateChange,
        downloads: context.downloads,
        consent: context
      });

      const existingBuilds = RuntimeSdk.pruneBuildsMeta(context.userDataDir, entry.gameId);
      if (Array.isArray(existingBuilds.builds) && existingBuilds.builds.length > 0) {
        throw new Error("App already built. Delete it before rebuilding.");
      }

      const platform = RuntimeSdk.detectSdkPlatform(sdkInstall.installDir, major);
      const needsRosetta = process.arch === "arm64" && isX64Platform(platform);
      await ensureTranslation(RuntimePatcher.findMacLibDir(sdkInstall.installDir, major), context);

      const res = await RuntimeSdk.buildMacApp({
        userDataDir: context.userDataDir,
        gameId: entry.gameId,
        gamePath: entry.gamePath,
        contentRootDir,
        sdkInstallDir: sdkInstall.installDir,
        sdkVersion: sdkInstall.version,
        platform,
        needsRosetta
      });

      applyBuildMeta(entry, { appPath: res.appPath, sdkVersion: sdkInstall.version, builtAt: new Date().toISOString() });
      return { appPath: res.appPath, sdkVersion: sdkInstall.version };
    },
    refreshBuild: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Builds are not available for game-only imports.");
      }
      refreshBuildState(entry, context.userDataDir);
      return true;
    },
    revealBuild: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Builds are not available for game-only imports.");
      }
      if (String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
        throw new Error("Imported app bundles cannot be revealed here.");
      }
      const latest = refreshBuildState(entry, context.userDataDir);
      const appPath = typeof latest?.appPath === "string" ? latest.appPath.trim() : "";
      const direct = typeof entry?.nativeAppPath === "string" ? entry.nativeAppPath.trim() : "";
      const target = appPath || direct;
      if (!target || !existsDir(target)) throw new Error("No build found.");
      getUiServices(context).shell.showItemInFolder(target);
      return { revealed: true };
    },
    deleteBuild: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Builds are not available for game-only imports.");
      }
      if (String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
        throw new Error("Imported app bundles cannot be deleted here.");
      }
      let deleted = false;
      for (;;) {
        const res = RuntimeSdk.deleteLatestBuild(context.userDataDir, entry.gameId);
        if (!res) break;
        if (!res.removed) {
          throw new Error("Refusing to delete build outside the build directory.");
        }
        deleted = true;
      }
      if (!deleted) throw new Error("No build found.");
      applyBuildMeta(entry, null);
      return true;
    },
    refreshExtractionStatus: (entry, _payload, context) => {
      const gameDir = resolveGameDir(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: gameDir || null
      });
      applyExtractionStatus(entry, status);
      if (status.extractedReady) {
        applyExtractedOverrides(entry, {
          userDataDir: context.userDataDir,
          extractedRoot: status.extractedRoot,
          gameDir
        }, context);
      }
      return decorateExtractionStatus(status);
    },
    extractGame: async (entry, payload, context) => {
      const gameDir = resolveGameDir(entry);
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      await extractRenpyGame({
        gameDir, extractRoot, userDataDir: context.userDataDir,
        renpyVersion: resolveDetectedVersion(entry),
        mode: payload?.mode ?? "auto", tryHarder: payload?.tryHarder ?? false,
        runCommand, logger: context.logger
      });

      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: gameDir
      });
      applyExtractionStatus(entry, status);
      if (status.extractedReady) {
        applyExtractedOverrides(entry, {
          userDataDir: context.userDataDir,
          extractedRoot: status.extractedRoot,
          gameDir
        }, context);
      }
      return decorateExtractionStatus(status);
    },
    revealExtraction: (entry, _payload, context) => {
      const gameDir = resolveGameDir(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: gameDir || null
      });
      if (!status.extractedRoot || !existsDir(status.extractedRoot)) {
        throw new Error("No extracted data found.");
      }
      getUiServices(context).shell.showItemInFolder(status.extractedRoot);
      return { revealed: true };
    },
    removeExtraction: (entry, _payload, context) => {
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      applyExtractionStatus(entry, { extractedReady: false, extractedRoot: null, extractedAt: null });
      return decorateExtractionStatus({ extractedReady: false, extractedRoot: null, extractedAt: null });
    },
    inspectSaveMetadata: (entry, payload, context) => {
      const location = resolveSaveLocations(entry, context);
      const directories = entry.saveDirOverride ? [entry.saveDirOverride] : location.directories.map(item => item.directory);
      const report = payload?.filePath
        ? { files: [{ ok: true, ...inspectRenpySave(payload.filePath) }], errors: [], count: 1, validCount: 1, saveEditing: false }
        : listRenpySaves(directories);
      report.detectedRenpyVersion = resolveDetectedVersion(entry);
      report.detectedVersionSource = entry.moduleData?.versionSource || null;
      report.detectedVersionConfidence = entry.moduleData?.versionConfidence || "unknown";
      report.configuredSdkVersion = resolveEntrySdkVersion(entry, context.settings, context.userDataDir);
      report.saveLocations = location.directories;
      const expectedVersion = report.configuredSdkVersion || normalizeSdkVersion(report.detectedRenpyVersion);
      report.versionWarnings = report.files.filter(file => {
        const savedVersion = typeof file.renpyVersion === "string" ? file.renpyVersion.match(/(\d+\.\d+\.\d+)/)?.[1] : null;
        return expectedVersion && savedVersion && savedVersion !== expectedVersion;
      }).map(file => ({ fileName: file.fileName, saveVersion: file.renpyVersion, expectedVersion,
        message: "Save was produced by a different Ren'Py version. Metadata inspection does not establish load compatibility." }));
      report.generatedAt = Date.now();
      if (context?.userDataDir && entry.gameId) {
        const root = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "renpy");
        ensureDir(root);
        const reportPath = path.join(root, "save-metadata.json");
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
        report.reportPath = reportPath;
        updateModuleData(entry, { saveMetadataReportPath: reportPath, inspectedSaveCount: report.count });
      }
      return report;
    },
    revealSaveMetadata: (entry, _payload, context) => {
      const root = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "renpy");
      const target = path.join(root, "save-metadata.json");
      if (!existsFile(target)) throw new Error("Inspect save metadata first.");
      getUiServices(context).shell.showItemInFolder(target);
      return { revealed: true };
    },
    installRenpyConsole: (entry, payload) => installDeveloperTools(resolveCheatsGameDir(entry), payload),
    live2DStatus: (entry, _payload, context) => Live2D.gameStatus(entry, context),
    patchLive2D: (entry, payload, context) => Live2D.patchGame(entry, payload, context),
    removeLive2D: (entry, payload, context) => Live2D.removeGame(entry, payload, context),
    removeRenpyConsole: entry => removeDeveloperTools(resolveCheatsGameDir(entry)),
    renpyCheatsStatus: (entry, _payload, _context) => getRenpyCheatsStatus(entry),
    patchRenpyWalkthrough: (entry, _payload, _context) => installRenpyWalkthrough(entry),
    removeRenpyWalkthrough: (entry, _payload, _context) => removeRenpyWalkthrough(entry),
    addRenpyMod: (entry, _payload, _context) => installRenpyMod(entry),
    removeRenpyMod: (entry, _payload, _context) => removeRenpyMod(entry)
  },
  runtime: {
    sdkManager: LegacySdkManager,
    patcher: RuntimePatcher,
    patchSdk: PatchSdk,
    sdk: RuntimeSdk
  }
};

const sourceActions = new Set(["refreshExtractionStatus", "extractGame", "revealExtraction", "removeExtraction", "inspectRenpyPickle"]);
for (const [id, action] of Object.entries(module.exports.actions)) {
  module.exports.actions[id] = (entry, payload, context = {}) =>
    Writable.runPrepared(entry, context, input => {
      const prepared = prepareInput(input, context);
      return sourceActions.has(id) ? Writable.sourceEntry(prepared) : prepared;
    }, input => action(input, payload, context));
}
