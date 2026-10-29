const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const LoveRuntimeManager = require("./runtime/love-runtime-manager");
const RuntimeRegistration = require("../shared/runtime/custom-runtime");
const { selectRuntimeVersion } = require("../shared/runtime/version-choices");
const LuaSteam = require("./runtime/luasteam-runtime");
const LuaSteamConsumer = require("./runtime/luasteam-consumer");
const GameData = require("../shared/game-data");
const GraphicsInputs = require("../shared/runtime/native-graphics-inputs");
const Metadata = require("./metadata");
const Archive = require("./archive");
const SourceTools = require("./tools/source");
const LjdManager = require("./tools/ljd-manager");
const UnluacManager = require("./tools/unluac-manager");
const SevenZip = require("../shared/runtime/sevenzip");
const {
  normalizeLoveVersion,
  normalizeNightlyBuildKey
} = require("./version");

const LoveCore = LoveRuntimeManager.core;
const RUNTIME_ID = "love";
const NATIVE_RUNTIME_ID = "native";
const CHANNEL_STABLE = "stable";
const CHANNEL_NIGHTLY = "nightly";

function safeRm(filePath) {
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
  } catch {}
}

function ensureDir(filePath) {
  fs.mkdirSync(filePath, { recursive: true });
}

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existsDir(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function trimString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeChannel(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === CHANNEL_NIGHTLY) return CHANNEL_NIGHTLY;
  if (value === CHANNEL_STABLE) return CHANNEL_STABLE;
  return null;
}

function normalizeRuntimeId(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === NATIVE_RUNTIME_ID) return NATIVE_RUNTIME_ID;
  return RUNTIME_ID;
}

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

function updateRuntimeData(entry, runtimeId, patch) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  const current =
    runtimeData[runtimeId] && typeof runtimeData[runtimeId] === "object"
      ? runtimeData[runtimeId]
      : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length === 0) delete runtimeData[runtimeId];
  else runtimeData[runtimeId] = next;
  entry.runtimeData = { ...runtimeData };
}

function mergeEntry(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...incoming };
  if (existing.moduleData || incoming.moduleData) {
    merged.moduleData = {
      ...(existing.moduleData && typeof existing.moduleData === "object" ? existing.moduleData : {}),
      ...(incoming.moduleData && typeof incoming.moduleData === "object" ? incoming.moduleData : {})
    };
  }
  if (existing.runtimeData || incoming.runtimeData) {
    merged.runtimeData = {
      ...(existing.runtimeData && typeof existing.runtimeData === "object" ? existing.runtimeData : {}),
      ...(incoming.runtimeData && typeof incoming.runtimeData === "object" ? incoming.runtimeData : {})
    };
  }
  if (existing.runtimeSettings || incoming.runtimeSettings) {
    merged.runtimeSettings = {
      ...(existing.runtimeSettings && typeof existing.runtimeSettings === "object"
        ? existing.runtimeSettings
        : {}),
      ...(incoming.runtimeSettings && typeof incoming.runtimeSettings === "object"
        ? incoming.runtimeSettings
        : {})
    };
  }
  return Metadata.preserveName(existing, merged);
}

function resolveRuntimeData(entry) {
  const data = entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  const loveData = data[RUNTIME_ID];
  return loveData && typeof loveData === "object" ? loveData : {};
}

function resolveExplicitChannel(runtimeData) {
  return normalizeChannel(runtimeData.channel) ||
    (trimString(runtimeData.version) ? normalizeLoveVersion(runtimeData.version) ? CHANNEL_STABLE : CHANNEL_NIGHTLY : null);
}

function resolveModuleData(entry) {
  return entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
}

function resolveDetectVersion(entry) {
  const moduleData = resolveModuleData(entry);
  return trimString(moduleData.detectedVersion);
}

function resolveDetectedVersionNormalized(entry) {
  const moduleData = resolveModuleData(entry);
  return normalizeLoveVersion(moduleData.detectedVersionNormalized || moduleData.detectedVersion);
}

