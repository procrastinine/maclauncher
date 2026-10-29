const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getUiServices } = require("../shared/ui-services");

const manifest = require("./manifest.json");
const { detectGame, inspectJar, LTS_LINES } = require("./detect");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");
const { extractJarIconToPath } = require("./jar-icon");
const JavaRuntimeManager = require("./runtime/java-runtime-manager");
const Custom = require("../shared/runtime/custom-runtime");
const { selectRuntimeVersion } = require("../shared/runtime/version-choices");
const Rosetta = require("../shared/runtime/rosetta");
const GraphicsInputs = require("../shared/runtime/native-graphics-inputs");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const GameData = require("../shared/game-data");
const JavaSteamConsumer = require("./runtime/steamworks/consumer");
const JavaSteam = require("./runtime/steamworks/runtime");
const Images = require("../../core/icon-utils");
const { readJsonObject, writeJsonAtomic } = require("../../core/json-files");
const Writable = require("../shared/writable-input");

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
    return JavaCore.normalizeVersion(input);
  } catch {
    return null;
  }
}

function normalizeVersionForLine(input, line) {
  if (Custom.isPath(input)) return input;
  const version = normalizeVersionOrNull(input);
  return version && JavaCore.versionMajor(version) === line ? version : null;
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
  const fingerprint = JSON.stringify(["jar-icon-v2", fs.realpathSync(jarPath), jarStat.dev, jarStat.ino, jarStat.size, jarStat.mtimeMs, jarStat.ctimeMs]);
  const receipt = cachePath + ".source.json";
  Writable.assertOwnDirectory(userDataDir, path.dirname(cachePath));
  let cached;
  try { const stat = fs.lstatSync(receipt); if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384) cached = readJsonObject(receipt); } catch {}
  if (cached?.fingerprint === fingerprint && cacheStat?.isFile() && cacheStat.size > 0 && cacheStat.size <= 8 * 1024 ** 2 &&
    !fs.lstatSync(cachePath).isSymbolicLink() && Images.isSupportedImageBuffer(fs.readFileSync(cachePath))) return cachePath;

  const extracted = extractJarIconToPath(jarPath, cachePath, { root: userDataDir });
  if (extracted && existsFile(extracted)) { writeJsonAtomic(receipt, { fingerprint }); return extracted; }

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

// Bytecode and recorded platform dependencies recommend the automatic line.
// Explicit runtime choices remain independent of that recommendation.
function resolveRequiredLine(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const minimumLine = normalizeLineOrNull(moduleData.minimumLine);
  if (minimumLine) return minimumLine;
  const requiredJava = normalizeLineOrNull(moduleData.requiredJava);
  if (!requiredJava) return normalizeLineOrNull(moduleData.runtimeLine);
  for (const line of LTS_LINES) {
    if (line >= requiredJava) return line;
  }
  return requiredJava;
}

// Detection records the line Automatic uses, which can be newer than the
// minimum (Java 8 bytecode without Java 8 platform dependencies runs on 21).
function resolveAutomaticLine(entry, requiredLine) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const runtimeLine = normalizeLineOrNull(moduleData.runtimeLine);
  return runtimeLine && (!requiredLine || runtimeLine >= requiredLine) ? runtimeLine : requiredLine;
}

function resolveRequestedLine(entry, settings) {
  const runtimeData = resolveRuntimeData(entry);
  const cfg = JavaRuntimeManager.normalizeSettings(settings?.runtimes?.java);
  const requiredLine = resolveRequiredLine(entry);

  const overrideLine = normalizeLineOrNull(runtimeData.line);
  const version = normalizeVersionOrNull(runtimeData.version);
  const versionLine = version && !Custom.isPath(version) ? JavaCore.versionMajor(version) : null;
  const pinnedLine = versionLine && isManagedLine(versionLine) ? versionLine : null;
  const line = selectRuntimeVersion({ manual: overrideLine || pinnedLine,
    recommended: resolveAutomaticLine(entry, requiredLine), defaultVersion: cfg.defaultLine || 21 }).version;

  // Explicit line choices take precedence over detection. A patch left from
  // another line cannot identify an installation or download on this line,
  // including when Auto follows a changed JAR requirement.
  const effectiveRuntimeData = version && !Custom.isPath(version) && JavaCore.versionMajor(version) !== line
    ? { ...runtimeData, version: null }
    : runtimeData;

  return {
    line,
    requiredLine,
    overrideLine,
    cfg,
    runtimeData: effectiveRuntimeData
  };
}

