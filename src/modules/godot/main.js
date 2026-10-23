const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getUiServices } = require("../shared/ui-services");

const manifest = require("./manifest.json");
const { detectGame, detectPackVersion, detectProjectConfigVersion } = require("./detect");
const GodotRuntimeManager = require("./runtime/godot-runtime-manager");
const GdsdecompRuntime = require("./runtime/gdsdecomp-runtime");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { isAbortError } = require("../shared/runtime/download-utils");
const warnGraphics = require("../shared/graphics-warning");
const GameData = require("../shared/game-data");
const Metadata = require("./metadata");
const Pack = require("./pack");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");

const GodotCore = GodotRuntimeManager.core;
const EXTRACTED_OVERRIDE_FLAG = "extractedOverridesFromExtraction";

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

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function listDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function resolveIconCachePath(entry, userDataDir, iconPath) {
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) return null;
  const ext = path.extname(String(iconPath || "")) || ".png";
  const iconsRoot = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "godot"), "icons");
  return path.join(iconsRoot, `extracted-icon${ext}`);
}

function cacheIconForEntry(entry, userDataDir, iconPath) {
  if (!iconPath || !userDataDir) return null;
  if (!existsFile(iconPath)) return null;
  const cachePath = resolveIconCachePath(entry, userDataDir, iconPath);
  if (!cachePath) return null;
  try {
    if (path.resolve(iconPath) !== path.resolve(cachePath)) {
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

function scoreIconCandidate(filePath) {
  const base = path.basename(filePath);
  const lower = base.toLowerCase();
  let score = 0;
  if (lower === "icon.png") score += 200;
  if (lower.endsWith(".ico")) score += 120;
  if (lower.includes("icon")) score += 20;
  score -= filePath.split(path.sep).length;
  return score;
}

function resolveExtractedIconPath(extractedRoot) {
  if (!extractedRoot || !existsDir(extractedRoot)) return null;

  const entries = listDirEntries(extractedRoot);
  const rootIcon = entries.find(
    entry => entry.isFile() && entry.name && entry.name.toLowerCase() === "icon.png"
  );
  if (rootIcon) return path.join(extractedRoot, rootIcon.name);

  const rootIcos = entries
    .filter(entry => entry.isFile() && entry.name && entry.name.toLowerCase().endsWith(".ico"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rootIcos.length) return path.join(extractedRoot, rootIcos[0].name);

  const matches = [];
  const stack = [extractedRoot];
  while (stack.length) {
    const current = stack.pop();
    const currentEntries = listDirEntries(current);
    for (const entry of currentEntries) {
      if (!entry.name) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === "icon.png" || lower.endsWith(".ico")) {
        matches.push(full);
      }
    }
  }

  if (!matches.length) return null;
  matches.sort((a, b) => {
    const scoreA = scoreIconCandidate(a);
    const scoreB = scoreIconCandidate(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.localeCompare(b);
  });
  return matches[0];
}

function applyExtractedIcon(entry, { userDataDir, extractedRoot } = {}) {
  if (!userDataDir || !extractedRoot) return null;
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const cachedIcon =
    typeof moduleData.extractedIconPath === "string" && moduleData.extractedIconPath.trim()
      ? moduleData.extractedIconPath.trim()
      : null;
  if (cachedIcon && existsFile(cachedIcon)) {
    updateModuleData(entry, { [EXTRACTED_OVERRIDE_FLAG]: true });
    entry.iconPath = cachedIcon;
    entry.iconSource = "module";
    return cachedIcon;
  }
  const iconPath = resolveExtractedIconPath(extractedRoot);
  const cached = iconPath ? cacheIconForEntry(entry, userDataDir, iconPath) : null;
  if (cached) updateModuleData(entry, { [EXTRACTED_OVERRIDE_FLAG]: true });
  return cached || null;
}

async function resolveGameIcon(entry, context = {}) {
  if (entry?.iconPath && entry.iconPath !== path.join(__dirname, "resources", "icon.png") &&
      !["module", "module-default", "app", "exe"].includes(entry.iconSource)) return null;
  const metadata = Metadata.project(entry), configured = Metadata.icon(metadata) ||
    (metadata?.iconPath && /\.svg$/i.test(metadata.iconPath) ? await require("./svg-icon").prepare(metadata, entry, context) : null);
  if (configured) return configured;
  const exported = Metadata.exported(entry, {readIcons: true});
  for (const image of exported?.icons || []) {
    context.signal?.throwIfAborted();
    if (/\.svg$/i.test(image.name)) {
      const converted = await require("./svg-icon").prepareBytes(image.bytes, entry, {...context, sourceRoot: exported.root});
      if (converted) return converted;
      continue;
    }
    const Icons = require("../../core/icon-utils"), Writable = require("../shared/writable-input");
    const bytes = /\.ico$/i.test(image.name) ? Icons.extractIcoPngBuffer(image.bytes) : image.bytes;
    if (!bytes || !Icons.isSupportedImageBuffer(bytes) || !path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) continue;
    const identity = require("node:crypto").createHash("sha256").update(bytes).digest("hex"), extension = /\.webp$/i.test(image.name) ? "webp" : "png";
    const directory = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "godot"), "icons");
    const relative = path.relative(exported.root, directory);
    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) continue;
    Writable.assertOwnDirectory(context.userDataDir, directory);
    const target = path.join(directory, `export-${identity}.${extension}`);
    const cached = fs.lstatSync(target, {throwIfNoEntry: false});
    if (!cached?.isFile() || cached.isSymbolicLink() || cached.size !== bytes.length || !fs.readFileSync(target).equals(bytes)) Writable.atomicWrite(target, bytes, {root: context.userDataDir});
    return target;
  }
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const cachedIcon =
    typeof moduleData.extractedIconPath === "string" && moduleData.extractedIconPath.trim()
      ? moduleData.extractedIconPath.trim()
      : null;
  if (cachedIcon && existsFile(cachedIcon)) return cachedIcon;
  return null;
}

function resolveGameMetadata(entry) {
  const metadata = Metadata.project(entry) || Metadata.exported(entry);
  return metadata?.name ? {name: metadata.name, moduleData: {projectName: metadata.name}} : null;
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

function createGdreDetectDir(userDataDir, gameId) {
  if (!userDataDir || !gameId) return null;
  const root = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "godot"), "gdre-detect");
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

function matchesRequestedVersion(requested, candidate) {
  const req = normalizeRuntimeVersion(requested);
  if (!req) return false;
  const reqBase = normalizeBaseVersion(req);
  if (!reqBase) return false;
  const candBase = normalizeBaseVersion(candidate);
  if (!candBase || candBase !== reqBase) return false;
  if (!req.includes("-")) return true;
  return parseFlavorKind(req) === parseFlavorKind(candidate);
}

function sameVersionBucket(a, b) {
  const left = normalizeRuntimeVersion(a);
  const right = normalizeRuntimeVersion(b);
  if (!left || !right) return false;
  const baseLeft = normalizeBaseVersion(left);
  const baseRight = normalizeBaseVersion(right);
  if (!baseLeft || !baseRight || baseLeft !== baseRight) return false;
  return parseFlavorKind(left) === parseFlavorKind(right);
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
  const requestedMajor = Number.isFinite(Number(major)) && Number(major) > 0 ? Number(major) : null;

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

  if (!requested && !Number.isFinite(requestedMajor)) {
    return pickLatestVersion(installedList) || pickLatestVersion(catalogList.filter(isStableVersion)) || pickLatestVersion(catalogList);
  }
  if (!allowMajorFallback || !Number.isFinite(requestedMajor)) return null;
  const installedMatches = installedList.filter(item => parseMajor(item) === requestedMajor);
  const fromInstalled = pickLatestVersion(installedMatches);
  if (fromInstalled) return fromInstalled;
  return pickLatestVersion(catalogList.filter(item => parseMajor(item) === requestedMajor));
}

function resolveDetectedInfo(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const detectedVersionRaw = typeof moduleData.detectedVersion === "string" ? moduleData.detectedVersion : "";
  const detectedVersion = normalizeRuntimeVersion(detectedVersionRaw);
  const detectedMajor = Number(moduleData.detectedMajor);
  const parsedMajor = parseMajor(detectedVersionRaw);
  const major = Number.isFinite(detectedMajor) && detectedMajor > 0 ? detectedMajor : parsedMajor;
  return {
    detectedVersion,
    detectedMajor: Number.isFinite(major) ? major : null,
    detectedRaw: detectedVersionRaw
  };
}

function resolveLatestVersionForMajor(settings, userDataDir, major, variant) {
  if (!Number.isFinite(major)) return null;
  const state = GodotRuntimeManager.getState({ settings, userDataDir });
  const catalog = Array.isArray(state?.catalog?.versions) ? state.catalog.versions : [];
  const installed = GodotCore.listInstalled(userDataDir).filter(item => item.ready !== false && item.appPath && (!variant || item.variant === variant)).map(item => item.version);
  return selectAvailableVersion({ major, catalog, installed });
}

function resolveAvailableVersion(settings, userDataDir, version, major, options = {}) {
  const state = GodotRuntimeManager.getState({ settings, userDataDir });
  const catalog = Array.isArray(state?.catalog?.versions) ? state.catalog.versions : [];
  const installed = GodotCore.listInstalled(userDataDir).filter(item => item.ready !== false && item.appPath && (!options.variant || item.variant === options.variant)).map(item => item.version);
  return selectAvailableVersion({ version, major, catalog, installed, ...options });
}

function resolveDetectedRuntime(entry, { settings, userDataDir } = {}) {
  const detected = resolveDetectedInfo(entry);
  if (detected.detectedVersion) {
    return { version: detected.detectedVersion, major: detected.detectedMajor };
  }
  if (Number.isFinite(detected.detectedMajor)) {
    const variant = resolveRuntimeVariant(settings, entry?.runtimeData?.godot, entry);
    const version = resolveLatestVersionForMajor(settings, userDataDir, detected.detectedMajor, variant);
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

  return { version: null, major: null, source: "automatic" };
}

function resolveRuntimeVariant(settings, runtimeData, entry) {
  const cfg = GodotRuntimeManager.normalizeSettings(settings?.runtimes?.godot);
  const override = typeof runtimeData?.variant === "string" ? runtimeData.variant.trim() : "";
  const selected = GodotCore.normalizeVariant(override);
  if (selected) return selected;
  const data = entry?.moduleData;
  if (data?.packPath && !data.projectRoot) {
    const scripting = Pack.scripting(data.packPath, {offset: data.packOffset ?? 0, ...(data.packSize ? {size: data.packSize} : {})});
    if (scripting === "mono") return "mono";
  }
  return cfg.defaultVariant || GodotCore.DEFAULT_VARIANT;
}

function resolveGodotInstall(userDataDir, version, variant, major) {
  const installed = GodotCore.listInstalled(userDataDir).filter(item => item.ready !== false && item.appPath);
  if (version) {
    const exact = installed.find(item => item.version === version && item.variant === variant);
    if (exact) return exact;
    const base = normalizeBaseVersion(version);
    if (base) {
      const matches = installed.filter(
        item => item.variant === variant && matchesRequestedVersion(version, item.version)
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
    return installed.find(item => item.version === preferred) || null;
  }
  return installed[0] || null;
}

async function ensureGdreInstalled(context) {
  const install = resolveGdreInstall(context.userDataDir, context.settings);
  if (install?.cliPath) return install;
  const cfg = GodotRuntimeManager.normalizeSettings(context.settings?.runtimes?.godot);
  const readVersion = () => GodotRuntimeManager.getState({
    settings: context.settings?.runtimes?.godot, userDataDir: context.userDataDir
  }).gdsdecomp?.catalog?.versions?.[0] || null;
  let version = cfg.gdsdecomp.defaultVersion || readVersion();
  await confirmToolInstall(context, { manager: GodotRuntimeManager, label: "GDRE Tools", version,
    installOptions: { sectionId: "gdsdecomp" }, detail: "Required for Godot extraction and script tools." });
  if (!version) {
    await GodotRuntimeManager.refreshCatalog({ userDataDir: context.userDataDir, logger: context.logger,
      sectionId: "gdsdecomp" });
    context.onRuntimeStateChange?.();
    version = readVersion();
  }
  if (!version) throw new Error("No GDRE Tools releases are available.");

  const installed = await GodotRuntimeManager.installRuntime({
    userDataDir: context.userDataDir,
    version,
    logger: context.logger,
    sectionId: "gdsdecomp",
    downloads: context.downloads,
    signal: context.signal
  });

  if (installed?.version) {
    context.settings ||= {};
    if (!context.settings.runtimes) context.settings.runtimes = {};
    const current = context.settings.runtimes.godot || {};
    const updated = GodotRuntimeManager.updateSettingsAfterInstall(current, installed, {
      sectionId: "gdsdecomp"
    });
    if (updated) context.settings.runtimes.godot = updated;
  }

  context.onRuntimeStateChange?.();
  const resolved = resolveGdreInstall(context.userDataDir, context.settings);
  if (!resolved?.cliPath) throw new Error("GDRE Tools installation did not produce an executable.");
  return resolved;
}

async function pickGdreFiles(payload, context, options) {
  if (payload?.filePaths !== undefined) {
    if (
      !Array.isArray(payload.filePaths) ||
      payload.filePaths.some(filePath => typeof filePath !== "string" || !filePath.trim())
    ) {
      throw new Error("payload.filePaths must be an array of non-empty file paths.");
    }
    return { canceled: payload.filePaths.length === 0, filePaths: payload.filePaths };
  }
  return getUiServices(context).dialog.showOpenDialog(options);
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

function resolveEmbeddedPackPath(entry, userDataDir) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const sourcePath =
    typeof moduleData.packPath === "string" && moduleData.packPath.trim()
      ? moduleData.packPath.trim()
      : null;
  const packOffset = Number.isFinite(moduleData.packOffset) ? moduleData.packOffset : 0;
  const gameId = entry?.gameId;
  if (!sourcePath || !packOffset) return sourcePath;
  if (!userDataDir || !gameId) return sourcePath;

  const sourceStat = safeStat(sourcePath);
  if (!sourceStat?.isFile()) return sourcePath;
  const packSize = Number.isFinite(moduleData.packSize) && moduleData.packSize > 0
    ? moduleData.packSize
    : sourceStat.size - packOffset;
  if (!Number.isFinite(packSize) || packSize <= 0) return sourcePath;
  if (Pack.hasTrailer(sourcePath, {offset: packOffset, size: packSize})) return sourcePath;

  const packsRoot = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "godot"), "packs");
  const baseName = path.basename(sourcePath, path.extname(sourcePath)) || "game";
  // Separate from older raw slices whose directory offsets still addressed
  // the original executable rather than the standalone pack.
  const stagedPath = path.join(packsRoot, `${baseName}.standalone-v2.pck`);
  const stagedStat = safeStat(stagedPath);
  const needsRefresh =
    !stagedStat ||
    !stagedStat.isFile() ||
    stagedStat.size !== packSize ||
    stagedStat.mtimeMs < sourceStat.mtimeMs;
  if (needsRefresh) {
    Pack.project(sourcePath, stagedPath, {offset: packOffset, size: packSize}, userDataDir);
  }
  return stagedPath;
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
  const packPath = resolveEmbeddedPackPath(entry, userDataDir);
  if (typeof packPath === "string" && packPath.trim()) {
    return { kind: "pack", path: packPath.trim() };
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
  return Metadata.preserveName(existing, merged);
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = entry?.gameId;
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameModuleDir(userDataDir, gameId, "godot"));
  return true;
}

async function ensureRuntime(entry, context) {
  if ((context.runtimeId || entry.runtimeId || manifest.runtime.default) !== "godot") return null;
  const runtimeData = entry.runtimeData?.godot;
  const variant = resolveRuntimeVariant(context.settings, runtimeData, entry);
  let required = resolveRequiredRuntime(entry, context);
  if (resolveGodotInstall(context.userDataDir, required.version, variant, required.major)?.appPath) return null;

  const selectVersion = () => {
    if (required.version || Number.isFinite(required.major)) {
      return resolveAvailableVersion(context.settings, context.userDataDir, required.version, required.major,
        { allowMajorFallback: !required.version, variant });
    }
    const state = GodotRuntimeManager.getState({ settings: context.settings?.runtimes?.godot, userDataDir: context.userDataDir });
    const versions = state.catalog?.versions || [];
    return pickLatestVersion(versions.filter(isStableVersion)) || pickLatestVersion(versions);
  };
  let version = selectVersion();
  if (!version) {
    await GodotRuntimeManager.refreshCatalog({ logger: context.logger, force: true, latestOnly: false });
    context.onRuntimeStateChange?.();
    required = resolveRequiredRuntime(entry, context);
    version = selectVersion();
  }
  if (!version) {
    if (required.version) throw new Error(`Godot version ${required.version} was not found in the archive.`);
    throw new Error("No compatible Godot runtime version is available.");
  }
  if (resolveGodotInstall(context.userDataDir, version, variant, parseMajor(version))?.appPath) return null;
  return { managerId: GodotRuntimeManager.id, version, installOptions: { sectionId: "default", variant,
    ...(variant === "standard" && !GodotCore.normalizeVariant(runtimeData?.variant) ? {preserveDefaults: true} : {}) } };
}

function resolveGraphicsConfiguration(entry, context = {}) {
  if ((context.platform || process.platform) !== "darwin" || !entry?.gameId || !context.userDataDir) return null;
  const Graphics = require("./graphics");
  const root = context.graphicsRoot || require("../shared/reshade").runtimeRoot(context.app);
  if (!Graphics.resolve(root)) return null;
  const runtimeId = context.runtimeId || entry.runtimeId || manifest.runtime.default;
  let version;
  if (runtimeId === "native") {
    const pack = entry.moduleData?.packPath;
    if (!pack || !existsFile(pack) || !String(entry.nativeAppPath || entry.gamePath).toLowerCase().endsWith(".app")) return null;
    version = detectPackVersion(pack, entry.moduleData?.packOffset || 0)?.detectedVersion;
  } else if (runtimeId === "godot") {
    const required = resolveRequiredRuntime(entry, context);
    const variant = resolveRuntimeVariant(context.settings, entry.runtimeData?.godot, entry);
    const install = resolveGodotInstall(context.userDataDir, required.version, variant, required.major);
    if (!install?.appPath || !resolveExecutablePath(install.appPath)) return null;
    version = install.version;
    const source = (context.runtimeSettings?.preferExtracted && resolveExtractedProjectRoot(entry, context.userDataDir))
      || entry.moduleData?.projectRoot || entry.moduleData?.packPath;
    if (!source || !fs.existsSync(source)) return null;
  } else return null;
  if (!Graphics.supportedVersion(version)) return null;
  return { version, root };
}

function resolveGraphicsInputs(entry, context) {
  const configuration = resolveGraphicsConfiguration(entry, context);
  if (!configuration) return null;
  const provider = require("./graphics").resolve(configuration.root);
  return { cameraProjection: true, source: "godot", methods: ["fsr2", "fsr3"],
    ...(provider?.sourceResolutionAPI === 1 ? { sourceResolution: { heights: true, multipliers: [1, 1.5, 2, 3],
      methods: ["bilinear", "metalfx", "fsr1"], control: "engine",
      ...(provider.sourceResolutionLiveAPI === 1 ? {live: true} : {}) } } : {}) };
}

function prepareOptionalGraphics(context, prepare) {
  context.signal?.throwIfAborted();
  try { return prepare(); }
  catch (error) {
    if (context.signal?.aborted || isAbortError(error)) throw error;
    // Only the camera/source bridge failed. Preserve unrelated frame inputs
    // and let ordinary shared preparation retain the other selected stages.
    const inputs = { ...context.graphicsInputs };
    delete inputs.cameraProjection;
    delete inputs.methods;
    delete inputs.sourceResolution;
    if (inputs.source === "godot") delete inputs.source;
    context.graphicsInputs = inputs;
    context.graphicsBridgeFailure = { provider: "godot", reason: String(error?.message || error) };
    warnGraphics(context.logger, "Godot renderer controls could not be prepared. Using the original game target.",
      context.graphicsBridgeFailure.reason);
    return null;
  }
}

function prepareNativeLaunch(entry, context) {
  return prepareOptionalGraphics(context, () => {
    const configuration = resolveGraphicsConfiguration(entry, { ...context, runtimeId: "native" });
    if (!configuration) return null;
    const target = { kind: "pack", path: resolveEmbeddedPackPath(entry, context.userDataDir) };
    if (!target.path) return null;
    const prepared = require("./graphics").prepare(entry, { target, ...configuration, userDataDir: context.userDataDir, platform: context.platform || process.platform });
    return prepared ? { args: ["--main-pack", prepared.target.path], environment: prepared.environment } : null;
  });
}

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "godot") return null;
  const required = resolveRequiredRuntime(entry, {
    settings: context.settings,
    userDataDir: context.userDataDir
  });
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.godot : null;
  const variant = resolveRuntimeVariant(context.settings, runtimeData, entry);
  const preferExtracted = Boolean(context.runtimeSettings?.preferExtracted);

  const install = resolveGodotInstall(context.userDataDir, required.version, variant, required.major);
  if (!install || !install.appPath) {
    const suffix = required.version ? ` v${required.version}` : "";
    throw new Error(`Godot runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  let target = resolveLaunchTarget(entry, {
    preferExtracted,
    userDataDir: context.userDataDir
  });
  if (!target) throw new Error("Godot pack or project not found.");

  const executablePath = resolveExecutablePath(install.appPath);
  if (!executablePath) throw new Error("Godot runtime executable not found.");
  target = await require("./project").prepare(entry, {
    target, executable: executablePath, version: install.version,
    userDataDir: context.userDataDir, signal: context.signal,
    onToolProcessSpawn: context.onToolProcessSpawn
  });
  const mono = await require("./mono").prepare(entry, {target, install, variant,
    userDataDir: context.userDataDir, signal: context.signal,
    withRuntimeMutation: context.withRuntimeMutation});
  if (mono) target = mono.target;
  const workingDirectory = mono?.cwd || path.dirname(target.path);

  const graphics = prepareOptionalGraphics(context, () => require("./graphics").prepare(entry, {
    target, version: install.version, userDataDir: context.userDataDir,
    root: context.graphicsRoot || require("../shared/reshade").runtimeRoot(context.app),
    platform: context.platform || process.platform
  }));
  if (graphics) target = graphics.target;

  const args = [];
  if (target.kind === "project") args.push("--path", target.path);
  if (target.kind === "pack") args.push("--main-pack", target.path);
  args.push(...(context.gameArguments || []));

  context.logger?.info?.(`[runtime] launch godot ${executablePath} ${args.join(" ")}`);
  const launched = await context.spawnDetachedChecked(executablePath, args, { cwd: workingDirectory,
    ...(graphics ? { env: { ...process.env, ...graphics.environment } } : {}) });
  if (mono && launched?.child?.once) {
    const child = launched.child;let retired = false;
    const retire = () => {
      if (retired) return;retired = true;
      void require("../../core/process-lifecycle").afterProcessStop(child, () => mono.retire()).catch(() => {});
    };
    child.once("close", retire);
    if (child.exitCode != null || child.signalCode != null) retire();
  }
  return launched;
}

async function onRuntimeCrash(entry, { runtimeId, signal }, context) {
  if (runtimeId !== "godot" || signal !== "SIGTRAP") return false;
  const runtimeSettings = entry.runtimeSettings?.godot;
  if (runtimeSettings?.preferExtracted === true || !entry.moduleData?.packPath) return false;
  const { dialog } = getUiServices(context);
  const showMessage = options => context.dialogWindow
    ? dialog.showMessageBox(context.dialogWindow, options) : dialog.showMessageBox(options);
  try {
    try { await module.exports.actions.refreshExtractionStatus?.(entry, {}, context); } catch {}
    const extractedReady = Boolean(entry.moduleData?.extractedReady);
    const response = await showMessage({
      type: "error", buttons: ["Cancel", extractedReady ? "Use extracted project" : "Extract project"],
      defaultId: 1, cancelId: 0, message: "Godot exited unexpectedly (SIGTRAP).",
      detail: extractedReady ? "Launch the extracted project on the next run?"
        : "Extract the project files and prefer them on the next run?"
    });
    if (response.response !== 1) return false;
    if (!extractedReady) await module.exports.actions.gdreRecover(entry, {}, context);
    entry.runtimeSettings = {
      ...entry.runtimeSettings,
      godot: { ...runtimeSettings, preferExtracted: true }
    };
    return true;
  } catch (error) {
    context.logger?.error?.("[godot] extract prompt failed", String(error?.message || error));
    try {
      await showMessage({ type: "error", buttons: ["OK"], message: "Failed to extract the Godot project.", detail: String(error?.message || error) });
    } catch {}
    return false;
  }
}

module.exports = {
  metadataSources: ["metadata.js", "pack.js", "svg-icon.js"],
  onRuntimeCrash,
  resolveGraphicsInputs,
  prepareNativeLaunch,
  id: manifest.id,
  manifest,
  runtimeManagers: [GodotRuntimeManager],
  detectGame,
  resolveGameMetadata,
  resolveGameIcon,
  mergeEntry,
  cleanupGameData,
  ensureRuntime,
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
      const variant = resolveRuntimeVariant(context.settings, runtimeData, entry);
      const hasRequirement = Boolean(required.version) || Number.isFinite(required.major);
      const promptKey = buildPromptKey({ version: required.version, major: required.major });
      const moduleData =
        entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
      const suppressed = Boolean(promptKey && moduleData.runtimePromptSuppressedFor === promptKey);
      const resolvedVersion = hasRequirement
        ? resolveAvailableVersion(
            context.settings,
            context.userDataDir,
            required.version,
            required.major,
            { allowMajorFallback: !required.version, variant }
          ) || required.version || null
        : null;
      const install = resolveGodotInstall(
        context.userDataDir,
        required.version,
        variant,
        required.major
      );
      const installed = Boolean(install && install.appPath);
      const ready = !hasRequirement || installed || suppressed;
      return {
        graphicsInputs: resolveGraphicsInputs(entry, context),
        ready,
        installed,
        suppressed,
        requiredVersion: required.version || null,
        resolvedVersion: install?.version || resolvedVersion || null,
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
      const runtimeData = entry?.runtimeData?.godot;
      const variant = resolveRuntimeVariant(context.settings, runtimeData, entry);
      const status = payload?.status && typeof payload.status === "object" ? payload.status : null;
      let requestedVersion =
        typeof payload?.version === "string" && payload.version.trim()
          ? payload.version.trim()
          : typeof status?.requiredVersion === "string" && status.requiredVersion.trim()
            ? status.requiredVersion.trim()
            : null;
      let major = Number.isFinite(Number(payload?.major))
        ? Number(payload.major)
        : Number.isFinite(Number(status?.requiredMajor))
          ? Number(status.requiredMajor)
          : null;
      if (!requestedVersion && !Number.isFinite(major)) {
        const required = resolveRequiredRuntime(entry, {
          settings: context.settings,
          userDataDir: context.userDataDir
        });
        requestedVersion = required.version || null;
        if (Number.isFinite(required.major)) major = required.major;
      }
      let version = resolveAvailableVersion(
        context.settings,
        context.userDataDir,
        requestedVersion,
        major,
        { allowMajorFallback: !requestedVersion, variant }
      );
      if (!version) {
        const latestOnly = !requestedVersion && Number.isFinite(major);
        await GodotRuntimeManager.refreshCatalog({
          logger: context.logger,
          force: true,
          latestOnly
        });
        version = resolveAvailableVersion(
          context.settings,
          context.userDataDir,
          requestedVersion,
          major,
          { allowMajorFallback: !requestedVersion, variant }
        );
      }
      if (!version) {
        if (requestedVersion) {
          throw new Error(
            `Godot version ${requestedVersion} was not found in the archive.`
          );
        }
        throw new Error("No Godot version selected for install.");
      }

      const existing = resolveGodotInstall(
        context.userDataDir,
        version,
        variant,
        parseMajor(version)
      );
      if (existing?.appPath) {
        const runtimeVersion = normalizeRuntimeVersion(runtimeData?.version);
        const installedVersion = existing.version || version;
        if ((runtimeVersion && sameVersionBucket(runtimeVersion, installedVersion)) ||
            (!runtimeVersion && typeof payload?.version === "string" && payload.version.trim())) {
          updateRuntimeData(entry, "godot", { version: installedVersion });
        }
        updateModuleData(entry, { runtimePromptSuppressedFor: null });
        return {
          version: installedVersion,
          variant: existing.variant || variant,
          alreadyInstalled: true
        };
      }

      const installed = await GodotRuntimeManager.installRuntime({
        userDataDir: context.userDataDir,
        version,
        variant,
        logger: context.logger,
        downloads: context.downloads
      });

      const runtimeVersion = normalizeRuntimeVersion(runtimeData?.version);
      const installedVersion = installed?.version || version;
      if ((runtimeVersion && sameVersionBucket(runtimeVersion, installedVersion)) ||
            (!runtimeVersion && typeof payload?.version === "string" && payload.version.trim())) {
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
      const install = await ensureGdreInstalled(context);

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
          detectDir = createGdreDetectDir(context.userDataDir, entry?.gameId);
          if (!detectDir) throw new Error("Missing gameId for GDRE detection.");
          const args = ["--headless", `--recover=${targetPath}`, `--output=${detectDir}`];
          context.logger?.info?.(`[gdre] detect version ${install.cliPath} ${args.join(" ")}`);
          const res = await runCommandForDetection(install.cliPath, args, {
            cwd: path.dirname(targetPath),
            env: resolveGdreEnv(context.userDataDir), signal: context.signal
          });
          parsed = res.parsed || parsed;
        } catch (e) {
          if (isAbortError(e)) throw e;
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
      if (status.extractedReady) {
        applyExtractedIcon(entry, {
          userDataDir: context.userDataDir,
          extractedRoot: status.extractedRoot
        });
      }
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
      getUiServices(context).shell.showItemInFolder(status.extractedRoot);
      return { revealed: true };
    },
    gdreExtract: async (entry, _payload, context) => {
      return module.exports.actions.gdreRecover(entry, _payload, context);
    },
    gdreRecover: async (entry, _payload, context) => {
      const targetPath = resolvePackSource(entry);
      if (!targetPath) throw new Error("Godot pack or project not found.");
      const install = await ensureGdreInstalled(context);

      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      ensureDir(extractRoot);

      const args = ["--headless", `--recover=${targetPath}`, `--output=${extractRoot}`];
      context.logger?.info?.(`[gdre] recover ${install.cliPath} ${args.join(" ")}`);
      const res = await runCommand(install.cliPath, args, {
        cwd: path.dirname(targetPath),
        env: resolveGdreEnv(context.userDataDir), signal: context.signal
      });
      const parsed = parseGdreOutput(res.stdout, res.stderr);
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
      if (status.extractedReady) {
        applyExtractedIcon(entry, {
          userDataDir: context.userDataDir,
          extractedRoot: status.extractedRoot
        });
      }

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
      const targetPath = resolvePackSource(entry);
      if (!targetPath) throw new Error("Godot pack or project not found.");
      const install = await ensureGdreInstalled(context);

      const args = ["--headless", `--list-files=${targetPath}`];
      context.logger?.info?.(`[gdre] list files ${install.cliPath} ${args.join(" ")}`);

      const result = await runCommand(install.cliPath, args, {
        cwd: path.dirname(targetPath),
        env: resolveGdreEnv(context.userDataDir), signal: context.signal
      });
      const reports = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "godot"), "reports");
      ensureDir(reports);
      const reportPath = path.join(reports, "pack-files.txt");
      fs.writeFileSync(reportPath, result.stdout || result.stderr || "No files listed.\n");
      recordGdreAction(entry, {
        action: "list-files",
        status: "success",
        targetPath,
        outputPath: reportPath,
        at: Date.now()
      });
      return { listed: true, reportPath };
    },
    gdreDecompile: async (entry, payload, context) => {
      const picked = await pickGdreFiles(payload, context, {
        title: "Select GDScript bytecode files",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "GDScript bytecode", extensions: ["gdc", "gde"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      const install = await ensureGdreInstalled(context);

      const args = ["--headless"];
      for (const filePath of picked.filePaths) {
        args.push(`--decompile=${filePath}`);
      }
      context.logger?.info?.(`[gdre] decompile ${install.cliPath} ${args.join(" ")}`);
      await runCommand(install.cliPath, args, {
        cwd: path.dirname(picked.filePaths[0]),
        env: resolveGdreEnv(context.userDataDir), signal: context.signal
      });

      recordGdreAction(entry, {
        action: "decompile",
        status: "success",
        targetPath: picked.filePaths[0],
        at: Date.now()
      });

      return { decompiled: true, count: picked.filePaths.length };
    },
    gdreBinToTxt: async (entry, payload, context) => {
      const picked = await pickGdreFiles(payload, context, {
        title: "Select binary resources",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Binary resources", extensions: ["res", "scn"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      const install = await ensureGdreInstalled(context);

      const args = ["--headless"];
      for (const filePath of picked.filePaths) {
        args.push(`--bin-to-txt=${filePath}`);
      }
      context.logger?.info?.(`[gdre] bin-to-txt ${install.cliPath} ${args.join(" ")}`);
      await runCommand(install.cliPath, args, {
        cwd: path.dirname(picked.filePaths[0]),
        env: resolveGdreEnv(context.userDataDir), signal: context.signal
      });

      recordGdreAction(entry, {
        action: "bin-to-txt",
        status: "success",
        targetPath: picked.filePaths[0],
        at: Date.now()
      });

      return { converted: true, count: picked.filePaths.length };
    },
    gdreTxtToBin: async (entry, payload, context) => {
      const picked = await pickGdreFiles(payload, context, {
        title: "Select text resources",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Text resources", extensions: ["tres", "tscn"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      const install = await ensureGdreInstalled(context);

      const args = ["--headless"];
      for (const filePath of picked.filePaths) {
        args.push(`--txt-to-bin=${filePath}`);
      }
      context.logger?.info?.(`[gdre] txt-to-bin ${install.cliPath} ${args.join(" ")}`);
      await runCommand(install.cliPath, args, {
        cwd: path.dirname(picked.filePaths[0]),
        env: resolveGdreEnv(context.userDataDir), signal: context.signal
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
    resolveRuntimeVariant,
    resolveLatestVersionForMajor,
    selectAvailableVersion,
    buildPromptKey,
    recordGdreAction,
    parseGdreOutput,
    resolveLaunchTarget,
    resolveExtractedProjectRoot,
    resolveExtractedIconPath,
    applyExtractedIcon,
    resolveIconCachePath
  }
};