function resolveManagerSections(settings, userDataDir) {
  const state = LoveRuntimeManager.getState({
    settings: settings?.runtimes?.love,
    userDataDir
  });
  const sections = Array.isArray(state?.sections) ? state.sections : [];
  return {
    state,
    stable:
      sections.find(section => section.id === CHANNEL_STABLE) || {
        id: CHANNEL_STABLE,
        installed: [],
        catalog: { versions: [] }
      },
    nightly:
      sections.find(section => section.id === CHANNEL_NIGHTLY) || {
        id: CHANNEL_NIGHTLY,
        installed: [],
        catalog: { versions: [] }
      }
  };
}

function buildPromptKey(channel, version) {
  const resolvedChannel = normalizeChannel(channel) || CHANNEL_STABLE;
  const resolvedVersion = trimString(version) || "latest";
  return `${resolvedChannel}:${resolvedVersion}`;
}

function resolveChannelHint(entry, sections) {
  const runtimeData = resolveRuntimeData(entry);
  const explicitChannel = resolveExplicitChannel(runtimeData);
  if (explicitChannel) return explicitChannel;
  const detected = resolveDetectedVersionNormalized(entry);
  if (detected && Array.isArray(sections?.stable?.catalog?.versions)) {
    const hasStable = sections.stable.catalog.versions.some(version => normalizeLoveVersion(version) === detected);
    return hasStable ? CHANNEL_STABLE : sections.stable.catalog.status === "success" ? CHANNEL_NIGHTLY : CHANNEL_STABLE;
  }
  return CHANNEL_STABLE;
}

function resolveManagedRuntimeSelection(entry, { settings, userDataDir } = {}) {
  const sections = resolveManagerSections(settings, userDataDir);
  const original = resolveRuntimeData(entry), cfg = LoveRuntimeManager.normalizeSettings(settings?.runtimes?.love);
  const detected = resolveDetectedVersionNormalized(entry), gameChannel = resolveExplicitChannel(original);
  const nightlyMatch = !gameChannel && detected && !LoveCore.resolveInstalled({ userDataDir, channel: CHANNEL_STABLE, version: detected })
    ? LoveCore.findNightlyByBundleVersion({ userDataDir, version: detected }) : null;
  const channel = gameChannel || (nightlyMatch ? CHANNEL_NIGHTLY : null) || (detected ? resolveChannelHint(entry, sections) :
    cfg.stable.defaultVersion && !cfg.nightly.defaultVersion ? CHANNEL_STABLE : cfg.nightly.defaultVersion && !cfg.stable.defaultVersion ? CHANNEL_NIGHTLY : resolveChannelHint(entry, sections));
  const layer = selectRuntimeVersion({ manual: trimString(original.version),
    recommended: nightlyMatch?.version || (channel === CHANNEL_NIGHTLY ? null : detected),
    defaultVersion: cfg[channel]?.defaultVersion, fallback: sections[channel]?.defaultVersion });
  const version = layer.version;
  const install = version ? LoveCore.resolveInstalled({ userDataDir, channel, version }) : null;
  const source = layer.source === "manual" ? install ? "explicit-version" : "explicit-missing"
    : layer.source === "recommended" ? install ? "detected-version" : "missing" : "default";
  return { ready: Boolean(install), installed: Boolean(install), source, channel, resolvedChannel: channel,
    resolvedVersion: version, install, installChannel: channel, installVersion: version,
    requiredVersion: version, promptKey: buildPromptKey(channel, version) };
}

const resolveRuntimeSelection = RuntimeRegistration.createSelector(LoveRuntimeManager, resolveManagedRuntimeSelection, {
  context: ([entry, context = {}]) => ({ entry, ...context,
    options: { ...context.options, recommended: () => resolveDetectedVersionNormalized(entry) } }),
  result: selected => ({ ...selected, installed: selected.ready, channel: selected.sectionId,
    resolvedChannel: selected.sectionId, resolvedVersion: selected.version, requiredVersion: selected.version,
    installChannel: selected.sectionId, installVersion: selected.version,
    promptKey: buildPromptKey(selected.sectionId, selected.version) })
});

