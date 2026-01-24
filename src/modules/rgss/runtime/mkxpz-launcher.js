const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const Assets = require("../assets");
const { ensureCheatsRuntime } = require("../cheats");
const MkxpzManager = require("./mkxpz-manager");
const { rgssVersionToNumber, rtpIdToRgssNumber } = require("../rgss-utils");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function resolveLogPaths(userDataDir, gamePath) {
  const logDir = path.join(userDataDir, "logs");
  ensureDir(logDir);
  const id = stableIdForPath(gamePath || "unknown");
  return {
    logDir,
    logPath: path.join(logDir, `rgss-mkxpz-${id}.log`),
    snapshotPath: path.join(logDir, `rgss-mkxpz-${id}.json`)
  };
}

function appendLogLine(logPath, line) {
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(logPath, `[${ts}] ${line}\n`);
  } catch {}
}

function safeWriteJson(filePath, payload) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

function normalizePathValue(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function normalizeListValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(entry => String(entry ?? "").trim())
      .filter(entry => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  }
  return [];
}

function normalizeNumber(value) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeInteger(value, { min = null, max = null } = {}) {
  const num = normalizeNumber(value);
  if (!Number.isFinite(num)) return null;
  let rounded = Math.round(num);
  if (Number.isFinite(min)) rounded = Math.max(min, rounded);
  if (Number.isFinite(max)) rounded = Math.min(max, rounded);
  return rounded;
}

function normalizeEnumNumber(value, allowed) {
  const num = normalizeInteger(value);
  if (num === null) return null;
  if (!Array.isArray(allowed) || allowed.length === 0) return num;
  return allowed.includes(num) ? num : null;
}

function normalizeTriState(value) {
  if (value === true || value === false) return value;
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "false" || raw === "off" || raw === "no") return false;
  return null;
}