function resolveLineConfig(cfg, line, userDataDir) {
  if (!cfg || !Number.isFinite(line)) {
    return {
      defaultVersion: null,
      defaultVariant: JavaCore.defaultVariantForHost()
    };
  }
  const section = cfg.lines?.[line] && typeof cfg.lines[line] === "object" ? cfg.lines[line] : {};
  return {
    defaultVersion: selectRuntimeVersion({ defaultVersion: normalizeVersionForLine(section.defaultVersion, line),
      fallback: JavaRuntimeManager.getState({ settings: cfg, userDataDir }).sections?.find(item => String(item.id) === String(line))?.defaultVersion }).version,
    defaultVariant: normalizeVariantOrNull(section.defaultVariant) || JavaCore.defaultVariantForHost()
  };
}

function resolveInstalledRuntime({ userDataDir, line, runtimeData, lineConfig, entry }) {
  // Game data recommends a Java line, not a patch; the line's default supplies it.
  const overrideVersion = selectRuntimeVersion({ manual: normalizeVersionOrNull(runtimeData.version),
    defaultVersion: lineConfig.defaultVersion }).version;
  let preferredVariant =
    normalizeVariantOrNull(runtimeData.variant) ||
    normalizeVariantOrNull(lineConfig.defaultVariant) ||
    JavaCore.defaultVariantForHost();
  const requiredVariant = entry && JavaSteam.requiredVariant(entry, {
    explicitVariant: normalizeVariantOrNull(runtimeData.variant), preferredVariant
  });
  if (requiredVariant) preferredVariant = requiredVariant;

  return JavaCore.resolveBestInstalled({
    userDataDir,
    line,
    version: overrideVersion,
    variant: preferredVariant,
    ...(requiredVariant ? { strictVariant: true } : {}),
    hostArch: process.arch
  });
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

async function ensureInstalledRosetta(install, context) {
  if (!install?.requiresRosetta || JavaCore.isRosettaAvailable()) return;
  if (typeof context.ensureRosetta === "function") await context.ensureRosetta();
  else if (typeof context.confirmRuntimeInstall === "function") await Rosetta.ensure(context);
  else throw Rosetta.createRequiredError();
  if (!JavaCore.isRosettaAvailable()) throw Rosetta.createRequiredError();
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
      signal: options.signal,
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
  const section = findSectionStateById(state, String(line));
  return selectRuntimeVersion({ defaultVersion: section?.defaultVersion }).version;
}

async function ensureVineflowerInstalled(context) {
  const cfg = JavaRuntimeManager.normalizeSettings(context.settings?.runtimes?.java);
  const selectVersion = () => {
    const state = JavaRuntimeManager.getState({ settings: context.settings?.runtimes?.java, userDataDir: context.userDataDir });
    return selectRuntimeVersion({ defaultVersion: cfg.vineflower.defaultVersion,
      fallback: findSectionStateById(state, "vineflower")?.defaultVersion }).version;
  };
  let targetVersion = selectVersion();
  const installed = targetVersion && VineflowerCore.listInstalled(context.userDataDir).find(row => row.version === targetVersion);
  if (installed) return installed;
  await confirmToolInstall(context, { manager: JavaRuntimeManager, label: "Vineflower", version: targetVersion,
    installOptions: { sectionId: "vineflower" }, detail: "Required for Java decompilation." });
  if (!targetVersion) {
    await JavaRuntimeManager.refreshCatalog({ logger: context.logger, sectionId: "vineflower" });
    context.onRuntimeStateChange?.();targetVersion = selectVersion();
  }
  if (!targetVersion) throw new Error("No Vineflower versions are available to download.");

  const result = await JavaRuntimeManager.installRuntime({
    userDataDir: context.userDataDir,
    sectionId: "vineflower",
    version: targetVersion,
    logger: context.logger,
    downloads: context.downloads,
    signal: context.signal
  });
  context.onRuntimeStateChange?.();
  return result;
}

async function ensureDecompilerJavaRuntime(context, requiredJava = 17) {
  const minimumJava = Math.max(17, Number(requiredJava) || 17);
  if (minimumJava > MAX_MANAGED_LINE) {
    throw new Error(`This decompiler requires Java ${minimumJava}; the launcher manages up to Java ${MAX_MANAGED_LINE}.`);
  }
  const cfg = JavaRuntimeManager.normalizeSettings(context.settings?.runtimes?.java);
  const orderedLines = Array.from(
    new Set([
      cfg.defaultLine,
      17,
      21,
      25
    ])
  ).filter(line => Number.isFinite(Number(line)) && isManagedLine(Number(line)) && Number(line) >= minimumJava);

  for (const rawLine of orderedLines) {
    const line = Number(rawLine);
    const lineConfig = resolveLineConfig(cfg, line, context.userDataDir);
    const install = resolveInstalledRuntime({
      userDataDir: context.userDataDir,
      line,
      runtimeData: {},
      lineConfig
    });
    if (install) return install;
  }

  const installLine = orderedLines[0];
  const lineConfig = resolveLineConfig(cfg, installLine, context.userDataDir);
  let version = lineConfig.defaultVersion;
  const installOptions = { sectionId: String(installLine), line: installLine, variant: lineConfig.defaultVariant };
  await confirmToolInstall(context, { manager: JavaRuntimeManager, label: `Java ${installLine}`, version,
    installOptions, detail: "Required to run the Java decompiler." });
  if (!version) {
    version = await resolveInstallVersionForLine(installLine, context);
    if (!version) {
      await JavaRuntimeManager.refreshCatalog({ logger: context.logger, force: true, sectionId: String(installLine) });
      context.onRuntimeStateChange?.();
      version = await resolveInstallVersionForLine(installLine, context);
    }
  }
  if (!version) {
    throw new Error(`No Java ${installLine} runtime is available for install.`);
  }

  await JavaRuntimeManager.installRuntime({
    userDataDir: context.userDataDir,
    ...installOptions,
    version,
    logger: context.logger,
    downloads: context.downloads,
    signal: context.signal
  });
  context.onRuntimeStateChange?.();

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

function resolveGraphicsInputs(entry, context = {}) {
  if ((context.runtimeId || entry.runtimeId || manifest.runtime.default) !== "java") return null;
  const { line, cfg, runtimeData } = resolveRequestedLine(entry, context.settings);
  if (!isManagedLine(line)) return null;
  const install = resolveInstalledRuntime({ userDataDir: context.userDataDir, line, runtimeData,
    lineConfig: resolveLineConfig(cfg, line, context.userDataDir), entry });
  if (!install?.javaPath) return null;
  return GraphicsInputs.withInputs({ moduleData: { executablePath: install.javaPath } }, {
    runtimeId: "native", declaredArchitecture: install.requiresRosetta ? "x86_64" : undefined
  });
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

  const lineConfig = resolveLineConfig(cfg, line, context.userDataDir);
  const install = resolveInstalledRuntime({
    userDataDir: context.userDataDir,
    line,
    runtimeData,
    lineConfig,
    entry
  });

  if (!install?.javaPath) {
    throw new Error(`Java ${line} runtime is not installed. Install it from Runtimes.`);
  }
  await ensureInstalledRosetta(install, context);

  const runtimeSettings =
    context?.runtimeSettings && typeof context.runtimeSettings === "object"
      ? context.runtimeSettings
      : {};
  const vmArgs = parseListValue(runtimeSettings.vmArgs);
  const appArgs = parseListValue(runtimeSettings.appArgs);
  const cwd = resolveWorkingDir(entry, jarPath, runtimeSettings);
  if (typeof context.useRuntime === "function") await context.useRuntime({ managerId: "java", version: install.version,
    sectionId: String(line), variant: install.variant, sourcePath: install.installDir });
  const steam = await JavaSteam.prepareLaunch(entry, context, install);
  const args = [...(steam?.vmArgs || []), ...vmArgs, "-jar", jarPath, ...appArgs, ...(context.gameArguments || [])];
  context.logger?.info?.(`[runtime] launch java ${install.javaPath} ${args.join(" ")}`);
  return context.spawnDetachedChecked(install.javaPath, args, { cwd, ...(steam ? { env: steam.environment } : {}) }, install.requiresRosetta);
}

async function ensureRuntime(entry, context) {
  if ((context.runtimeId || entry.runtimeId || manifest.runtime.default) !== "java") return null;
  const { line, requiredLine, cfg, runtimeData } = resolveRequestedLine(entry, context.settings);
  if (!Number.isFinite(line)) throw new Error("Java runtime line is unknown for this game.");
  if (!isManagedLine(line)) {
    if (requiredLine && requiredLine > MAX_MANAGED_LINE) {
      throw new Error(`This jar requires Java ${requiredLine}, but the launcher currently manages up to Java ${MAX_MANAGED_LINE}.`);
    }
    throw new Error(`Unsupported Java line ${line}.`);
  }
  const lineConfig = resolveLineConfig(cfg, line, context.userDataDir);
  const installed = resolveInstalledRuntime({ userDataDir: context.userDataDir, line, runtimeData, lineConfig, entry });
  if (installed?.javaPath) {
    await ensureInstalledRosetta(installed, context);
    return null;
  }
  const version = selectRuntimeVersion({ manual: normalizeVersionOrNull(runtimeData.version),
    defaultVersion: lineConfig.defaultVersion }).version;
  const requiredVariant = JavaSteam.requiredVariant(entry, { explicitVariant: normalizeVariantOrNull(runtimeData.variant), preferredVariant: lineConfig.defaultVariant });
  const variant = requiredVariant || normalizeVariantOrNull(runtimeData.variant) || lineConfig.defaultVariant;
  return { managerId: JavaRuntimeManager.id, version, ...(!version ? { discoveryRequired: true } : {}), installOptions: { sectionId: String(line), line, variant,
    ...(requiredVariant ? { strictVariant: true, preserveDefaults: true } : {}) } };
}

module.exports = {
  metadataSources: ["jar-icon.js", "../shared/runtime/zip.js"],
  id: manifest.id,
  manifest,
  detectGame,
  mergeEntry,
  resolveGameIcon,
  normalizeRuntimeId,
  runtimeManagers: [JavaRuntimeManager],
  distributionSupplementals: require("./runtime/steamworks/distribution-supplementals.json"),
  nativeHostDependencies: JavaSteam.nativeHostDependencies,
  onImport: entry => { JavaSteamConsumer.inspect(entry); },
  getRuntimeRequirements: (entry, context) => {
    const required = JavaSteamConsumer.requirement(entry);
    if (required) JavaSteam.resolveBundle(required.pin, { resourcesRoot: context.resourcesRoot });
    return [];
  },
  launchRuntime,
  resolveGraphicsInputs,
  ensureRuntime,
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

      const lineConfig = resolveLineConfig(cfg, line, context.userDataDir);
      const install = resolveInstalledRuntime({
        userDataDir: context.userDataDir,
        line,
        runtimeData,
        lineConfig,
        entry
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
      const { line: computedLine, requiredLine, cfg } = resolveRequestedLine(
        entry,
        context.settings
      );
      const requestedLine = normalizeLineOrNull(payload?.line) || computedLine;

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

      const lineConfig = resolveLineConfig(cfg, requestedLine, context.userDataDir);
      const currentRuntimeData = resolveRuntimeData(entry);
      const runtimeData = {
        ...currentRuntimeData,
        version: normalizeVersionForLine(payload?.version, requestedLine) ||
          normalizeVersionForLine(currentRuntimeData.version, requestedLine),
        variant: normalizeVariantOrNull(payload?.variant) || normalizeVariantOrNull(currentRuntimeData.variant)
      };
      let requestedVariant =
        normalizeVariantOrNull(runtimeData.variant) ||
        lineConfig.defaultVariant;
      const requiredVariant = JavaSteam.requiredVariant(entry, {
        explicitVariant: normalizeVariantOrNull(runtimeData.variant),
        preferredVariant: requestedVariant
      });
      if (requiredVariant) requestedVariant = requiredVariant;

      let requestedVersion = runtimeData.version || null;

      const existing = resolveInstalledRuntime({
        userDataDir: context.userDataDir,
        line: requestedLine,
        runtimeData,
        lineConfig,
        entry
      });
      if (existing?.javaPath) {
        await ensureInstalledRosetta(existing, context);
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
        ...(requiredVariant ? { strictVariant: true } : {}),
        logger: context.logger,
        downloads: context.downloads
      });

      await ensureInstalledRosetta(installed, context);

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
      getUiServices(context).shell.showItemInFolder(status.extractedRoot);
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

      const requiredJava = Math.max(17, inspectJar(vineflowerInstall.jarPath).requiredJava || 17);
      const decompilerRuntime = await ensureDecompilerJavaRuntime(context, requiredJava);
      if (!decompilerRuntime?.javaPath || !existsFile(decompilerRuntime.javaPath)) {
        throw new Error(`A Java ${requiredJava}+ runtime is required for Vineflower.`);
      }
      await ensureInstalledRosetta(decompilerRuntime, context);

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
        signal: context.signal,
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
    resolveAutomaticLine,
    resolveRequiredLine,
    resolveRequestedLine,
    resolveInstalledRuntime,
    applyExtractionStatus,
    setRunCommandOverride: fn => {
      runCommandOverride = typeof fn === "function" ? fn : null;
    }
  }
};