async function ensureRuntime(entry, context) {
  if (normalizeRuntimeId(context.runtimeId || entry.runtimeId || manifest.runtime.default) !== RUNTIME_ID) return null;
  const selection = resolveRuntimeSelection(entry, context);
  if (selection.reason) throw new Error(selection.reason);
  if (selection.ready && selection.install?.appPath) return null;
  const sections = resolveManagerSections(context.settings, context.userDataDir);
  const detected = normalizeLoveVersion(selection.requiredVersion);
  let channel = normalizeChannel(selection.installChannel || selection.resolvedChannel) || CHANNEL_STABLE;
  let version = trimString(selection.installVersion);
  const explicit = String(selection.source || "").startsWith("explicit");
  if (channel === CHANNEL_STABLE) {
    version = normalizeLoveVersion(version || detected || sections.stable.catalog?.versions?.[0]);
    const known = version && (sections.stable.catalog?.versions || []).some(candidate => normalizeLoveVersion(candidate) === version);
    if (version && !known && sections.stable.catalog?.status === "success") {
      if (explicit || resolveExplicitChannel(resolveRuntimeData(entry))) return { managerId: LoveRuntimeManager.id, version,
        installOptions: { sectionId: CHANNEL_STABLE } };
      channel = CHANNEL_NIGHTLY; version = null;
    } else if ((!version || !known) && !sections.stable.catalog?.versions?.length) {
      return { managerId: LoveRuntimeManager.id, version: null, discoveryRequired: true,
        installOptions: { sectionId: CHANNEL_STABLE } };
    }
  }
  if (channel === CHANNEL_NIGHTLY) {
    version = normalizeNightlyBuildKey(version || sections.nightly.catalog?.versions?.[0]);
    if ((!version || !(sections.nightly.catalog?.versions || []).includes(version)) && !sections.nightly.catalog?.versions?.length) {
      return { managerId: LoveRuntimeManager.id, version: null, discoveryRequired: true, latestOnly: !version,
        installOptions: { sectionId: CHANNEL_NIGHTLY } };
    }
    if (version && !(sections.nightly.catalog?.versions || []).includes(version)) return { managerId: LoveRuntimeManager.id, version,
      installOptions: { sectionId: CHANNEL_NIGHTLY } };
  }
  if (!version) return { managerId: LoveRuntimeManager.id, version: null, discoveryRequired: true, installOptions: { sectionId: channel } };
  if (LoveCore.resolveInstalled({ userDataDir: context.userDataDir, channel, version })?.appPath) return null;
  return { managerId: LoveRuntimeManager.id, version, installOptions: { sectionId: channel } };
}

function ensureAppImageState(entry, userDataDir) {
  const moduleData = resolveModuleData(entry);
  if (moduleData.sourceKind !== "appimage") return;
  const gameId = trimString(entry?.gameId);
  if (!userDataDir || !gameId) return;
  const extractRoot = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, manifest.id), "appimage");
  updateModuleData(entry, {
    appImageExtractRoot: extractRoot,
    appImageReady:
      moduleData.appImageReady === true && existsFile(path.join(extractRoot, moduleData.appImageLaunchRelativePath || ""))
  });
}

