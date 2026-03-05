const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { shell } = require("electron");

const manifest = require("./manifest.json");
const { detectGame, LTS_LINES } = require("./detect");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");
const { extractJarIconToPath } = require("./jar-icon");
const JavaRuntimeManager = require("./runtime/java-runtime-manager");
const GameData = require("../shared/game-data");

const JavaCore = JavaRuntimeManager.core.java;
const VineflowerCore = JavaRuntimeManager.core.vineflower;
const MAX_MANAGED_LINE = Math.max(...LTS_LINES);

let runCommandOverride = null;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

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

function isManagedLine(line) {
  const value = Number(line);
  return Number.isFinite(value) && LTS_LINES.includes(value);
}

function normalizeLineOrNull(input) {
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  return value;
}

function normalizeVersionOrNull(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    return JavaCore.normalizeVersion(input.trim());
  } catch {
    return null;
  }
}

function normalizeVariantOrNull(input) {
  const normalized = JavaCore.normalizeVariant(input);
  return normalized || null;
}

function normalizeRuntimeId(input) {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  return raw || "java";
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
  return merged;
}

function resolveJarPath(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const jarFromModuleData =
    typeof moduleData.jarPath === "string" && moduleData.jarPath.trim()
      ? moduleData.jarPath.trim()
      : null;
  if (jarFromModuleData) return jarFromModuleData;
  const gamePath = typeof entry?.gamePath === "string" && entry.gamePath.trim() ? entry.gamePath.trim() : null;
  if (gamePath && gamePath.toLowerCase().endsWith(".jar")) return gamePath;
  return null;
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function resolveJarIconCachePath(entry, userDataDir) {
  const gameId = typeof entry?.gameId === "string" ? entry.gameId.trim() : "";
  if (!gameId || !userDataDir) return null;
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "java"), "icons", "jar-icon.png");
}

function resolveGameIcon(entry, context) {
  const userDataDir = context?.userDataDir;
  const jarPath = resolveJarPath(entry);
  if (!jarPath || !existsFile(jarPath)) return null;
  const cachePath = resolveJarIconCachePath(entry, userDataDir);
  if (!cachePath) return null;

  const jarStat = safeStat(jarPath);
  if (!jarStat || !jarStat.isFile()) return null;

  const cacheStat = safeStat(cachePath);
  if (cacheStat && cacheStat.isFile() && cacheStat.size > 0 && cacheStat.mtimeMs >= jarStat.mtimeMs) {
    return cachePath;
  }

  const extracted = extractJarIconToPath(jarPath, cachePath);
  if (extracted && existsFile(extracted)) return extracted;

  // Do not keep stale cache when extraction fails after a jar update.
  if (cacheStat && cacheStat.isFile()) {
    try {
      fs.rmSync(cachePath);
    } catch {}
  }
  return null;
}

function resolveRuntimeData(entry) {
  const runtimeData = entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  return runtimeData.java && typeof runtimeData.java === "object" ? runtimeData.java : {};
}

function resolveRequiredLine(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const runtimeLine = normalizeLineOrNull(moduleData.runtimeLine);
  if (runtimeLine) return runtimeLine;
  const requiredJava = normalizeLineOrNull(moduleData.requiredJava);
  if (!requiredJava) return null;
  for (const line of LTS_LINES) {
    if (line >= requiredJava) return line;
  }
  return requiredJava;
}

function resolveRequestedLine(entry, settings) {
  const runtimeData = resolveRuntimeData(entry);
  const cfg = JavaRuntimeManager.normalizeSettings(settings?.runtimes?.java);
  const requiredLine = resolveRequiredLine(entry);

  const overrideLine = normalizeLineOrNull(runtimeData.line);
  const defaultLine = normalizeLineOrNull(cfg.defaultLine) || 21;

  let line = overrideLine || requiredLine || defaultLine;
  if (Number.isFinite(requiredLine) && isManagedLine(requiredLine) && Number.isFinite(line) && line < requiredLine) {
    line = requiredLine;
  }

  return {
    line,
    requiredLine,
    overrideLine,
    cfg,
    runtimeData
  };
}

