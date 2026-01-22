const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { dialog, shell } = require("electron");

const manifest = require("./manifest.json");
const { detectGame, detectPackVersion, detectProjectConfigVersion } = require("./detect");
const GodotRuntimeManager = require("./runtime/godot-runtime-manager");
const GdsdecompRuntime = require("./runtime/gdsdecomp-runtime");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");

const GodotCore = GodotRuntimeManager.core;

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = applyDerivedModuleData(next);
}

function updateRuntimeData(entry, runtimeId, patch) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  const current = runtimeData[runtimeId] && typeof runtimeData[runtimeId] === "object"
    ? runtimeData[runtimeId]
    : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length === 0) {
    delete runtimeData[runtimeId];
  } else {
    runtimeData[runtimeId] = next;
  }
  entry.runtimeData = { ...runtimeData };
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
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

function resolveGdreEnv(userDataDir) {
  const base = path.join(userDataDir, "modules", "godot", "gdre-user");
  ensureDir(base);
  return {
    ...process.env,
    HOME: base,
    XDG_DATA_HOME: base,
    XDG_CONFIG_HOME: base
  };
}

function createGdreDetectDir(userDataDir) {
  const root = path.join(userDataDir, "modules", "godot", "gdre-detect");
  ensureDir(root);
  return fs.mkdtempSync(path.join(root, "detect-"));
}