function ensureAppImageExtracted(entry, context) {
  const moduleData = resolveModuleData(entry);
  if (moduleData.sourceKind !== "appimage") return null;
  ensureAppImageState(entry, context.userDataDir);
  const refreshed = resolveModuleData(entry);
  const extractRoot = trimString(refreshed.appImageExtractRoot);
  const launchRelative = trimString(refreshed.appImageLaunchRelativePath);
  const launchPath = extractRoot && launchRelative ? path.join(extractRoot, launchRelative) : null;
  if (launchPath && existsFile(launchPath) && refreshed.appImageReady === true) {
    updateModuleData(entry, { launchTargetPath: launchPath });
    return launchPath;
  }
  const packagedPath = trimString(refreshed.packagedPath) || trimString(entry?.gamePath);
  if (!packagedPath || !existsFile(packagedPath)) {
    throw new Error("AppImage file not found.");
  }
  if (!extractRoot || !launchRelative) {
    throw new Error("AppImage extraction metadata is incomplete.");
  }
  safeRm(extractRoot);
  ensureDir(extractRoot);
  context.logger?.info?.(`[love] extracting AppImage ${packagedPath}`);
  return SevenZip.extractArchive(packagedPath, extractRoot).then(() => {
    const nextLaunchPath = path.join(extractRoot, launchRelative);
    if (!existsFile(nextLaunchPath)) {
      throw new Error("Extracted AppImage is missing the packaged LÖVE binary.");
    }
    updateModuleData(entry, {
      launchTargetPath: nextLaunchPath,
      appImageReady: true,
      appImageExtractedAt: Date.now()
    });
    return nextLaunchPath;
  });
}

async function resolveLaunchTarget(entry, context) {
  const moduleData = resolveModuleData(entry);
  const sourceKind = trimString(moduleData.sourceKind);
  if (sourceKind === "appimage") {
    return ensureAppImageExtracted(entry, context);
  }
  if (sourceKind === "app-bundle") {
    const embeddedLovePath = trimString(moduleData.embeddedLovePath);
    return embeddedLovePath && existsFile(embeddedLovePath) ? embeddedLovePath : null;
  }
  if (sourceKind === "love-archive") {
    const archivePath = trimString(moduleData.launchTargetPath) || trimString(entry?.gamePath);
    return archivePath && existsFile(archivePath) ? archivePath : null;
  }
  if (sourceKind === "source-dir") {
    const dirPath = trimString(moduleData.launchTargetPath) || trimString(entry?.gamePath);
    return dirPath && existsDir(dirPath) ? dirPath : null;
  }
  if (sourceKind === "windows-fused" || sourceKind === "linux-fused") {
    const packagedPath = trimString(moduleData.launchTargetPath || moduleData.packagedPath) || trimString(entry?.gamePath);
    return packagedPath && existsFile(packagedPath) ? packagedPath : null;
  }
  return trimString(entry?.gamePath);
}

function resolveNativeLaunchPath(entry) {
  const moduleData = resolveModuleData(entry);
  if (moduleData.sourceKind !== "app-bundle") return null;
  const nativeAppPath = trimString(entry?.nativeAppPath) || trimString(entry?.gamePath);
  return nativeAppPath && nativeAppPath.toLowerCase().endsWith(".app") ? nativeAppPath : null;
}

function buildMissingRuntimeMessage(selection) {
  const channel = normalizeChannel(selection?.installChannel || selection?.resolvedChannel);
  if (channel === CHANNEL_NIGHTLY) {
    const nightlyVersion = trimString(selection?.installVersion || selection?.resolvedVersion);
    const suffix = nightlyVersion ? ` ${nightlyVersion}` : "";
    return `Selected LÖVE nightly runtime${suffix} is not installed. Install it from Runtimes.`;
  }
  const requiredVersion = trimString(selection?.requiredVersion);
  const suffix = requiredVersion ? ` ${requiredVersion}` : "";
  return `Compatible LÖVE runtime${suffix} is not installed. Install it from Runtimes.`;
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = trimString(entry?.gameId);
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameModuleDir(userDataDir, gameId, manifest.id));
  return true;
}

function resolveGraphicsInputs(entry, context = {}) {
  const runtimeId = normalizeRuntimeId(context.runtimeId || entry.runtimeId || manifest.runtime.default);
  const selection = runtimeId === RUNTIME_ID ? resolveRuntimeSelection(entry, context) : null;
  const appPath = runtimeId === NATIVE_RUNTIME_ID ? resolveNativeLaunchPath(entry) : selection?.install?.appPath;
  if (!appPath) return null;
  return GraphicsInputs.withInputs({ moduleData: { executablePath: selection?.install?.executablePath || LoveCore.resolveExecutablePath(appPath) } }, {
    runtimeId: "native", declaredArchitecture: selection?.install?.requiresRosetta ? "x86_64" : undefined
  });
}