function resolveLineConfig(cfg, line) {
  if (!cfg || !Number.isFinite(line)) {
    return {
      defaultVersion: null,
      defaultVariant: JavaCore.defaultVariantForHost()
    };
  }
  const section = cfg.lines?.[line] && typeof cfg.lines[line] === "object" ? cfg.lines[line] : {};
  return {
    defaultVersion: normalizeVersionOrNull(section.defaultVersion),
    defaultVariant: normalizeVariantOrNull(section.defaultVariant) || JavaCore.defaultVariantForHost()
  };
}

function resolveInstalledRuntime({ userDataDir, line, runtimeData, lineConfig }) {
  const overrideVersion = normalizeVersionOrNull(runtimeData.version);
  const defaultVersion = normalizeVersionOrNull(lineConfig.defaultVersion);
  const preferredVariant =
    normalizeVariantOrNull(runtimeData.variant) ||
    normalizeVariantOrNull(lineConfig.defaultVariant) ||
    JavaCore.defaultVariantForHost();

  const candidates = [];
  if (overrideVersion) candidates.push(overrideVersion);
  if (defaultVersion && defaultVersion !== overrideVersion) candidates.push(defaultVersion);
  candidates.push(null);

  for (const version of candidates) {
    const match = JavaCore.resolveBestInstalled({
      userDataDir,
      line,
      version,
      variant: preferredVariant,
      hostArch: process.arch
    });
    if (match) return match;
  }

  return null;
}

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item ?? "").trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveWorkingDir(entry, jarPath, runtimeSettings) {
  const mode =
    typeof runtimeSettings?.workingDir === "string" && runtimeSettings.workingDir.trim()
      ? runtimeSettings.workingDir.trim()
      : "jar-dir";
  if (mode === "game-dir") {
    const gameDir =
      typeof entry?.contentRootDir === "string" && entry.contentRootDir.trim()
        ? entry.contentRootDir.trim()
        : null;
    if (gameDir && existsDir(gameDir)) return gameDir;
  }
  return path.dirname(jarPath);
}

function rosettaErrorMessage() {
  return "This runtime requires Rosetta on Apple Silicon. Install Rosetta and try again: softwareupdate --install-rosetta";
}

function applyExtractionStatus(entry, status) {
  updateModuleData(entry, {
    extractedReady: Boolean(status?.extractedReady),
    extractedRoot: status?.extractedRoot || null,
    extractedAt: status?.extractedAt || null
  });
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = entry?.gameId;
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameModuleDir(userDataDir, gameId, "java"));
  return true;
}