function parseMajor(version) {
  const match = String(version || "").trim().match(/^(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function isPartialVersion(version) {
  return /\.x$/i.test(String(version || "").trim());
}

function normalizeRuntimeVersion(version) {
  const value = String(version || "").trim();
  if (!value) return null;
  if (isPartialVersion(value)) return null;
  return value;
}

function baseVersion(version) {
  const value = String(version || "").trim();
  if (!value) return null;
  const dash = value.indexOf("-");
  return dash === -1 ? value : value.slice(0, dash);
}

function normalizeBaseVersion(version) {
  const base = baseVersion(version);
  if (!base) return null;
  const parts = base.split(".");
  if (parts.length === 3 && parts[2] === "0") {
    return `${parts[0]}.${parts[1]}`;
  }
  return base;
}

function isStableVersion(version) {
  const lower = String(version || "").toLowerCase();
  if (lower.includes("-rc") || lower.includes("-beta") || lower.includes("-alpha") || lower.includes("-dev")) {
    return false;
  }
  return true;
}

function parseFlavorKind(version) {
  const value = String(version || "").trim();
  if (!value) return null;
  const dash = value.indexOf("-");
  if (dash === -1) return "stable";
  const raw = value.slice(dash + 1).toLowerCase();
  if (!raw) return "stable";
  if (raw === "stable") return "stable";
  if (raw.startsWith("rc")) return "rc";
  if (raw.startsWith("beta")) return "beta";
  if (raw.startsWith("alpha")) return "alpha";
  if (raw.startsWith("dev")) return "dev";
  return raw;
}

function formatDetectedLabel(moduleData) {
  const version =
    typeof moduleData?.detectedVersion === "string" ? moduleData.detectedVersion.trim() : "";
  const source =
    typeof moduleData?.detectedSource === "string" ? moduleData.detectedSource.trim() : "";
  if (version && source) return `${version} (${source})`;
  if (version) return version;
  if (source) return source;
  return null;
}

function formatGdreLabel(moduleData) {
  const installed = Boolean(moduleData?.gdreInstalled);
  const version =
    typeof moduleData?.gdreVersion === "string" ? moduleData.gdreVersion.trim() : "";
  if (installed && version) return `GDRE Tools (${version})`;
  if (installed) return "GDRE Tools (installed)";
  return "GDRE Tools (not installed)";
}

function applyDerivedModuleData(moduleData) {
  const next = moduleData && typeof moduleData === "object" ? { ...moduleData } : {};
  const detectedLabel = formatDetectedLabel(next);
  if (detectedLabel) next.detectedLabel = detectedLabel;
  else delete next.detectedLabel;
  const gdreLabel = formatGdreLabel(next);
  if (gdreLabel) next.gdreLabel = gdreLabel;
  else delete next.gdreLabel;
  return next;
}

function compareVersionsDesc(a, b) {
  return GodotCore.compareVersionsDesc(String(a || ""), String(b || ""));
}

function pickLatestVersion(versions) {
  const list = Array.isArray(versions) ? versions.filter(Boolean).slice() : [];
  if (!list.length) return null;
  list.sort(compareVersionsDesc);
  return list[0] || null;
}

function selectAvailableVersion({
  version,
  major,
  catalog,
  installed,
  allowMajorFallback = true
} = {}) {
  const catalogList = Array.isArray(catalog) ? catalog.filter(Boolean) : [];
  const installedList = Array.isArray(installed) ? installed.filter(Boolean) : [];
  const requested = normalizeRuntimeVersion(version);
  const requestedMajor = Number.isFinite(Number(major)) ? Number(major) : null;

  if (requested) {
    if (catalogList.includes(requested) || installedList.includes(requested)) {
      return requested;
    }
    const base = normalizeBaseVersion(requested);
    const wantsFlavorMatch = requested.includes("-");
    const requestedFlavor = wantsFlavorMatch ? parseFlavorKind(requested) : null;
    if (base) {
      const candidates = catalogList.concat(installedList).filter(item => {
        if (normalizeBaseVersion(item) !== base) return false;
        if (!wantsFlavorMatch) return true;
        return parseFlavorKind(item) === requestedFlavor;
      });
      const unique = Array.from(new Set(candidates));
      const selected = pickLatestVersion(unique);
      if (selected) return selected;
    }
  }

  if (!allowMajorFallback || !Number.isFinite(requestedMajor)) return null;
  const catalogMatches = catalogList.filter(item => parseMajor(item) === requestedMajor);
  const fromCatalog = pickLatestVersion(catalogMatches);
  if (fromCatalog) return fromCatalog;

  const installedMatches = installedList.filter(item => parseMajor(item) === requestedMajor);
  return pickLatestVersion(installedMatches);
}

function resolveDetectedInfo(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const detectedVersionRaw = typeof moduleData.detectedVersion === "string" ? moduleData.detectedVersion : "";
  const detectedVersion = normalizeRuntimeVersion(detectedVersionRaw);
  const detectedMajor = Number(moduleData.detectedMajor);
  const parsedMajor = parseMajor(detectedVersionRaw);
  const major = Number.isFinite(detectedMajor) ? detectedMajor : parsedMajor;
  return {
    detectedVersion,
    detectedMajor: Number.isFinite(major) ? major : null,
    detectedRaw: detectedVersionRaw
  };
}

function resolveLatestVersionForMajor(settings, userDataDir, major) {
  if (!Number.isFinite(major)) return null;
  const state = GodotRuntimeManager.getState({ settings, userDataDir });
  const catalog = Array.isArray(state?.catalog?.versions) ? state.catalog.versions : [];
  const installed = GodotCore.listInstalled(userDataDir).map(item => item.version);
  return selectAvailableVersion({ major, catalog, installed });
}

function resolveAvailableVersion(settings, userDataDir, version, major, options = {}) {
  const state = GodotRuntimeManager.getState({ settings, userDataDir });
  const catalog = Array.isArray(state?.catalog?.versions) ? state.catalog.versions : [];
  const installed = GodotCore.listInstalled(userDataDir).map(item => item.version);
  return selectAvailableVersion({ version, major, catalog, installed, ...options });
}

function resolveDetectedRuntime(entry, { settings, userDataDir } = {}) {
  const detected = resolveDetectedInfo(entry);
  if (detected.detectedVersion) {
    return { version: detected.detectedVersion, major: detected.detectedMajor };
  }
  if (Number.isFinite(detected.detectedMajor)) {
    const version = resolveLatestVersionForMajor(settings, userDataDir, detected.detectedMajor);
    return { version, major: detected.detectedMajor };
  }
  return { version: null, major: null };
}

function resolveRequiredRuntime(entry, { settings, userDataDir, ignoreRuntimeOverride } = {}) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.godot : null;
  if (!ignoreRuntimeOverride) {
    const override = normalizeRuntimeVersion(runtimeData?.version);
    if (override) {
      return { version: override, major: parseMajor(override), source: "runtime-override" };
    }
  }

  const detected = resolveDetectedRuntime(entry, { settings, userDataDir });
  if (detected.version) {
    return { version: detected.version, major: detected.major, source: "detected" };
  }
  if (Number.isFinite(detected.major)) {
    return { version: detected.version, major: detected.major, source: "detected-major" };
  }

  const cfg = GodotRuntimeManager.normalizeSettings(settings?.runtimes?.godot);
  const fallback = normalizeRuntimeVersion(cfg?.defaultVersion);
  return { version: fallback, major: parseMajor(fallback), source: "settings" };
}

function resolveRuntimeVariant(settings, runtimeData) {
  const cfg = GodotRuntimeManager.normalizeSettings(settings?.runtimes?.godot);
  const override = typeof runtimeData?.variant === "string" ? runtimeData.variant.trim() : "";
  return GodotCore.normalizeVariant(override) || cfg.defaultVariant || GodotCore.DEFAULT_VARIANT;
}

function resolveGodotInstall(userDataDir, version, variant, major) {
  const installed = GodotCore.listInstalled(userDataDir);
  if (version) {
    const exact = installed.find(item => item.version === version && item.variant === variant);
    if (exact) return exact;
    const wantsBaseMatch = !String(version).includes("-");
    const base = wantsBaseMatch ? baseVersion(version) : null;
    if (base) {
      const matches = installed.filter(
        item => item.variant === variant && baseVersion(item.version) === base
      );
      if (matches.length) {
        matches.sort((a, b) => compareVersionsDesc(a.version, b.version));
        return matches[0] || null;
      }
    }
    return null;
  }
  const matches = installed.filter(item => item.variant === variant);
  const scoped = Number.isFinite(major)
    ? matches.filter(item => parseMajor(item.version) === major)
    : matches;
  if (!scoped.length) return null;
  scoped.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return scoped[0] || null;
}

function buildPromptKey({ version, major }) {
  if (version) return `version:${version}`;
  if (Number.isFinite(major)) return `major:${major}`;
  return null;
}

function resolveGdreInstall(userDataDir, settings) {
  const cfg = GodotRuntimeManager.normalizeSettings(settings?.runtimes?.godot);
  const preferred = cfg?.gdsdecomp?.defaultVersion || null;
  const installed = GdsdecompRuntime.listInstalled(userDataDir);
  if (!installed.length) return null;
  if (preferred) {
    const match = installed.find(item => item.version === preferred);
    if (match) return match;
  }
  return installed[0] || null;
}

async function ensureGdreInstalled(context) {
  const install = resolveGdreInstall(context.userDataDir, context.settings);
  if (install?.cliPath) return install;

  const response = await dialog.showMessageBox({
    type: "question",
    buttons: ["Cancel", "Download GDRE Tools"],
    defaultId: 1,
    cancelId: 0,
    message: "GDRE Tools is required to extract this game.",
    detail: "Download the latest GDRE Tools now?"
  });
  if (response.response !== 1) {
    throw new Error("GDRE Tools is required to extract.");
  }

  await GodotRuntimeManager.refreshCatalog({
    logger: context.logger,
    force: true,
    sectionId: "gdsdecomp"
  });
  const state = GodotRuntimeManager.getState({
    settings: context.settings,
    userDataDir: context.userDataDir
  });
  const latest = Array.isArray(state?.gdsdecomp?.catalog?.versions)
    ? state.gdsdecomp.catalog.versions[0]
    : null;
  if (!latest) throw new Error("No GDRE Tools releases are available.");

  context.onRuntimeStateChange?.();
  const installed = await GodotRuntimeManager.installRuntime({
    userDataDir: context.userDataDir,
    version: latest,
    logger: context.logger,
    onProgress: () => context.onRuntimeStateChange?.(),
    sectionId: "gdsdecomp"
  });
  context.onRuntimeStateChange?.();

  if (installed?.version) {
    if (!context.settings.runtimes) context.settings.runtimes = {};
    const current = context.settings.runtimes.godot || {};
    const updated = GodotRuntimeManager.updateSettingsAfterInstall(current, installed, {
      sectionId: "gdsdecomp"
    });
    if (updated) context.settings.runtimes.godot = updated;
  }

  return resolveGdreInstall(context.userDataDir, context.settings);
}

function resolvePackSource(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.packPath === "string" && moduleData.packPath.trim()) {
    return moduleData.packPath.trim();
  }
  if (typeof moduleData.projectRoot === "string" && moduleData.projectRoot.trim()) {
    return moduleData.projectRoot.trim();
  }
  return null;
}

function resolveProjectConfigPath(rootDir) {
  if (!rootDir) return null;
  const candidates = ["project.godot", "engine.cfg"];
  for (const name of candidates) {
    const candidate = path.join(rootDir, name);
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

function resolveExtractedProjectRoot(entry, userDataDir) {
  if (!userDataDir) return null;
  const sourcePath = resolvePackSource(entry);
  if (!sourcePath) return null;
  const status = resolveExtractionStatus({ entry, userDataDir, sourcePath });
  if (!status?.extractedReady || !status.extractedRoot) return null;
  const projectConfig = resolveProjectConfigPath(status.extractedRoot);
  if (!projectConfig) return null;
  return status.extractedRoot;
}

function resolveLaunchTarget(entry, { preferExtracted, userDataDir } = {}) {
  if (preferExtracted && userDataDir) {
    const extractedRoot = resolveExtractedProjectRoot(entry, userDataDir);
    if (extractedRoot) {
      return { kind: "project", path: extractedRoot, source: "extracted" };
    }
  }
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.projectRoot === "string" && moduleData.projectRoot.trim()) {
    return { kind: "project", path: moduleData.projectRoot.trim() };
  }
  if (typeof moduleData.packPath === "string" && moduleData.packPath.trim()) {
    return { kind: "pack", path: moduleData.packPath.trim() };
  }
  return null;
}

function resolveExecutablePath(appPath) {
  if (!appPath) return null;
  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (!existsDir(macosDir)) return null;
  const name = path.basename(appPath, ".app");
  if (name) {
    const direct = path.join(macosDir, name);
    if (existsFile(direct)) return direct;
  }
  try {
    const entries = fs.readdirSync(macosDir, { withFileTypes: true });
    const file = entries.find(entry => entry.isFile());
    return file ? path.join(macosDir, file.name) : null;
  } catch {
    return null;
  }
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", data => {
      stderr += data.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (${code})`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function parseGdreOutput(stdout, stderr) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const result = {
    detectedVersion: null,
    detectedMajor: null,
    detectedBytecodeVersion: null,
    detectedBytecodeRevision: null
  };
  const enginePatterns = [
    /^Detected Engine Version:\s*(.+)$/i,
    /^Engine Version:\s*(.+)$/i,
    /^Godot Engine Version:\s*(.+)$/i,
    /^Godot Version:\s*(.+)$/i,
    /^Version:\s*(.+)$/i
  ];
  const bytecodePatterns = [
    /Detected Bytecode Revision:\s*([^()]+)\s*(?:\(([^)]+)\))?/i,
    /Bytecode Revision:\s*([^()]+)\s*(?:\(([^)]+)\))?/i,
    /Bytecode Version:\s*([^()]+)\s*(?:\(([^)]+)\))?/i
  ];
  for (const line of combined.split(/\r?\n/)) {
    if (!result.detectedVersion) {
      for (const pattern of enginePatterns) {
        const engineMatch = line.match(pattern);
        if (engineMatch && engineMatch[1]) {
          const raw = engineMatch[1].trim();
          const versionMatch = raw.match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?)/);
          const version = versionMatch ? versionMatch[1] : raw;
          result.detectedVersion = version || result.detectedVersion;
          result.detectedMajor = parseMajor(version) ?? result.detectedMajor;
          break;
        }
      }
    }
    if (!result.detectedBytecodeVersion || !result.detectedBytecodeRevision) {
      for (const pattern of bytecodePatterns) {
        const bytecodeMatch = line.match(pattern);
        if (bytecodeMatch && bytecodeMatch[1]) {
          const raw = bytecodeMatch[1].trim();
          const versionMatch = raw.match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?)/);
          if (!result.detectedBytecodeVersion) {
            result.detectedBytecodeVersion = versionMatch ? versionMatch[1] : raw;
          }
          if (!result.detectedBytecodeRevision) {
            result.detectedBytecodeRevision = bytecodeMatch[2] ? bytecodeMatch[2].trim() : null;
          }
          break;
        }
      }
    }
  }
  return result;
}

function runCommandForDetection(cmd, args, options) {
  const settleDelayMs = 200;
  const timeoutMs = 12000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let parsed = {
      detectedVersion: null,
      detectedMajor: null,
      detectedBytecodeVersion: null,
      detectedBytecodeRevision: null
    };
    let closed = false;
    let killTimer = null;
    let timeoutTimer = null;

    const updateParsed = () => {
      parsed = parseGdreOutput(stdout, stderr);
      if (parsed.detectedVersion && !killTimer) {
        killTimer = setTimeout(() => {
          if (closed) return;
          try {
            child.kill();
          } catch {}
        }, settleDelayMs);
      }
    };

    const finish = (err, code, signal) => {
      if (closed) return;
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      parsed = parseGdreOutput(stdout, stderr);
      if (err) return reject(err);
      if (code === 0 || parsed.detectedVersion) {
        return resolve({ stdout, stderr, parsed, code, signal });
      }
      const error = new Error(`${cmd} failed (${signal || code})`);
      error.stdout = stdout;
      error.stderr = stderr;
      return reject(error);
    };

    child.stdout.on("data", data => {
      stdout += data.toString("utf8");
      updateParsed();
    });
    child.stderr.on("data", data => {
      stderr += data.toString("utf8");
      updateParsed();
    });
    child.on("error", err => finish(err));
    child.on("close", (code, signal) => finish(null, code, signal));

    timeoutTimer = setTimeout(() => {
      if (closed) return;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
  });
}

function applyExtractionStatus(entry, status) {
  updateModuleData(entry, {
    extractedReady: Boolean(status?.extractedReady),
    extractedRoot: status?.extractedRoot || null,
    extractedAt: Number.isFinite(status?.extractedAt) ? status.extractedAt : null
  });
}

function recordGdreAction(entry, payload) {
  updateModuleData(entry, {
    gdreLastAction: payload?.action || null,
    gdreLastActionAt: Number.isFinite(payload?.at) ? payload.at : Date.now(),
    gdreLastActionStatus: payload?.status || null,
    gdreLastActionTarget: payload?.targetPath || null,
    gdreLastActionOutput: payload?.outputPath || null,
    gdreLastActionError: payload?.error || null
  });
}

function mergeEntry(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...incoming };
  if (existing.moduleData || incoming.moduleData) {
    merged.moduleData = {
      ...(existing.moduleData && typeof existing.moduleData === "object" ? existing.moduleData : {}),
      ...(incoming.moduleData && typeof incoming.moduleData === "object" ? incoming.moduleData : {})
    };
    merged.moduleData = applyDerivedModuleData(merged.moduleData);
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

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  if (!userDataDir) return false;
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const roots = new Set();
  const extractedRoot =
    typeof moduleData.extractedRoot === "string" && moduleData.extractedRoot.trim()
      ? moduleData.extractedRoot.trim()
      : null;
  if (extractedRoot) roots.add(extractedRoot);
  roots.add(resolveExtractionRoot({ entry, userDataDir }));
  for (const root of roots) {
    safeRm(root);
  }
  return true;
}

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "godot") return null;
  const required = resolveRequiredRuntime(entry, {
    settings: context.settings,
    userDataDir: context.userDataDir
  });
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.godot : null;
  const variant = resolveRuntimeVariant(context.settings, runtimeData);
  const preferExtracted = Boolean(context.runtimeSettings?.preferExtracted);

  const install = resolveGodotInstall(context.userDataDir, required.version, variant, required.major);
  if (!install || !install.appPath) {
    const suffix = required.version ? ` v${required.version}` : "";
    throw new Error(`Godot runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  const target = resolveLaunchTarget(entry, {
    preferExtracted,
    userDataDir: context.userDataDir
  });
  if (!target) throw new Error("Godot pack or project not found.");

  const executablePath = resolveExecutablePath(install.appPath);
  if (!executablePath) throw new Error("Godot runtime executable not found.");

  const args = [];
  if (target.kind === "project") args.push("--path", target.path);
  if (target.kind === "pack") args.push("--main-pack", target.path);

  context.logger?.info?.(`[runtime] launch godot ${executablePath} ${args.join(" ")}`);
  return context.spawnDetachedChecked(executablePath, args, { cwd: path.dirname(target.path) });
}

module.exports = {
  id: manifest.id,
  manifest,
  runtimeManagers: [GodotRuntimeManager],
  detectGame,
  mergeEntry,
  migrateEntry: entry => {
    const moduleData = applyDerivedModuleData(entry?.moduleData || {});
    return { moduleData };
  },
  onImport: (entry, context) => {
    const resolved = resolveDetectedRuntime(entry, {
      settings: context?.settings,
      userDataDir: context?.userDataDir
    });
    if (resolved?.version) {
      updateRuntimeData(entry, "godot", { version: resolved.version });
    }
  },
  cleanupGameData,
  filterRuntimeSupport: (entry, supported) => {
    const nativePath = typeof entry?.gamePath === "string" && entry.gamePath.toLowerCase().endsWith(".app");
    if (!nativePath) return supported.filter(rt => rt !== "native");
    return supported;
  },
  canLaunchRuntime: (runtimeId, entry) => {
    if (runtimeId === "native") {
      return typeof entry?.gamePath === "string" && entry.gamePath.toLowerCase().endsWith(".app");
    }
    return true;
  },
  launchRuntime,
  actions: {
    runtimeStatus: (entry, _payload, context) => {
      const required = resolveRequiredRuntime(entry, {
        settings: context.settings,
        userDataDir: context.userDataDir
      });
      const runtimeData =
        entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.godot : null;
      const variant = resolveRuntimeVariant(context.settings, runtimeData);
      const hasRequirement = Boolean(required.version) || Number.isFinite(required.major);
      const promptKey = buildPromptKey({ version: required.version, major: required.major });
      const moduleData =
        entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
      const suppressed = Boolean(promptKey && moduleData.runtimePromptSuppressedFor === promptKey);
  const install = resolveGodotInstall(context.userDataDir, required.version, variant, required.major);
      const installed = Boolean(install && install.appPath);
      const ready = !hasRequirement || installed || suppressed;
      return {
        ready,
        installed,
        suppressed,
        requiredVersion: required.version || null,
        requiredMajor: Number.isFinite(required.major) ? required.major : null,
        requiredVariant: variant || null,
        promptKey
      };
    },
    suppressRuntimePrompt: (entry, payload) => {
      const status = payload?.status && typeof payload.status === "object" ? payload.status : null;
      const promptKey =
        typeof status?.promptKey === "string" && status.promptKey.trim()
          ? status.promptKey.trim()
          : buildPromptKey({
              version: status?.requiredVersion || null,
              major: status?.requiredMajor || null
            });
      updateModuleData(entry, {
        runtimePromptSuppressedFor: promptKey || null
      });
      return { suppressedFor: promptKey || null };
    },
    installRuntime: async (entry, payload, context) => {
      const status = payload?.status && typeof payload.status === "object" ? payload.status : null;
      const requestedVersion =
        typeof payload?.version === "string" && payload.version.trim()
          ? payload.version.trim()
          : typeof status?.requiredVersion === "string" && status.requiredVersion.trim()
            ? status.requiredVersion.trim()
            : null;
      const major = Number.isFinite(Number(payload?.major))
        ? Number(payload.major)
        : Number.isFinite(Number(status?.requiredMajor))
          ? Number(status.requiredMajor)
          : null;
      let version = resolveAvailableVersion(
        context.settings,
        context.userDataDir,
        requestedVersion,
        major,
        { allowMajorFallback: !requestedVersion }
      );
      if (!version && requestedVersion) {
        await GodotRuntimeManager.refreshCatalog({
          logger: context.logger,
          force: true,
          latestOnly: false
        });
        version = resolveAvailableVersion(
          context.settings,
          context.userDataDir,
          requestedVersion,
          major,
          { allowMajorFallback: false }
        );
      }
      if (!version && !requestedVersion && Number.isFinite(major)) {
        await GodotRuntimeManager.refreshCatalog({
          logger: context.logger,
          force: true,
          latestOnly: true
        });
        version = resolveAvailableVersion(
          context.settings,
          context.userDataDir,
          requestedVersion,
          major,
          { allowMajorFallback: true }
        );
      }
      if (!version) {
        if (requestedVersion) {
          throw new Error(
            `Godot version ${requestedVersion} was not found in the archive.`
          );
        }
        throw new Error("No Godot version selected for install. Refresh the runtime catalog.");
      }

      const runtimeData =
        entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.godot : null;
      const variant = resolveRuntimeVariant(context.settings, runtimeData);
      const existing = resolveGodotInstall(
        context.userDataDir,
        version,
        variant,
        parseMajor(version)
      );
      if (existing?.appPath) {
        const runtimeVersion = normalizeRuntimeVersion(runtimeData?.version);
        const installedVersion = existing.version || version;
        if (!runtimeVersion || baseVersion(runtimeVersion) === baseVersion(installedVersion)) {
          updateRuntimeData(entry, "godot", { version: installedVersion });
        }
        updateModuleData(entry, { runtimePromptSuppressedFor: null });
        return {
          version: installedVersion,
          variant: existing.variant || variant,
          alreadyInstalled: true
        };
      }

      context.onRuntimeStateChange?.();
      const installed = await GodotRuntimeManager.installRuntime({
        userDataDir: context.userDataDir,
        version,
        variant,
        logger: context.logger,
        onProgress: () => context.onRuntimeStateChange?.()
      });
      context.onRuntimeStateChange?.();

      const runtimeVersion = normalizeRuntimeVersion(runtimeData?.version);
      const installedVersion = installed?.version || version;
      if (!runtimeVersion || baseVersion(runtimeVersion) === baseVersion(installedVersion)) {
        updateRuntimeData(entry, "godot", { version: installedVersion });
      }
      updateModuleData(entry, { runtimePromptSuppressedFor: null });

      return {
        version: installedVersion,
        variant: installed?.variant || variant
      };
    },
    downloadDetectedRuntime: async (entry, _payload, context) => {
      const detected = resolveDetectedRuntime(entry, {
        settings: context.settings,
        userDataDir: context.userDataDir
      });
      if (detected.version || Number.isFinite(detected.major)) {
        return module.exports.actions.installRuntime(
          entry,
          { version: detected.version || null, major: detected.major },
          context
        );
      }
      throw new Error("Detected version is not available.");
    },
    gdreReload: (entry, _payload, context) => {
      const gdre = module.exports.actions.refreshGdreStatus(entry, {}, context);
      const extract = module.exports.actions.refreshExtractionStatus(entry, {}, context);
      return { ...gdre, ...extract };
    },
    refreshGdreStatus: (entry, _payload, context) => {
      const install = resolveGdreInstall(context.userDataDir, context.settings);
      const installed = Boolean(install && install.cliPath);
      updateModuleData(entry, {
        gdreInstalled: installed,
        gdreVersion: install?.version || null
      });
      return {
        gdreStatusLabel: installed ? "Installed" : "Not installed",
        gdreVersion: install?.version || null
      };
    },
    gdreDetectVersion: async (entry, _payload, context) => {
      const install = resolveGdreInstall(context.userDataDir, context.settings);
      if (!install?.cliPath) throw new Error("GDRE Tools is not installed.");
      const moduleData =
        entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
      const packPath =
        typeof moduleData.packPath === "string" && moduleData.packPath.trim()
          ? moduleData.packPath.trim()
          : null;
      const packOffset = Number.isFinite(moduleData.packOffset) ? moduleData.packOffset : 0;
      const projectRoot =
        typeof moduleData.projectRoot === "string" && moduleData.projectRoot.trim()
          ? moduleData.projectRoot.trim()
          : null;
      const targetPath = packPath || projectRoot;
      if (!targetPath) throw new Error("Godot pack or project not found.");

      let parsed = {
        detectedVersion: null,
        detectedMajor: null,
        detectedBytecodeVersion: null,
        detectedBytecodeRevision: null
      };
      let gdreError = null;
      if (packPath) {
        let detectDir = null;
        try {
          detectDir = createGdreDetectDir(context.userDataDir);
          const args = ["--headless", `--recover=${targetPath}`, `--output=${detectDir}`];
          context.logger?.info?.(`[gdre] detect version ${install.cliPath} ${args.join(" ")}`);
          const res = await runCommandForDetection(install.cliPath, args, {
            cwd: path.dirname(targetPath),
            env: resolveGdreEnv(context.userDataDir)
          });
          parsed = res.parsed || parsed;
        } catch (e) {
          gdreError = e;
          context.logger?.warn?.(
            `[gdre] detect version failed: ${String(e?.message || e)}`
          );
        } finally {
          if (detectDir) safeRm(detectDir);
        }
      }
      let detected = null;
      if (parsed.detectedVersion) {
        detected = {
          detectedVersion: parsed.detectedVersion,
          detectedMajor: parsed.detectedMajor ?? null,
          detectedSource: "GDRE Tools"
        };
      } else {
        if (packPath) {
          detected = detectPackVersion(packPath, packOffset);
        } else {
          const projectConfig = projectRoot
            ? resolveProjectConfigPath(projectRoot)
            : null;
          detected = projectConfig ? detectProjectConfigVersion(projectConfig) : null;
        }
      }
      const hasDetectedVersion = Boolean(detected?.detectedVersion);
      if (hasDetectedVersion) {
        updateModuleData(entry, {
          detectedVersion: detected.detectedVersion,
          detectedMajor: detected.detectedMajor ?? null,
          detectedSource: detected.detectedSource || null
        });
      }
      if (parsed.detectedBytecodeRevision || parsed.detectedBytecodeVersion) {
        updateModuleData(entry, {
          detectedBytecodeRevision: parsed.detectedBytecodeRevision || null,
          detectedBytecodeVersion: parsed.detectedBytecodeVersion || null
        });
      }
      if (!hasDetectedVersion) {
        if (gdreError) {
          throw new Error(
            `Unable to detect Godot version (GDRE Tools failed: ${String(
              gdreError?.message || gdreError
            )}).`
          );
        }
        throw new Error("GDRE Tools did not report an engine version.");
      }

      recordGdreAction(entry, {
        action: "detect-version",
        status: "success",
        targetPath,
        at: Date.now()
      });

      return {
        detectedVersion: detected?.detectedVersion || parsed.detectedVersion || null,
        detectedBytecodeRevision: parsed.detectedBytecodeRevision || null,
        detectedBytecodeVersion: parsed.detectedBytecodeVersion || null
      };
    },
    refreshExtractionStatus: (entry, _payload, context) => {
      const sourcePath = resolvePackSource(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: sourcePath || null
      });
      applyExtractionStatus(entry, status);
      return {
        extractStatusLabel: status.extractedReady ? "Extracted" : "Not extracted",
        extractedAt: status.extractedAt || null
      };
    },
    revealExtraction: (entry, _payload, context) => {
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: resolvePackSource(entry)
      });
      if (!status.extractedRoot || !existsDir(status.extractedRoot)) {
        throw new Error("No extracted data found.");
      }
      shell.showItemInFolder(status.extractedRoot);
      return { revealed: true };
    },
    gdreExtract: async (entry, _payload, context) => {
      return module.exports.actions.gdreRecover(entry, _payload, context);
    },
    gdreRecover: async (entry, _payload, context) => {
      let install = resolveGdreInstall(context.userDataDir, context.settings);
      if (!install?.cliPath) {
        install = await ensureGdreInstalled(context);
      }
      if (!install?.cliPath) throw new Error("GDRE Tools is not installed.");
      const targetPath = resolvePackSource(entry);
      if (!targetPath) throw new Error("Godot pack or project not found.");

      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      ensureDir(extractRoot);

      const args = ["--headless", `--recover=${targetPath}`, `--output=${extractRoot}`];
      context.logger?.info?.(`[gdre] recover ${install.cliPath} ${args.join(" ")}`);
      const res = await runCommand(install.cliPath, args, {
        cwd: path.dirname(targetPath),
        env: resolveGdreEnv(context.userDataDir)
      });
      const parsed = parseGdreOutput(res.stdout, res.stderr);
      const moduleData =
        entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
      const previousDetected =
        typeof moduleData.detectedVersion === "string" ? moduleData.detectedVersion : null;
      let detected = null;
      if (parsed.detectedVersion) {
        detected = {
          detectedVersion: parsed.detectedVersion,
          detectedMajor: parsed.detectedMajor ?? parseMajor(parsed.detectedVersion),
          detectedSource: "GDRE Tools"
        };
      } else {
        const projectConfig = resolveProjectConfigPath(extractRoot);
        detected = projectConfig ? detectProjectConfigVersion(projectConfig) : null;
      }
      if (detected?.detectedVersion) {
        updateModuleData(entry, {
          detectedVersion: detected.detectedVersion,
          detectedMajor: detected.detectedMajor ?? null,
          detectedSource: detected.detectedSource || null
        });
        const runtimeData =
          entry?.runtimeData && typeof entry.runtimeData === "object"
            ? entry.runtimeData.godot
            : null;
        const runtimeVersion = normalizeRuntimeVersion(runtimeData?.version);
        if (
          !runtimeVersion ||
          (previousDetected && baseVersion(runtimeVersion) === baseVersion(previousDetected))
        ) {
          updateRuntimeData(entry, "godot", { version: detected.detectedVersion });
        }
      }
      if (parsed.detectedBytecodeRevision || parsed.detectedBytecodeVersion) {
        updateModuleData(entry, {
          detectedBytecodeRevision: parsed.detectedBytecodeRevision || null,
          detectedBytecodeVersion: parsed.detectedBytecodeVersion || null
        });
      }

      writeExtractionMeta(extractRoot, {
        sourcePath: targetPath,
        extractedAt: Date.now(),
        action: "recover"
      });

      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: targetPath
      });
      applyExtractionStatus(entry, status);

      recordGdreAction(entry, {
        action: "recover",
        status: "success",
        targetPath,
        outputPath: extractRoot,
        at: Date.now()
      });

      return {
        extractStatusLabel: status.extractedReady ? "Extracted" : "Not extracted",
        extractedAt: status.extractedAt || null,
        extractedRoot: status.extractedRoot || null
      };
    },
    gdreListFiles: async (entry, _payload, context) => {
      const install = resolveGdreInstall(context.userDataDir, context.settings);
      if (!install?.cliPath) throw new Error("GDRE Tools is not installed.");
      const targetPath = resolvePackSource(entry);
      if (!targetPath) throw new Error("Godot pack or project not found.");

      const args = ["--headless", `--list-files=${targetPath}`];
      context.logger?.info?.(`[gdre] list files ${install.cliPath} ${args.join(" ")}`);

      await runCommand(install.cliPath, args, {
        cwd: path.dirname(targetPath),
        env: resolveGdreEnv(context.userDataDir)
      });
      recordGdreAction(entry, {
        action: "list-files",
        status: "success",
        targetPath,
        at: Date.now()
      });
      return { listed: true };
    },
    gdreDecompile: async (entry, _payload, context) => {
      const install = resolveGdreInstall(context.userDataDir, context.settings);
      if (!install?.cliPath) throw new Error("GDRE Tools is not installed.");

      const picked = await dialog.showOpenDialog({
        title: "Select GDScript bytecode files",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "GDScript bytecode", extensions: ["gdc", "gde"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };

      const args = ["--headless"];
      for (const filePath of picked.filePaths) {
        args.push(`--decompile=${filePath}`);
      }
      context.logger?.info?.(`[gdre] decompile ${install.cliPath} ${args.join(" ")}`);
      await runCommand(install.cliPath, args, {
        cwd: path.dirname(picked.filePaths[0]),
        env: resolveGdreEnv(context.userDataDir)
      });

      recordGdreAction(entry, {
        action: "decompile",
        status: "success",
        targetPath: picked.filePaths[0],
        at: Date.now()
      });

      return { decompiled: true, count: picked.filePaths.length };
    },
    gdreBinToTxt: async (entry, _payload, context) => {
      const install = resolveGdreInstall(context.userDataDir, context.settings);
      if (!install?.cliPath) throw new Error("GDRE Tools is not installed.");

      const picked = await dialog.showOpenDialog({
        title: "Select binary resources",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Binary resources", extensions: ["res", "scn"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };

      const args = ["--headless"];
      for (const filePath of picked.filePaths) {
        args.push(`--bin-to-txt=${filePath}`);
      }
      context.logger?.info?.(`[gdre] bin-to-txt ${install.cliPath} ${args.join(" ")}`);
      await runCommand(install.cliPath, args, {
        cwd: path.dirname(picked.filePaths[0]),
        env: resolveGdreEnv(context.userDataDir)
      });

      recordGdreAction(entry, {
        action: "bin-to-txt",
        status: "success",
        targetPath: picked.filePaths[0],
        at: Date.now()
      });

      return { converted: true, count: picked.filePaths.length };
    },
    gdreTxtToBin: async (entry, _payload, context) => {
      const install = resolveGdreInstall(context.userDataDir, context.settings);
      if (!install?.cliPath) throw new Error("GDRE Tools is not installed.");

      const picked = await dialog.showOpenDialog({
        title: "Select text resources",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Text resources", extensions: ["tres", "tscn"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };

      const args = ["--headless"];
      for (const filePath of picked.filePaths) {
        args.push(`--txt-to-bin=${filePath}`);
      }
      context.logger?.info?.(`[gdre] txt-to-bin ${install.cliPath} ${args.join(" ")}`);
      await runCommand(install.cliPath, args, {
        cwd: path.dirname(picked.filePaths[0]),
        env: resolveGdreEnv(context.userDataDir)
      });

      recordGdreAction(entry, {
        action: "txt-to-bin",
        status: "success",
        targetPath: picked.filePaths[0],
        at: Date.now()
      });

      return { converted: true, count: picked.filePaths.length };
    },
    removeExtraction: (entry, _payload, context) => {
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      applyExtractionStatus(entry, { extractedReady: false, extractedRoot: null, extractedAt: null });
      return { extractStatusLabel: "Not extracted", extractedAt: null };
    }
  },
  __test: {
    resolveDetectedRuntime,
    resolveRequiredRuntime,
    resolveLatestVersionForMajor,
    selectAvailableVersion,
    buildPromptKey,
    recordGdreAction,
    parseGdreOutput,
    resolveLaunchTarget,
    resolveExtractedProjectRoot
  }
};