async function launchRuntime(runtimeId, entry, context) {
  if (normalizeRuntimeId(runtimeId) !== RUNTIME_ID) return null;
  const selection = resolveRuntimeSelection(entry, {
    settings: context.settings,
    userDataDir: context.userDataDir
  });
  if (!selection.install?.appPath) {
    throw new Error(buildMissingRuntimeMessage(selection));
  }
  const executablePath = selection.install.executablePath || LoveCore.resolveExecutablePath(selection.install.appPath);
  if (!executablePath) throw new Error("LÖVE runtime executable not found.");
  const sourceTarget = await resolveLaunchTarget(entry, context);
  if (!sourceTarget) throw new Error("LÖVE launch target was not found.");
  const cwd = existsDir(sourceTarget) ? sourceTarget : path.dirname(sourceTarget);
  const launchTarget = ["love-archive", "app-bundle", "windows-fused", "linux-fused"].includes(resolveModuleData(entry).sourceKind)
    ? await Archive.prepare(sourceTarget, entry, context) : sourceTarget;
  const steam = await LuaSteam.prepareLaunchEnvironment(entry, context, selection);
  context.logger?.info?.(`[love] launch ${executablePath} ${launchTarget}`);
  return context.spawnDetachedChecked(
    executablePath,
    [launchTarget, ...(context.gameArguments || [])],
    { cwd, ...(steam ? { env: steam.environment } : {}) },
    Boolean(selection.install.requiresRosetta)
  );
}