function dedupeList(list) {
  const seen = new Set();
  return list.filter(entry => {
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

function resolvePathCandidate(label, candidate, { allowFiles = true, allowDirs = true, baseDir, logger } = {}) {
  if (!candidate) return null;
  const raw = String(candidate);
  const isAbsolute = path.isAbsolute(raw);
  const checkPath = !isAbsolute && baseDir ? path.join(baseDir, raw) : raw;
  const stat = safeStat(checkPath);
  if (!stat) {
    if (isAbsolute) {
      logger?.warn?.(`[mkxpz] ${label} missing`, raw);
      return null;
    }
    return raw;
  }
  if (stat.isFile() && !allowFiles) {
    logger?.warn?.(`[mkxpz] ${label} expects a directory`, raw);
    return null;
  }
  if (stat.isDirectory() && !allowDirs) {
    logger?.warn?.(`[mkxpz] ${label} expects a file`, raw);
    return null;
  }
  return raw;
}

function resolvePathList(label, input, { allowFiles = true, allowDirs = true, baseDir, logger } = {}) {
  const values = normalizeListValue(input);
  const out = [];
  for (const value of values) {
    const resolved = resolvePathCandidate(label, value, { allowFiles, allowDirs, baseDir, logger });
    if (resolved) out.push(resolved);
  }
  return dedupeList(out);
}

function resolveRuntimeConfig(managerSettings, runtimeData) {
  const cfg = MkxpzManager.normalizeSettings(managerSettings);
  const data = runtimeData && typeof runtimeData === "object" ? runtimeData : {};
  const version =
    typeof data.version === "string" && data.version.trim()
      ? data.version.trim()
      : cfg.defaultVersion;
  return { version: version || cfg.defaultVersion };
}

function resolveInstalledRuntime(userDataDir, version) {
  const list = MkxpzManager.core.listInstalled(userDataDir);
  return list.find(entry => entry.version === version) || null;
}

function ensureRuntimeInstalled({ userDataDir, version }) {
  const installed = resolveInstalledRuntime(userDataDir, version);
  if (installed) {
    const bundled = MkxpzManager.core.resolveBundledRuntime();
    if (bundled && installed.version === bundled.version) {
      const installedRoot = installed.installDir ? path.resolve(installed.installDir) : "";
      const bundledRoot = bundled.installDir ? path.resolve(bundled.installDir) : "";
      if (installedRoot && bundledRoot && installedRoot === bundledRoot) {
        return MkxpzManager.core.installBundledRuntime({ userDataDir, bundled });
      }
    }
    return installed;
  }
  const suffix = version ? ` v${version}` : "";
  throw new Error(`MKXP-Z runtime${suffix} is not installed. Install it from Runtimes.`);
}

function resolveExecutablePath(appPath) {
  const name = path.basename(appPath, ".app");
  return path.join(appPath, "Contents", "MacOS", name);
}

function resolveConfigPath(appPath) {
  return path.join(appPath, "Contents", "Game", "mkxp.json");
}

function normalizeScaling(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(0, Math.min(4, Math.round(num)));
  return clamped;
}

function resolveRtpPaths({ rtpMode, manualPath, stagedPath, baseDir, logger }) {
  const paths = [];
  const candidate = rtpMode === "manual" ? manualPath : stagedPath;
  if (!candidate) return paths;
  const resolved = resolvePathCandidate("RTP path", candidate, {
    allowFiles: true,
    allowDirs: true,
    baseDir,
    logger
  });
  if (resolved) paths.push(resolved);
  return paths;
}

function resolveFilePath(label, candidate, logger, baseDir) {
  return resolvePathCandidate(label, candidate, {
    allowFiles: true,
    allowDirs: false,
    baseDir,
    logger
  });
}

function buildMkxpConfig({ entry, userDataDir, runtimeSettings, logger }) {
  const gameFolder = entry?.contentRootDir || entry?.gamePath || null;
  if (!gameFolder) throw new Error("Game folder missing.");

  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const rtpId = moduleData.rtpId;
  let detectedRgssVersion = rgssVersionToNumber(moduleData.rgssVersion);
  if (!detectedRgssVersion && rtpId) {
    const fallback = rtpIdToRgssNumber(rtpId);
    if (fallback) {
      detectedRgssVersion = fallback;
      logger?.info?.(`[mkxpz] rgssVersion fallback from RTP ${rtpId}: ${fallback}`);
    }
  }

  const rgssMode = runtimeSettings?.rgssVersion;
  let rgssVersion = null;
  if (rgssMode === "auto") {
    rgssVersion = 0;
  } else if (rgssMode && rgssMode !== "detected") {
    const parsed = normalizeEnumNumber(rgssMode, [1, 2, 3]);
    if (parsed !== null) rgssVersion = parsed;
  }
  if (rgssVersion === null) {
    if (detectedRgssVersion) {
      rgssVersion = detectedRgssVersion;
    } else {
      rgssVersion = 0;
      if (rgssMode !== "auto") {
        logger?.warn?.("[mkxpz] rgssVersion unresolved; defaulting to MKXP-Z auto-detect");
      }
    }
  }

  const execOverride = normalizePathValue(runtimeSettings?.execName);
  const execName =
    execOverride ||
    (typeof moduleData.execName === "string" && moduleData.execName.trim()
      ? moduleData.execName.trim()
      : "Game");

  const staged = Assets.resolveStagedPaths(userDataDir, moduleData.rtpId);
  const rtpMode = runtimeSettings?.rtpMode === "manual" ? "manual" : "auto";
  const manualRtp = normalizePathValue(runtimeSettings?.rtpPath);
  const rtpPaths = resolveRtpPaths({
    rtpMode,
    manualPath: manualRtp,
    stagedPath: staged.rtpPath,
    baseDir: gameFolder,
    logger
  });
  const extraRtpPaths = resolvePathList("RTP path", runtimeSettings?.extraRtpPaths, {
    allowFiles: true,
    allowDirs: true,
    baseDir: gameFolder,
    logger
  });
  const allRtpPaths = dedupeList([...rtpPaths, ...extraRtpPaths]);
  if (allRtpPaths.length === 0) {
    logger?.warn?.("[mkxpz] RTP not configured; game may rely on RTP assets");
  }

  const soundfontPath = resolveFilePath(
    "soundfont",
    normalizePathValue(runtimeSettings?.soundfontPath) || staged.soundfontPath,
    logger,
    gameFolder
  );
  const kawarikiPath = resolveFilePath(
    "Kawariki preload",
    normalizePathValue(runtimeSettings?.kawarikiPath) || staged.kawarikiPreload,
    logger,
    gameFolder
  );
  if (!kawarikiPath) {
    logger?.warn?.("[mkxpz] Kawariki preload missing; patches and compatibility fixes may be skipped");
  }

  const extraPreloadScripts = resolvePathList(
    "preload script",
    runtimeSettings?.extraPreloadScripts,
    {
      allowFiles: true,
      allowDirs: false,
      baseDir: gameFolder,
      logger
    }
  );
  const preloadScripts = dedupeList([
    ...(kawarikiPath ? [kawarikiPath] : []),
    ...extraPreloadScripts
  ]);
  const postloadScripts = resolvePathList(
    "postload script",
    runtimeSettings?.postloadScripts,
    {
      allowFiles: true,
      allowDirs: false,
      baseDir: gameFolder,
      logger
    }
  );
  const patches = resolvePathList("patch", runtimeSettings?.patches, {
    allowFiles: true,
    allowDirs: true,
    baseDir: gameFolder,
    logger
  });

  const config = {
    gameFolder,
    rgssVersion,
    execName,
    displayFPS: Boolean(runtimeSettings?.displayFPS),
    printFPS: Boolean(runtimeSettings?.printFPS),
    winResizable: Boolean(runtimeSettings?.winResizable),
    fullscreen: Boolean(runtimeSettings?.fullscreen),
    fixedAspectRatio: Boolean(runtimeSettings?.fixedAspectRatio),
    vsync: Boolean(runtimeSettings?.vsync),
    frameSkip: Boolean(runtimeSettings?.frameSkip),
    syncToRefreshrate: Boolean(runtimeSettings?.syncToRefreshrate),
    integerScalingActive: Boolean(runtimeSettings?.integerScalingActive),
    integerScalingLastMile: Boolean(runtimeSettings?.integerScalingLastMile),
    anyAltToggleFS: Boolean(runtimeSettings?.anyAltToggleFS),
    enableReset: Boolean(runtimeSettings?.enableReset),
    enableSettings: Boolean(runtimeSettings?.enableSettings),
    allowSymlinks: Boolean(runtimeSettings?.allowSymlinks),
    pathCache: Boolean(runtimeSettings?.pathCache),
    useScriptNames: Boolean(runtimeSettings?.useScriptNames),
    enableHires: Boolean(runtimeSettings?.enableHires),
    subImageFix: Boolean(runtimeSettings?.subImageFix),
    dumpAtlas: Boolean(runtimeSettings?.dumpAtlas),
    midiChorus: Boolean(runtimeSettings?.midiChorus),
    midiReverb: Boolean(runtimeSettings?.midiReverb),
    fontKerning: Boolean(runtimeSettings?.fontKerning),
    fontOutlineCrop: Boolean(runtimeSettings?.fontOutlineCrop),
    JITEnable: Boolean(runtimeSettings?.JITEnable),
    YJITEnable: Boolean(runtimeSettings?.YJITEnable)
  };

  const smoothScaling = normalizeScaling(runtimeSettings?.smoothScaling);
  if (smoothScaling !== null) config.smoothScaling = smoothScaling;
  const smoothScalingDown = normalizeScaling(runtimeSettings?.smoothScalingDown);
  if (smoothScalingDown !== null) config.smoothScalingDown = smoothScalingDown;
  const bitmapSmoothScaling = normalizeScaling(runtimeSettings?.bitmapSmoothScaling);
  if (bitmapSmoothScaling !== null) config.bitmapSmoothScaling = bitmapSmoothScaling;
  const bitmapSmoothScalingDown = normalizeScaling(runtimeSettings?.bitmapSmoothScalingDown);
  if (bitmapSmoothScalingDown !== null) config.bitmapSmoothScalingDown = bitmapSmoothScalingDown;

  if (Boolean(runtimeSettings?.smoothScalingMipmaps)) config.smoothScalingMipmaps = true;

  const bicubicSharpness = normalizeInteger(runtimeSettings?.bicubicSharpness);
  if (bicubicSharpness !== null) config.bicubicSharpness = bicubicSharpness;
  const xbrzScalingFactor = normalizeNumber(runtimeSettings?.xbrzScalingFactor);
  if (xbrzScalingFactor !== null) config.xbrzScalingFactor = xbrzScalingFactor;

  const textureScalingFactor = normalizeNumber(runtimeSettings?.textureScalingFactor);
  if (textureScalingFactor !== null) config.textureScalingFactor = textureScalingFactor;
  const framebufferScalingFactor = normalizeNumber(runtimeSettings?.framebufferScalingFactor);
  if (framebufferScalingFactor !== null) config.framebufferScalingFactor = framebufferScalingFactor;
  const atlasScalingFactor = normalizeNumber(runtimeSettings?.atlasScalingFactor);
  if (atlasScalingFactor !== null) config.atlasScalingFactor = atlasScalingFactor;

  const defScreenW = normalizeInteger(runtimeSettings?.defScreenW, { min: 0 });
  if (defScreenW !== null) config.defScreenW = defScreenW;
  const defScreenH = normalizeInteger(runtimeSettings?.defScreenH, { min: 0 });
  if (defScreenH !== null) config.defScreenH = defScreenH;

  const fixedFramerate = normalizeInteger(runtimeSettings?.fixedFramerate, { min: 0 });
  if (fixedFramerate !== null) config.fixedFramerate = fixedFramerate;

  const maxTextureSize = normalizeInteger(runtimeSettings?.maxTextureSize, { min: 0 });
  if (maxTextureSize !== null) config.maxTextureSize = maxTextureSize;

  const seSourceCount = normalizeInteger(runtimeSettings?.SESourceCount, { min: 0 });
  if (seSourceCount !== null) config.SESourceCount = seSourceCount;
  const bgmTrackCount = normalizeInteger(runtimeSettings?.BGMTrackCount, { min: 0 });
  if (bgmTrackCount !== null) config.BGMTrackCount = bgmTrackCount;

  const jitVerboseLevel = normalizeInteger(runtimeSettings?.JITVerboseLevel, { min: 0 });
  if (jitVerboseLevel !== null) config.JITVerboseLevel = jitVerboseLevel;
  const jitMaxCache = normalizeInteger(runtimeSettings?.JITMaxCache, { min: 0 });
  if (jitMaxCache !== null) config.JITMaxCache = jitMaxCache;
  const jitMinCalls = normalizeInteger(runtimeSettings?.JITMinCalls, { min: 0 });
  if (jitMinCalls !== null) config.JITMinCalls = jitMinCalls;

  const fontScale = normalizeNumber(runtimeSettings?.fontScale);
  if (fontScale !== null) config.fontScale = fontScale;
  const fontHinting = normalizeEnumNumber(runtimeSettings?.fontHinting, [0, 1, 2, 3]);
  if (fontHinting !== null) config.fontHinting = fontHinting;
  const fontHeightReporting = normalizeEnumNumber(runtimeSettings?.fontHeightReporting, [0, 1]);
  if (fontHeightReporting !== null) config.fontHeightReporting = fontHeightReporting;

  const preferMetalRenderer = normalizeTriState(runtimeSettings?.preferMetalRenderer);
  if (preferMetalRenderer !== null) config.preferMetalRenderer = preferMetalRenderer;
  const enableBlitting = normalizeTriState(runtimeSettings?.enableBlitting);
  if (enableBlitting !== null) config.enableBlitting = enableBlitting;

  const windowTitle = normalizePathValue(runtimeSettings?.windowTitle);
  if (windowTitle) config.windowTitle = windowTitle;
  const dataPathOrg = normalizePathValue(runtimeSettings?.dataPathOrg);
  if (dataPathOrg) config.dataPathOrg = dataPathOrg;
  const dataPathApp = normalizePathValue(runtimeSettings?.dataPathApp);
  if (dataPathApp) config.dataPathApp = dataPathApp;
  const iconPath = resolveFilePath(
    "icon",
    normalizePathValue(runtimeSettings?.iconPath),
    logger,
    gameFolder
  );
  if (iconPath) config.iconPath = iconPath;
  const customScript = resolveFilePath(
    "custom script",
    normalizePathValue(runtimeSettings?.customScript),
    logger,
    gameFolder
  );
  if (customScript) config.customScript = customScript;

  const solidFonts = normalizeListValue(runtimeSettings?.solidFonts);
  if (solidFonts.length > 0) config.solidFonts = solidFonts;
  const fontSub = normalizeListValue(runtimeSettings?.fontSub);
  if (fontSub.length > 0) config.fontSub = fontSub;
  const rubyLoadpath = normalizeListValue(runtimeSettings?.rubyLoadpath);
  if (rubyLoadpath.length > 0) config.rubyLoadpath = rubyLoadpath;

  if (allRtpPaths.length > 0) config.RTP = allRtpPaths;
  if (soundfontPath) config.midiSoundFont = soundfontPath;
  if (preloadScripts.length > 0) config.preloadScript = preloadScripts;
  if (postloadScripts.length > 0) config.postloadScript = postloadScripts;
  if (patches.length > 0) config.patches = patches;

  return config;
}

async function launchRuntime({
  entry,
  userDataDir,
  settings,
  runtimeSettings,
  logger,
  spawnDetachedChecked,
  cheatsFilePath
}) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.mkxpz : null;
  const managerSettings =
    settings?.runtimes && typeof settings.runtimes === "object" ? settings.runtimes.mkxpz : null;
  const { version } = resolveRuntimeConfig(managerSettings, runtimeData);

  const installed = ensureRuntimeInstalled({ userDataDir, version });
  if (!installed?.appPath) throw new Error("MKXP-Z runtime missing app bundle.");

  const config = buildMkxpConfig({ entry, userDataDir, runtimeSettings, logger });
  const cheatsRuntimePath = cheatsFilePath ? ensureCheatsRuntime(userDataDir) : null;
  if (cheatsRuntimePath) {
    const postload = Array.isArray(config.postloadScript) ? config.postloadScript.slice() : [];
    if (!postload.includes(cheatsRuntimePath)) postload.push(cheatsRuntimePath);
    config.postloadScript = postload;
  } else if (cheatsFilePath) {
    logger?.warn?.("[mkxpz] cheats runtime missing; skipping RGSS cheats");
  }
  const configPath = resolveConfigPath(installed.appPath);
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  logger?.info?.("[mkxpz] config written", { configPath, config });

  const executablePath = resolveExecutablePath(installed.appPath);
  const stat = safeStat(executablePath);
  if (!stat || !stat.isFile()) throw new Error("MKXP-Z executable not found.");

  const args = [config.gameFolder];
  const logPaths = resolveLogPaths(userDataDir, entry?.gamePath || config.gameFolder);
  const snapshot = {
    timestamp: new Date().toISOString(),
    runtime: {
      version,
      source: installed.source,
      appPath: installed.appPath,
      executablePath,
      configPath
    },
    game: {
      name: entry?.name || null,
      gamePath: entry?.gamePath || null,
      contentRootDir: entry?.contentRootDir || null,
      moduleData: entry?.moduleData || null
    },
    runtimeSettings: runtimeSettings || null,
    config
  };
  if (safeWriteJson(logPaths.snapshotPath, snapshot)) {
    logger?.info?.(`[mkxpz] launch snapshot ${logPaths.snapshotPath}`);
  } else {
    logger?.warn?.("[mkxpz] failed to write launch snapshot");
  }

  appendLogLine(logPaths.logPath, "---- MKXP-Z launch ----");
  appendLogLine(logPaths.logPath, `executable=${executablePath}`);
  appendLogLine(logPaths.logPath, `config=${configPath}`);
  appendLogLine(logPaths.logPath, `snapshot=${logPaths.snapshotPath}`);
  appendLogLine(logPaths.logPath, `args=${args.join(" ")}`);
  logger?.info?.(`[mkxpz] log file ${logPaths.logPath}`);
  logger?.info?.(`[mkxpz] launch ${executablePath} ${args.join(" ")}`);

  const env = { ...process.env };
  if (cheatsFilePath) {
    env.MACLAUNCHER_RGSS_CHEATS_FILE = cheatsFilePath;
    env.MACLAUNCHER_CHEATS_FILE = cheatsFilePath;
  }

  const logFd = fs.openSync(logPaths.logPath, "a");
  try {
    return await spawnDetachedChecked(executablePath, args, {
      cwd: path.dirname(executablePath),
      stdio: ["ignore", logFd, logFd],
      env
    });
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {}
  }
}

module.exports = {
  launchRuntime,
  buildMkxpConfig,
  resolveRuntimeConfig
};