function runCommand(cmd, args, options = {}) {
  const needsRosetta = options.needsRosetta === true;
  const env = options.env || process.env;
  const cwd = options.cwd;
  const command = needsRosetta ? "arch" : cmd;
  const commandArgs = needsRosetta ? ["-x86_64", cmd, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${command} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function runCommandChecked(cmd, args, options = {}) {
  const impl = runCommandOverride || runCommand;
  return impl(cmd, args, options);
}

function findSectionStateById(managerState, sectionId) {
  const sections = Array.isArray(managerState?.sections) ? managerState.sections : [];
  return sections.find(section => String(section?.id || "") === String(sectionId || "")) || null;
}

async function resolveInstallVersionForLine(line, context) {
  const state = JavaRuntimeManager.getState({
    settings: context.settings?.runtimes?.java,
    userDataDir: context.userDataDir
  });
  let section = findSectionStateById(state, String(line));
  let version = section?.catalog?.versions?.[0] || null;
  if (version) return version;

  await JavaRuntimeManager.refreshCatalog({
    logger: context.logger,
    force: true,
    sectionId: String(line)
  });

  const refreshed = JavaRuntimeManager.getState({
    settings: context.settings?.runtimes?.java,
    userDataDir: context.userDataDir
  });
  section = findSectionStateById(refreshed, String(line));
  version = section?.catalog?.versions?.[0] || null;
  return version || null;
}

async function ensureVineflowerInstalled(context) {
  const cfg = JavaRuntimeManager.normalizeSettings(context.settings?.runtimes?.java);
  const preferredVersion = cfg.vineflower.defaultVersion;
  const installed = VineflowerCore.listInstalled(context.userDataDir);

  if (preferredVersion) {
    const preferred = installed.find(item => item.version === preferredVersion);
    if (preferred) return preferred;
  }
  if (installed[0]) return installed[0];

  let targetVersion = preferredVersion;
  if (!targetVersion) {
    const state = JavaRuntimeManager.getState({
      settings: context.settings?.runtimes?.java,
      userDataDir: context.userDataDir
    });
    const section = findSectionStateById(state, "vineflower");
    targetVersion = section?.catalog?.versions?.[0] || null;
  }
  if (!targetVersion) {
    await JavaRuntimeManager.refreshCatalog({
      logger: context.logger,
      force: true,
      sectionId: "vineflower"
    });
    const state = JavaRuntimeManager.getState({
      settings: context.settings?.runtimes?.java,
      userDataDir: context.userDataDir
    });
    const section = findSectionStateById(state, "vineflower");
    targetVersion = section?.catalog?.versions?.[0] || null;
  }

  if (!targetVersion) {
    throw new Error("No Vineflower release available.");
  }

  return JavaRuntimeManager.installRuntime({
    userDataDir: context.userDataDir,
    sectionId: "vineflower",
    version: targetVersion,
    logger: context.logger,
    downloads: context.downloads
  });
}

async function ensureDecompilerJavaRuntime(context) {
  const cfg = JavaRuntimeManager.normalizeSettings(context.settings?.runtimes?.java);
  const orderedLines = Array.from(
    new Set([
      cfg.defaultLine,
      17,
      21,
      25
    ])
  ).filter(line => Number.isFinite(Number(line)) && isManagedLine(Number(line)) && Number(line) >= 17);

  for (const rawLine of orderedLines) {
    const line = Number(rawLine);
    const lineConfig = resolveLineConfig(cfg, line);
    const install = resolveInstalledRuntime({
      userDataDir: context.userDataDir,
      line,
      runtimeData: {},
      lineConfig
    });
    if (install) return install;
  }

  const installLine = orderedLines[0] || 17;
  const lineConfig = resolveLineConfig(cfg, installLine);
  let version = lineConfig.defaultVersion;
  if (!version) {
    version = await resolveInstallVersionForLine(installLine, context);
  }
  if (!version) {
    throw new Error(`No Java ${installLine} runtime is available for install.`);
  }

  await JavaRuntimeManager.installRuntime({
    userDataDir: context.userDataDir,
    sectionId: String(installLine),
    line: installLine,
    version,
    variant: lineConfig.defaultVariant,
    logger: context.logger,
    downloads: context.downloads
  });

  const installed = JavaCore.resolveBestInstalled({
    userDataDir: context.userDataDir,
    line: installLine,
    version,
    variant: lineConfig.defaultVariant,
    hostArch: process.arch
  });
  if (!installed?.javaPath) {
    throw new Error(`Java ${installLine} runtime installation did not produce a valid runtime.`);
  }
  return installed;
}

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "java") return null;

  const jarPath = resolveJarPath(entry);
  if (!jarPath || !existsFile(jarPath)) {
    throw new Error("Java jar file not found.");
  }

  const { line, requiredLine, cfg, runtimeData } = resolveRequestedLine(entry, context.settings);
  if (!Number.isFinite(line)) {
    throw new Error("Java runtime line is unknown for this game.");
  }
  if (!isManagedLine(line)) {
    if (requiredLine && requiredLine > MAX_MANAGED_LINE) {
      throw new Error(
        `This jar requires Java ${requiredLine}, but the launcher currently manages up to Java ${MAX_MANAGED_LINE}.`
      );
    }
    throw new Error(`Unsupported Java line ${line}.`);
  }

  const lineConfig = resolveLineConfig(cfg, line);
  const install = resolveInstalledRuntime({
    userDataDir: context.userDataDir,
    line,
    runtimeData,
    lineConfig
  });

  if (!install?.javaPath) {
    throw new Error(`Java ${line} runtime is not installed. Install it from Runtimes.`);
  }
  if (install.requiresRosetta && !JavaCore.isRosettaAvailable()) {
    throw new Error(rosettaErrorMessage());
  }

  const runtimeSettings =
    context?.runtimeSettings && typeof context.runtimeSettings === "object"
      ? context.runtimeSettings
      : {};
  const vmArgs = parseListValue(runtimeSettings.vmArgs);
  const appArgs = parseListValue(runtimeSettings.appArgs);
  const cwd = resolveWorkingDir(entry, jarPath, runtimeSettings);

  const args = [...vmArgs, "-jar", jarPath, ...appArgs];
  context.logger?.info?.(`[runtime] launch java ${install.javaPath} ${args.join(" ")}`);
  return context.spawnDetachedChecked(install.javaPath, args, { cwd }, install.requiresRosetta);
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  mergeEntry,
  resolveGameIcon,
  normalizeRuntimeId,
  runtimeManagers: [JavaRuntimeManager],
  launchRuntime,
  cleanupGameData,
  actions: {
    runtimeStatus: (entry, _payload, context) => {
      const { line, requiredLine, cfg, runtimeData } = resolveRequestedLine(entry, context.settings);
      const moduleData =
        entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};

      if (!Number.isFinite(line)) {
        return {
          ready: false,
          installed: false,
          requiredJava: normalizeLineOrNull(moduleData.requiredJava),
          requiredLine: requiredLine || null,
          reason: "required-line-missing"
        };
      }

      if (!isManagedLine(line)) {
        return {
          ready: false,
          installed: false,
          requiredJava: normalizeLineOrNull(moduleData.requiredJava),
          requiredLine: requiredLine || line,
          requestedLine: line,
          unsupportedLine: true,
          reason: "unsupported-line"
        };
      }

      const lineConfig = resolveLineConfig(cfg, line);
      const install = resolveInstalledRuntime({
        userDataDir: context.userDataDir,
        line,
        runtimeData,
        lineConfig
      });
      const rosettaRequired = Boolean(install?.requiresRosetta);
      const rosettaMissing = rosettaRequired && !JavaCore.isRosettaAvailable();
      const installed = Boolean(install?.javaPath);

      return {
        ready: installed && !rosettaMissing,
        installed,
        rosettaRequired,
        rosettaMissing,
        requiredJava: normalizeLineOrNull(moduleData.requiredJava),
        requiredLine: requiredLine || line,
        requestedLine: line,
        resolvedVersion: install?.version || null,
        resolvedVariant: install?.variant || null
      };
    },
    installRuntime: async (entry, payload, context) => {
      const status = payload?.status && typeof payload.status === "object" ? payload.status : null;
      const { line: computedLine, requiredLine, cfg, runtimeData } = resolveRequestedLine(
        entry,
        context.settings
      );

      const requestedLine =
        normalizeLineOrNull(payload?.line) ||
        normalizeLineOrNull(status?.requestedLine) ||
        normalizeLineOrNull(status?.requiredLine) ||
        normalizeLineOrNull(runtimeData.line) ||
        computedLine;

      if (!Number.isFinite(requestedLine)) {
        throw new Error("Java runtime line is unknown for this game.");
      }
      if (!isManagedLine(requestedLine)) {
        if (requiredLine && requiredLine > MAX_MANAGED_LINE) {
          throw new Error(
            `This jar requires Java ${requiredLine}, but the launcher currently manages up to Java ${MAX_MANAGED_LINE}.`
          );
        }
        throw new Error(`Unsupported Java line ${requestedLine}.`);
      }

      const lineConfig = resolveLineConfig(cfg, requestedLine);
      const requestedVariant =
        normalizeVariantOrNull(payload?.variant) ||
        normalizeVariantOrNull(runtimeData.variant) ||
        lineConfig.defaultVariant;

      let requestedVersion =
        normalizeVersionOrNull(payload?.version) ||
        normalizeVersionOrNull(status?.resolvedVersion) ||
        normalizeVersionOrNull(runtimeData.version) ||
        lineConfig.defaultVersion ||
        null;

      let existing = requestedVersion
        ? JavaCore.resolveBestInstalled({
            userDataDir: context.userDataDir,
            line: requestedLine,
            version: requestedVersion,
            variant: requestedVariant,
            hostArch: process.arch
          })
        : null;
      if (!existing) {
        existing = JavaCore.resolveBestInstalled({
          userDataDir: context.userDataDir,
          line: requestedLine,
          version: null,
          variant: requestedVariant,
          hostArch: process.arch
        });
      }
      if (existing?.javaPath) {
        if (existing.requiresRosetta && !JavaCore.isRosettaAvailable()) {
          throw new Error(rosettaErrorMessage());
        }
        updateRuntimeData(entry, "java", {
          line: requestedLine,
          version: existing.version,
          variant: existing.variant
        });
        return {
          line: requestedLine,
          version: existing.version,
          variant: existing.variant,
          alreadyInstalled: true
        };
      }

      if (!requestedVersion) {
        requestedVersion = await resolveInstallVersionForLine(requestedLine, context);
      }
      if (!requestedVersion) {
        throw new Error(`No Java ${requestedLine} version is available for install.`);
      }

      const installed = await JavaRuntimeManager.installRuntime({
        userDataDir: context.userDataDir,
        sectionId: String(requestedLine),
        line: requestedLine,
        version: requestedVersion,
        variant: requestedVariant,
        logger: context.logger,
        downloads: context.downloads
      });

      if (installed?.requiresRosetta && !JavaCore.isRosettaAvailable()) {
        throw new Error(rosettaErrorMessage());
      }

      updateRuntimeData(entry, "java", {
        line: requestedLine,
        version: installed?.version || requestedVersion,
        variant: installed?.variant || requestedVariant
      });

      return {
        line: requestedLine,
        version: installed?.version || requestedVersion,
        variant: installed?.variant || requestedVariant
      };
    },
    refreshExtractionStatus: (entry, _payload, context) => {
      const jarPath = resolveJarPath(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: jarPath || null
      });
      applyExtractionStatus(entry, status);
      return {
        extractStatusLabel: status.extractedReady ? "Extracted" : "Not extracted",
        extractedAt: status.extractedAt || null
      };
    },
    revealExtraction: (entry, _payload, context) => {
      const jarPath = resolveJarPath(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: jarPath || null
      });
      if (!status.extractedRoot || !existsDir(status.extractedRoot)) {
        throw new Error("No extracted data found.");
      }
      shell.showItemInFolder(status.extractedRoot);
      return { revealed: true };
    },
    extractGame: async (entry, _payload, context) => {
      const jarPath = resolveJarPath(entry);
      if (!jarPath || !existsFile(jarPath)) {
        throw new Error("Java jar file not found.");
      }

      const vineflowerInstall = await ensureVineflowerInstalled(context);
      if (!vineflowerInstall?.jarPath || !existsFile(vineflowerInstall.jarPath)) {
        throw new Error("Vineflower is not installed.");
      }

      const decompilerRuntime = await ensureDecompilerJavaRuntime(context);
      if (!decompilerRuntime?.javaPath || !existsFile(decompilerRuntime.javaPath)) {
        throw new Error("A Java 17+ runtime is required for Vineflower.");
      }
      if (decompilerRuntime.requiresRosetta && !JavaCore.isRosettaAvailable()) {
        throw new Error(rosettaErrorMessage());
      }

      const extractRoot = resolveExtractionRoot({
        entry,
        userDataDir: context.userDataDir
      });
      safeRm(extractRoot);
      ensureDir(extractRoot);

      const args = ["-jar", vineflowerInstall.jarPath, jarPath, extractRoot];
      context.logger?.info?.(`[java] vineflower ${decompilerRuntime.javaPath} ${args.join(" ")}`);
      await runCommandChecked(decompilerRuntime.javaPath, args, {
        cwd: path.dirname(jarPath),
        needsRosetta: Boolean(decompilerRuntime.requiresRosetta)
      });

      writeExtractionMeta(extractRoot, {
        sourcePath: jarPath,
        vineflowerVersion: vineflowerInstall.version || null,
        extractedAt: Date.now()
      });

      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: jarPath
      });
      applyExtractionStatus(entry, status);
      return {
        extractStatusLabel: status.extractedReady ? "Extracted" : "Not extracted",
        extractedAt: status.extractedAt || null,
        extractedRoot: status.extractedRoot || null,
        vineflowerVersion: vineflowerInstall.version || null
      };
    },
    removeExtraction: (entry, _payload, context) => {
      const extractRoot = resolveExtractionRoot({
        entry,
        userDataDir: context.userDataDir
      });
      safeRm(extractRoot);
      applyExtractionStatus(entry, {
        extractedReady: false,
        extractedRoot: null,
        extractedAt: null
      });
      return {
        extractStatusLabel: "Not extracted",
        extractedAt: null
      };
    }
  },
  __test: {
    resolveRequiredLine,
    resolveRequestedLine,
    resolveInstalledRuntime,
    applyExtractionStatus,
    setRunCommandOverride: fn => {
      runCommandOverride = typeof fn === "function" ? fn : null;
    }
  }
};