module.exports = {
  metadataSources: ["metadata.js", "archive.js", "../shared/runtime/zip.js"],
  resolveGameMetadata: Metadata.resolveGameMetadata,
  resolveGameIcon: Metadata.resolveGameIcon,
  id: manifest.id,
  manifest,
  runtimeManagers: [LoveRuntimeManager, LjdManager, UnluacManager],
  distributionSupplementals: require("./runtime/distribution-supplementals.json"),
  nativeHostDependencies: LuaSteam.nativeHostDependencies,
  detectGame,
  normalizeRuntimeId,
  mergeEntry,
  onImport: (entry, context) => {
    ensureAppImageState(entry, context?.userDataDir);
    LuaSteamConsumer.inspect(entry);
  },
  cleanupGameData,
  ensureRuntime,
  // The stable release the game's configuration names.
  runtimeRecommendation: entry => {
    const version = resolveDetectedVersionNormalized(entry);
    return version ? { version, sectionId: CHANNEL_STABLE } : null;
  },
  getRuntimeRequirements: (entry, context) => {
    if (normalizeRuntimeId(context.runtimeId || entry.runtimeId || manifest.runtime.default) !== RUNTIME_ID) return [];
    const required = LuaSteam.preflight(entry, context);
    if (required) {
      const selection = resolveRuntimeSelection(entry, context);
      if (selection.install?.appPath) LuaSteam.verifyHostLua(selection.install.appPath);
    }
    // The bridge is an immutable Included resource, so Play does not install it.
    return [];
  },
  filterRuntimeSupport: (entry, supported) => {
    const moduleData = resolveModuleData(entry);
    if (moduleData.sourceKind !== "app-bundle") {
      return supported.filter(runtimeId => runtimeId !== NATIVE_RUNTIME_ID);
    }
    return supported;
  },
  canLaunchRuntime: (runtimeId, entry) => {
    if (normalizeRuntimeId(runtimeId) === NATIVE_RUNTIME_ID) {
      return Boolean(resolveNativeLaunchPath(entry));
    }
    return true;
  },
  resolveNativeLaunchPath,
  resolveGraphicsInputs,
  launchRuntime,
  actions: {
    exportSource: (entry, payload, context) => SourceTools.exportSource(entry, payload, context, { resolveSource: resolveLaunchTarget }),
    revealSource: SourceTools.revealSource,
    runtimeStatus: (entry, _payload, context) => {
      ensureAppImageState(entry, context.userDataDir);
      const status = resolveRuntimeSelection(entry, {
        settings: context.settings,
        userDataDir: context.userDataDir
      });
      const moduleData = resolveModuleData(entry);
      const suppressed = Boolean(
        status.promptKey && trimString(moduleData.runtimePromptSuppressedFor) === status.promptKey
      );
      updateModuleData(entry, {
        resolvedChannel: status.resolvedChannel || status.installChannel || null
      });
      return {
        ready: status.ready || suppressed,
        installed: status.installed,
        suppressed,
        requiredVersion: status.requiredVersion || null,
        resolvedVersion: status.resolvedVersion || null,
        resolvedChannel: status.resolvedChannel || null,
        installChannel: status.installChannel || status.resolvedChannel || CHANNEL_STABLE,
        installVersion: status.installVersion || null,
        promptKey: status.promptKey,
        rosettaRequired: Boolean(status.install?.requiresRosetta),
        rosettaAvailable: LoveCore.isRosettaAvailable()
      };
    },
    suppressRuntimePrompt: (entry, payload) => {
      const status = payload?.status && typeof payload.status === "object" ? payload.status : {};
      const promptKey =
        trimString(status.promptKey) ||
        buildPromptKey(status.installChannel || status.resolvedChannel || CHANNEL_STABLE, status.requiredVersion || status.installVersion);
      updateModuleData(entry, {
        runtimePromptSuppressedFor: promptKey || null
      });
      return { suppressedFor: promptKey || null };
    },
    installRuntime: async (entry, payload, context) => {
      const status =
        payload?.status && typeof payload.status === "object"
          ? payload.status
          : module.exports.actions.runtimeStatus(entry, payload, context);
      const currentRuntimeData = resolveRuntimeData(entry);
      const explicitChannel = resolveExplicitChannel(currentRuntimeData);
      const explicitVersion = trimString(currentRuntimeData.version);
      const persistVersion = Boolean(trimString(payload?.version) || explicitVersion);
      let installChannel = normalizeChannel(payload?.channel || status.installChannel || status.resolvedChannel);
      if (!installChannel) installChannel = CHANNEL_STABLE;
      let installVersion = trimString(payload?.version || status.installVersion);
      const detectedRequiredVersion = normalizeLoveVersion(status.requiredVersion);

      if (installChannel === CHANNEL_STABLE && installVersion) {
        installVersion = normalizeLoveVersion(installVersion);
      }
      if (installChannel === CHANNEL_NIGHTLY && installVersion) {
        installVersion = normalizeNightlyBuildKey(installVersion);
      }

      let sections = resolveManagerSections(context.settings, context.userDataDir);

      if (installChannel === CHANNEL_STABLE) {
        let desiredVersion =
          installVersion ||
          detectedRequiredVersion ||
          LoveRuntimeManager.normalizeSettings(context.settings?.runtimes?.love).stable.defaultVersion || sections.stable.catalog?.versions?.[0];
        if (!desiredVersion) {
          if (!Array.isArray(sections.stable.catalog?.versions) || sections.stable.catalog.versions.length === 0) {
            await LoveRuntimeManager.refreshCatalog({
              logger: context.logger,
              force: true,
              sectionId: CHANNEL_STABLE
            });
            context.onRuntimeStateChange?.();
            sections = resolveManagerSections(context.settings, context.userDataDir);
          }
          desiredVersion = sections.stable.catalog?.versions?.[0] || null;
        }
        if (desiredVersion) {
          const existing = LoveCore.resolveInstalled({
            userDataDir: context.userDataDir,
            channel: CHANNEL_STABLE,
            version: desiredVersion
          });
          if (existing?.appPath) {
            if (persistVersion) updateRuntimeData(entry, RUNTIME_ID, {
              channel: CHANNEL_STABLE,
              version: existing.version
            });
            updateModuleData(entry, {
              resolvedChannel: CHANNEL_STABLE,
              runtimePromptSuppressedFor: null
            });
            return {
              channel: CHANNEL_STABLE,
              version: existing.version,
              alreadyInstalled: true
            };
          }

          const knownStable = Array.isArray(sections.stable.catalog?.versions)
            ? sections.stable.catalog.versions.some(version => normalizeLoveVersion(version) === desiredVersion)
            : false;
          if (!knownStable) {
            await LoveRuntimeManager.refreshCatalog({
              logger: context.logger,
              force: true,
              sectionId: CHANNEL_STABLE
            });
            context.onRuntimeStateChange?.();
            sections = resolveManagerSections(context.settings, context.userDataDir);
          }
          const refreshedStable = Array.isArray(sections.stable.catalog?.versions)
            ? sections.stable.catalog.versions.some(version => normalizeLoveVersion(version) === desiredVersion)
            : false;
          if (refreshedStable) {
            const installed = await LoveRuntimeManager.installRuntime({
              userDataDir: context.userDataDir,
              version: desiredVersion,
              logger: context.logger,
              downloads: context.downloads,
              sectionId: CHANNEL_STABLE
            });
            if (persistVersion) updateRuntimeData(entry, RUNTIME_ID, {
              channel: CHANNEL_STABLE,
              version: installed.version
            });
            updateModuleData(entry, {
              resolvedChannel: CHANNEL_STABLE,
              runtimePromptSuppressedFor: null
            });
            return {
              channel: CHANNEL_STABLE,
              version: installed.version
            };
          }
          const allowNightlyFallback =
            !explicitChannel &&
            !explicitVersion &&
            detectedRequiredVersion &&
            detectedRequiredVersion === desiredVersion;
          if (!allowNightlyFallback) {
            throw new Error(`LÖVE release v${desiredVersion} was not found.`);
          }
          installChannel = CHANNEL_NIGHTLY;
          installVersion = null;
        } else {
          throw new Error("No LÖVE releases are available.");
        }
      }

      let nightlyVersion =
        installVersion ||
        LoveRuntimeManager.normalizeSettings(context.settings?.runtimes?.love).nightly.defaultVersion ||
        sections.nightly.catalog?.versions?.[0] || null;
      if (!nightlyVersion) {
        await LoveRuntimeManager.refreshCatalog({
          logger: context.logger,
          force: true,
          sectionId: CHANNEL_NIGHTLY
        });
        context.onRuntimeStateChange?.();
        sections = resolveManagerSections(context.settings, context.userDataDir);
        nightlyVersion = sections.nightly.catalog?.versions?.[0] || null;
      }
      if (!nightlyVersion) {
        throw new Error("No LÖVE nightly versions are available to download.");
      }
      const existingNightly = LoveCore.resolveInstalled({
        userDataDir: context.userDataDir,
        channel: CHANNEL_NIGHTLY,
        version: nightlyVersion
      });
      const installedNightly =
        existingNightly?.appPath
          ? { ...existingNightly, alreadyInstalled: true }
          : await LoveRuntimeManager.installRuntime({
              userDataDir: context.userDataDir,
              version: nightlyVersion,
              logger: context.logger,
              downloads: context.downloads,
              sectionId: CHANNEL_NIGHTLY
            });
      if (persistVersion) updateRuntimeData(entry, RUNTIME_ID, {
        channel: CHANNEL_NIGHTLY,
        version: installedNightly.buildKey || installedNightly.version
      });
      updateModuleData(entry, {
        resolvedChannel: CHANNEL_NIGHTLY,
        runtimePromptSuppressedFor: null
      });
      return {
        channel: CHANNEL_NIGHTLY,
        version: installedNightly.buildKey || installedNightly.version,
        bundleVersionNormalized: installedNightly.bundleVersionNormalized || null,
        alreadyInstalled: Boolean(installedNightly.alreadyInstalled)
      };
    }
  }
};
