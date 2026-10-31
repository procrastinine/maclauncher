const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
const JavaCore = require("./java-runtime");
const fs = require("node:fs");
const path = require("node:path");
const Custom = require("../../shared/runtime/custom-runtime");
const VineflowerCore = require("./vineflower-runtime");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");
const Architecture = require("../../shared/runtime/architecture");

const DEFAULT_LINE = 21;
const SECTION_VINEFLOWER = "vineflower";
// Every Java feature release outside the LTS lines, including future ones.
const SECTION_OTHER = "other";
const LINE_SECTIONS = [...JavaCore.LTS_LINES.map(String), SECTION_OTHER];
const IDLE = Object.freeze({ status: "idle", versions: [], entriesByVersion: {}, fetchedAt: null, source: null, error: null });

const lineCatalogPromises = new Map();
const lineCatalogPromiseModes = new Map();
const lineCatalogStates = new Map();
for (const line of JavaCore.LTS_LINES) lineCatalogStates.set(line, { ...IDLE });
// The other feature releases Adoptium lists, from its release index.
let otherCatalog = { status: "idle", lines: [], fetchedAt: null, error: null };
let otherCatalogPromise = null;

function sectionIdForLine(line) {
  return JavaCore.isLtsLine(line) ? String(Number(line)) : SECTION_OTHER;
}
function otherLines(userDataDir) {
  const installed = userDataDir ? JavaCore.listInstalled(userDataDir).map(row => row.line) : [];
  return [...new Set([...otherCatalog.lines, ...lineCatalogStates.keys(), ...installed])].filter(line => !JavaCore.isLtsLine(line)).sort((a, b) => b - a);
}
// The Other section's catalog: every non-LTS line read this session.
function otherCatalogState() {
  const states = [...lineCatalogStates].filter(([line]) => !JavaCore.isLtsLine(line)).map(([, state]) => state);
  const versions = states.flatMap(state => state.versions || []).sort(JavaCore.compareVersionsDesc);
  const fetched = states.map(state => state.fetchedAt).filter(Number.isFinite);
  return { status: otherCatalog.status !== "idle" ? otherCatalog.status : states.some(state => state.status === "success") ? "success" : "idle",
    versions, entriesByVersion: Object.assign({}, ...states.map(state => state.entriesByVersion || {})),
    fetchedAt: otherCatalog.fetchedAt || (fetched.length ? Math.max(...fetched) : null), source: null, error: otherCatalog.error, mode: "all" };
}

let vineflowerCatalogPromise = null;
let vineflowerCatalogState = {
  status: "idle",
  versions: [],
  releasesByVersion: {},
  fetchedAt: null,
  source: null,
  error: null
};

function normalizeLineInput(input, fallback = DEFAULT_LINE) {
  const value = Number(input);
  if (Number.isInteger(value) && value > 0 && value <= 999) return value;
  return fallback;
}

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const defaultLine = src.defaultLine != null && normalizeLineInput(src.defaultLine, null) ? Number(src.defaultLine) : null;
  const lines = Object.fromEntries([...JavaCore.LTS_LINES, SECTION_OTHER].map(line => [line, {
    defaultVersion: typeof src.lines?.[line]?.defaultVersion === "string" && src.lines?.[line]?.defaultVersion.trim() !== "auto" ? src.lines?.[line]?.defaultVersion.trim() || null : null,
    defaultVariant: src.lines?.[line]?.defaultVariant ? JavaCore.normalizeVariant(src.lines[line].defaultVariant) : JavaCore.defaultVariantForHost()
  }]));

  const vineflowerSrc =
    src.vineflower && typeof src.vineflower === "object" ? src.vineflower : {};
  let vineflowerDefaultVersion = null;
  if (
    typeof vineflowerSrc.defaultVersion === "string" &&
    vineflowerSrc.defaultVersion.trim()
  ) {
    try {
      vineflowerDefaultVersion = VineflowerCore.normalizeVersion(vineflowerSrc.defaultVersion.trim());
    } catch {
      vineflowerDefaultVersion = null;
    }
  }

  return {
    defaultLine,
    lines,
    vineflower: {
      defaultVersion: vineflowerDefaultVersion
    }
  };
}

function resolveSectionId(sectionId) {
  const section = String(sectionId || "").trim().toLowerCase();
  if (section === SECTION_VINEFLOWER || section === SECTION_OTHER) return section;
  if (normalizeLineInput(section, null)) return sectionIdForLine(section);
  return String(DEFAULT_LINE);
}

function sectionLine(sectionId) {
  const resolved = resolveSectionId(sectionId);
  if (resolved === SECTION_VINEFLOWER || resolved === SECTION_OTHER) return null;
  return Number(resolved);
}

function ttlValid(fetchedAt, ttlMs) {
  if (!Number.isFinite(fetchedAt)) return false;
  return Date.now() - fetchedAt < ttlMs;
}

async function refreshLineCatalog({ line, logger, force, latestOnly } = {}) {
  const runtimeLine = normalizeLineInput(line, DEFAULT_LINE);
  const existing = lineCatalogStates.get(runtimeLine) || { ...IDLE };
  const ttlMs = 1000 * 60 * 60 * 6;
  const mode = latestOnly === true ? "latest" : "all";
  if (!force && existing.status === "success" && existing.mode === mode &&
      ttlValid(existing.fetchedAt, ttlMs)) return existing;
  if (lineCatalogPromises.has(runtimeLine)) {
    if (lineCatalogPromiseModes.get(runtimeLine) === mode) return lineCatalogPromises.get(runtimeLine);
    await lineCatalogPromises.get(runtimeLine).catch(() => {});
    return refreshLineCatalog({ line: runtimeLine, logger, force, latestOnly });
  }

  lineCatalogStates.set(runtimeLine, {
    ...existing,
    status: "loading",
    error: null
  });

  lineCatalogPromiseModes.set(runtimeLine, mode);
  const promise = (async () => {
    try {
      const res = await JavaCore.fetchAvailableVersionsForLine({
        line: runtimeLine,
        logger,
        latestOnly: latestOnly === true
      });
      const next = {
        status: "success",
        versions: res.versions || [],
        entriesByVersion: res.entriesByVersion || {},
        fetchedAt: Date.now(),
        source: res.source || null,
        mode,
        error: null
      };
      lineCatalogStates.set(runtimeLine, next);
      return next;
    } catch (err) {
      const next = {
        ...existing,
        status: "error",
        error: String(err?.message || err)
      };
      lineCatalogStates.set(runtimeLine, next);
      throw err;
    } finally {
      lineCatalogPromises.delete(runtimeLine);
      lineCatalogPromiseModes.delete(runtimeLine);
    }
  })();

  lineCatalogPromises.set(runtimeLine, promise);
  return promise;
}

async function refreshVineflowerCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  if (!force && vineflowerCatalogState.status === "success" && ttlValid(vineflowerCatalogState.fetchedAt, ttlMs)) {
    return vineflowerCatalogState;
  }
  if (vineflowerCatalogPromise) return vineflowerCatalogPromise;

  const existing = vineflowerCatalogState;
  vineflowerCatalogState = {
    ...existing,
    status: "loading",
    error: null
  };

  vineflowerCatalogPromise = (async () => {
    try {
      const res = await VineflowerCore.fetchAvailableVersions({ logger });
      vineflowerCatalogState = {
        status: "success",
        versions: res.versions || [],
        releasesByVersion: res.releasesByVersion || {},
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null
      };
      return vineflowerCatalogState;
    } catch (err) {
      vineflowerCatalogState = {
        ...existing,
        status: "error",
        error: String(err?.message || err)
      };
      throw err;
    } finally {
      vineflowerCatalogPromise = null;
    }
  })();

  return vineflowerCatalogPromise;
}

// Other lists every non-LTS feature release in Adoptium's release index.
async function refreshOtherCatalog({ logger, force } = {}) {
  if (otherCatalogPromise) return otherCatalogPromise;
  const previous = otherCatalog;
  otherCatalog = { ...otherCatalog, status: "loading", error: null };
  otherCatalogPromise = (async () => {
    try {
      const { lines } = await JavaCore.fetchAvailableLines({ logger });
      const other = lines.filter(line => !JavaCore.isLtsLine(line));
      const results = await Promise.allSettled(other.map(line => refreshLineCatalog({ line, logger, force })));
      const failure = results.find(result => result.status === "rejected");
      if (failure && results.every(result => result.status === "rejected")) throw failure.reason;
      otherCatalog = { status: "success", lines: other, fetchedAt: Date.now(), error: null };
      return otherCatalogState();
    } catch (error) {
      otherCatalog = { ...previous, status: "error", error: String(error?.message || error) };
      throw error;
    } finally {
      otherCatalogPromise = null;
    }
  })();
  return otherCatalogPromise;
}

async function refreshCatalog({ logger, force, sectionId, line, latestOnly } = {}) {
  const section = String(sectionId || "").trim().toLowerCase();
  if (section === SECTION_VINEFLOWER) {
    return refreshVineflowerCatalog({ logger, force });
  }
  // Play refreshes only the line it needs; the Other section's Reload reads them all.
  if (section === SECTION_OTHER) return line ? refreshLineCatalog({ line: normalizeLineInput(line, DEFAULT_LINE), logger, force })
    : refreshOtherCatalog({ logger, force });
  return refreshLineCatalog({ line: normalizeLineInput(section, DEFAULT_LINE), logger, force, latestOnly });
}

function newestInstalled(installed, compareDesc) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = compareDesc(String(a?.version || ""), String(b?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

function buildLineNotice(line, hostAvailability) {
  if (require("../../shared/runtime/host-capabilities").getHostCapabilities().hardwareArch !== "arm64") return null;
  if (Number(line) === 8) {
    if (hostAvailability?.mode === "rosetta") {
      return {
        title: "Java 8 on Apple Silicon",
        lines: [
          { text: "Java 8 installs use Intel (x64) builds and require Rosetta." },
          { text: "Rosetta installation is offered when this build starts." }
        ]
      };
    }
    if (hostAvailability?.mode === "unavailable") {
      return {
        title: "Java 8 availability",
        lines: [{ text: "No compatible Java 8 build is available for this host." }]
      };
    }
  }
  return null;
}

function summarizeHostAvailability(entryAssets) {
  const available = new Set();
  if (entryAssets?.arm64) available.add("arm64");
  if (entryAssets?.x64) available.add("x64");
  const choice = JavaCore.__test.chooseVariantForHost({
    availableVariants: available,
    preferredVariant: null,
    hostArch: Architecture.selectedArchitecture()
  });
  if (!choice) {
    return {
      nativeAvailable: false,
      rosettaFallback: false,
      unavailable: true,
      mode: "unavailable"
    };
  }
  return {
    nativeAvailable: !choice.requiresRosetta,
    rosettaFallback: Boolean(choice.requiresRosetta),
    unavailable: false,
    mode: choice.requiresRosetta ? "rosetta" : "native"
  };
}

function addCatalogVariants(variants, entryAssets) {
  if (entryAssets?.arm64) variants.add("arm64");
  if (entryAssets?.x64) variants.add("x64");
}

function collectLineVariantSet(catalogState, installed) {
  const variants = new Set();
  const entriesByVersion =
    catalogState?.entriesByVersion && typeof catalogState.entriesByVersion === "object"
      ? catalogState.entriesByVersion
      : {};
  for (const entryAssets of Object.values(entriesByVersion)) {
    addCatalogVariants(variants, entryAssets);
  }
  for (const item of Array.isArray(installed) ? installed : []) {
    const normalized = JavaCore.normalizeVariant(item?.variant);
    if (normalized) variants.add(normalized);
  }
  return variants;
}

function orderLineVariants(variants) {
  const out = [];
  for (const variant of JavaCore.VARIANTS) {
    if (variants.has(variant.id)) out.push(variant.id);
  }
  return out;
}

function resolveDefaultVariantForLine(variants, preferredVariant) {
  const choice = JavaCore.__test.chooseVariantForHost({
    availableVariants: variants,
    preferredVariant,
    hostArch: Architecture.selectedArchitecture()
  });
  if (choice?.variant) return choice.variant;
  const ordered = orderLineVariants(variants);
  if (ordered[0]) return ordered[0];
  return JavaCore.defaultVariantForHost();
}

// One line's state, or with `line` "other" the Other section's.
function buildLineState(cfg, userDataDir, line) {
  const other = line === SECTION_OTHER;
  const runtimeLine = other ? SECTION_OTHER : normalizeLineInput(line, DEFAULT_LINE);
  const lineCfg = cfg.lines[sectionIdForLine(runtimeLine)] || cfg.lines[runtimeLine] || {
    defaultVersion: null,
    defaultVariant: JavaCore.defaultVariantForHost()
  };
  const installed = (other ? otherLines(userDataDir) : [runtimeLine]).flatMap(item => JavaCore.listInstalled(userDataDir, item))
    .map(row => Architecture.tagInstall(row, row.variant));
  const catalogState = other ? otherCatalogState() : lineCatalogStates.get(runtimeLine) || { ...IDLE };
  const latestInstalled = newestInstalled(installed, JavaCore.compareVersionsDesc);
  const latestAvailable = Array.isArray(catalogState.versions)
    ? catalogState.versions[0] || null
    : null;

  const variants = collectLineVariantSet(catalogState, installed);
  if (variants.size === 0) {
    variants.add(
      JavaCore.normalizeVariant(lineCfg.defaultVariant) || JavaCore.defaultVariantForHost()
    );
  }
  const orderedVariantIds = orderLineVariants(variants);
  const sectionVariants = JavaCore.VARIANTS.filter(variant =>
    orderedVariantIds.includes(variant.id)
  );
  const resolvedDefaultVariant = resolveDefaultVariantForLine(
    variants,
    lineCfg.defaultVariant
  );

  const availabilityByVersion = {};
  for (const version of catalogState.versions || []) {
    availabilityByVersion[version] = summarizeHostAvailability(
      catalogState.entriesByVersion?.[version]
    );
  }

  const defaultAvailability = lineCfg.defaultVersion
    ? availabilityByVersion[lineCfg.defaultVersion] ||
      summarizeHostAvailability(catalogState.entriesByVersion?.[lineCfg.defaultVersion])
    : latestAvailable
      ? availabilityByVersion[latestAvailable] ||
        summarizeHostAvailability(catalogState.entriesByVersion?.[latestAvailable])
      : {
          nativeAvailable: false,
          rosettaFallback: false,
          unavailable: false,
          mode: "unknown"
        };

  const state = {
    line: runtimeLine,
    launcherArchitecture: Architecture.defaultArchitecture(),
    defaultArchitecture: resolvedDefaultVariant,
    architectureVariants: true,
    supportsDefault: true,
    defaultVersion: selectRuntimeVersion({ defaultVersion: lineCfg.defaultVersion, fallback: managerDefaultVersion({
      listed: (catalogState.versions || []).filter(version => availabilityByVersion[version]?.unavailable !== true),
      installed: installed.filter(row => row.ready !== false && (!resolvedDefaultVariant || row.variant === resolvedDefaultVariant)).sort((a,b) => JavaCore.compareVersionsDesc(a.version,b.version)).map(row => row.version) }) }).version,
    defaultSource: lineCfg.defaultVersion ? "saved" : "manager",
    defaultVariant: resolvedDefaultVariant,
    installed,
    installing: null,
    variants: sectionVariants,
    availabilityByVersion,
    availability: defaultAvailability,
    notice: buildLineNotice(runtimeLine, defaultAvailability),
    catalog: {
      status: catalogState.status,
      versions: catalogState.versions,
      fetchedAt: catalogState.fetchedAt,
      source: other ? "https://adoptium.net/temurin/releases/" : `https://github.com/adoptium/temurin${runtimeLine}-binaries/releases`,
      error: catalogState.error,
      mode: catalogState.mode || null,
      supportsLatestOnly: false,
      installableVersions: (catalogState.versions || []).filter(version =>
        availabilityByVersion[version]?.unavailable !== true
      ),
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && latestInstalled?.version
          ? JavaCore.compareVersions(String(latestAvailable), String(latestInstalled.version)) > 0
          : false
    }
  };
  state.catalog.architecture = Architecture.defaultArchitecture();
  state.catalog.architectureCatalogs = Object.fromEntries(["arm64", "x64"].map(architecture => {
    // Each CPU's list declares the CPU of its builds, as every runtime catalog does.
    const versions = (catalogState.versions || []).filter(version => catalogState.entriesByVersion?.[version]?.[architecture]);
    return [architecture, {...state.catalog, architecture, versions, installableVersions: versions,
      versionRequirements: Object.fromEntries(versions.map(version => [version, {architecture}]))}];
  }));
  return state;
}

function buildVineflowerState(cfg, userDataDir) {
  const installed = VineflowerCore.listInstalled(userDataDir);
  const latestInstalled = newestInstalled(installed, VineflowerCore.compareVersionsDesc);
  const latestAvailable = Array.isArray(vineflowerCatalogState.versions)
    ? vineflowerCatalogState.versions[0] || null
    : null;

  return {
    supportsDefault: true,
    defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.vineflower.defaultVersion, fallback: managerDefaultVersion({
      listed: vineflowerCatalogState.versions, installed: installed.filter(row => row.ready !== false).sort((a,b) => VineflowerCore.compareVersionsDesc(a.version,b.version)).map(row => row.version) }) }).version,
    defaultSource: cfg.vineflower.defaultVersion ? "saved" : "manager",
    installed,
    installing: null,
    variants: [],
    catalog: {
      status: vineflowerCatalogState.status,
      versions: vineflowerCatalogState.versions,
      fetchedAt: vineflowerCatalogState.fetchedAt,
      source: vineflowerCatalogState.source || "https://github.com/Vineflower/vineflower/releases",
      error: vineflowerCatalogState.error,
      supportsLatestOnly: false,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && cfg?.vineflower?.defaultVersion
          ? VineflowerCore.compareVersions(
              String(latestAvailable),
              String(cfg.vineflower.defaultVersion)
            ) > 0
          : false
    }
  };
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const lineStates = [...JavaCore.LTS_LINES, SECTION_OTHER].map(line => ({
    id: String(line),
    label: line === SECTION_OTHER ? "Other" : `Java ${line}`,
    ...buildLineState(cfg, userDataDir, line)
  }));

  const vineflower = buildVineflowerState(cfg, userDataDir);
  const selectionLines = [...new Set([...otherLines(userDataDir), cfg.defaultLine, ...Object.keys(cfg.lines).map(Number)])]
    .filter(line => Number.isInteger(line) && line > 0 && !JavaCore.isLtsLine(line));

  return {
    defaultLine: cfg.defaultLine,
    lines: Object.fromEntries(lineStates.map(state => [state.line, state])),
    selectionSections: Object.fromEntries(selectionLines.map(line => [String(line), {
      id: String(line), label: `Java ${line}`, ...buildLineState(cfg, userDataDir, line)
    }])),
    selectionSectionTemplate: { sectionId: SECTION_OTHER, versionSectionBy: "major", label: "Java {section}" },
    vineflower,
    sections: [...lineStates, { id: SECTION_VINEFLOWER, label: "Vineflower", ...vineflower }]
  };
}

function resolveRequestedVersion(version) {
  if (typeof version !== "string" || !version.trim()) return null;
  return JavaCore.normalizeVersion(version.trim());
}

function resolveRequestedVariant(variant) {
  const normalized = JavaCore.normalizeVariant(variant);
  return normalized || null;
}

async function installLineRuntime({
  userDataDir,
  line,
  version,
  variant,
  architecture,
  logger,
  onProgress,
  downloads,
  signal,
  forceCatalog,
  strictVariant = false
} = {}) {
  const runtimeLine = normalizeLineInput(line, DEFAULT_LINE);
  const lineState = lineCatalogStates.get(runtimeLine);
  if (forceCatalog || !lineState || lineState.status === "idle") {
    await refreshLineCatalog({ line: runtimeLine, logger, force: true });
  }
  const catalog = lineCatalogStates.get(runtimeLine);
  const requestedVersion = version ? resolveRequestedVersion(version) : null;
  const requestedVariant = resolveRequestedVariant(variant);

  if (!requestedVersion && !(catalog?.versions?.length > 0)) {
    await refreshLineCatalog({ line: runtimeLine, logger, force: true });
  }

  const selected = JavaCore.selectCatalogAsset({
    lineCatalog: lineCatalogStates.get(runtimeLine),
    version: requestedVersion,
    variant: architecture || requestedVariant,
    hostArch: architecture || Architecture.selectedArchitecture(),
    strictVariant
  });
  if (!selected?.version) {
    throw new Error(`No installable Java runtime found for line ${runtimeLine}.`);
  }

  const meta = buildRuntimeDownloadMeta({
    label: `Java ${runtimeLine}`,
    managerId: "java",
    sectionId: String(runtimeLine),
    version: selected.version,
    variant: selected.variant
  });

  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      JavaCore.installVersion({
        userDataDir,
        line: runtimeLine,
        version: selected.version,
        variant: selected.variant,
        hostArch: architecture || Architecture.selectedArchitecture(),
        logger,
        onProgress: taskProgress,
        signal: taskSignal && signal ? AbortSignal.any([taskSignal, signal]) : taskSignal || signal,
        lineCatalog: lineCatalogStates.get(runtimeLine),
        strictVariant
      }),
    { onProgress }
  );
}

async function installVineflowerRuntime({
  userDataDir,
  version,
  logger,
  onProgress,
  downloads,
  signal
} = {}) {
  const requestedVersion =
    typeof version === "string" && version.trim()
      ? VineflowerCore.normalizeVersion(version.trim())
      : null;

  if (!requestedVersion && (!vineflowerCatalogState.versions || vineflowerCatalogState.versions.length === 0)) {
    await refreshVineflowerCatalog({ logger, force: true });
  }

  const targetVersion =
    requestedVersion ||
    (Array.isArray(vineflowerCatalogState.versions) ? vineflowerCatalogState.versions[0] : null);
  if (!targetVersion) {
    throw new Error("No Vineflower version available for install.");
  }

  const meta = buildRuntimeDownloadMeta({
    label: "Vineflower",
    managerId: "java",
    sectionId: SECTION_VINEFLOWER,
    version: targetVersion
  });

  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      VineflowerCore.installVersion({
        userDataDir,
        version: targetVersion,
        logger,
        onProgress: taskProgress,
        signal: taskSignal && signal ? AbortSignal.any([taskSignal, signal]) : taskSignal || signal,
        releasesByVersion: vineflowerCatalogState.releasesByVersion
      }),
    { onProgress }
  );
}

async function installRuntime({
  userDataDir,
  version,
  variant,
  architecture,
  logger,
  onProgress,
  sectionId,
  line,
  downloads,
  signal,
  strictVariant = false
} = {}) {
  const section = resolveSectionId(sectionId || line);
  if (section === SECTION_VINEFLOWER) {
    return installVineflowerRuntime({
      userDataDir,
      version,
      logger,
      onProgress,
      downloads,
      signal
    });
  }

  // An Other version installs into its own major line.
  let runtimeLine = normalizeLineInput(line, null) || normalizeLineInput(sectionId, null) ||
    (section === SECTION_OTHER && version ? JavaCore.versionMajor(version) : null);
  if (!runtimeLine && section === SECTION_OTHER) {
    await refreshOtherCatalog({ logger, force: true });
    runtimeLine = JavaCore.versionMajor(otherCatalogState().versions[0] || "") || null;
    if (!runtimeLine) throw new Error("Adoptium lists no other Java versions for this Mac.");
  }
  runtimeLine ||= normalizeLineInput(section, DEFAULT_LINE);
  return installLineRuntime({
    userDataDir,
    line: runtimeLine,
    version,
    variant,
    architecture,
    strictVariant,
    logger,
    onProgress,
    downloads,
    signal
  });
}

function uninstallRuntime({ userDataDir, version, variant, installDir, sectionId, line }) {
  const section = resolveSectionId(sectionId || line);
  if (section === SECTION_VINEFLOWER) {
    return VineflowerCore.uninstallVersion({ userDataDir, version, installDir });
  }
  const runtimeLine = normalizeLineInput(line, null) || normalizeLineInput(sectionId, null) ||
    (section === SECTION_OTHER && version ? JavaCore.versionMajor(version) : null) || normalizeLineInput(section, DEFAULT_LINE);
  return JavaCore.uninstallVersion({
    userDataDir,
    line: runtimeLine,
    version,
    variant,
    installDir
  });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  if (!installed) return settings;
  // A game's ABI prerequisite does not change other games' chosen JVM line/CPU.
  if (payload?.preserveDefaults === true) return settings;
  const section = resolveSectionId(payload?.sectionId || payload?.line);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  const normalized = normalizeSettings(next);

  if (section === SECTION_VINEFLOWER) {
    const current = normalized.vineflower.defaultVersion;
    if (
      installed.version &&
      !current
    ) {
      next.vineflower = {
        ...(next.vineflower && typeof next.vineflower === "object" ? next.vineflower : {}),
        defaultVersion: installed.version
      };
    }
    return next;
  }

  const line = sectionLine(section), key = line || (section === SECTION_OTHER ? SECTION_OTHER : null);
  if (key && installed.version && !normalized.lines[key]?.defaultVersion) {
    next.lines = { ...next.lines, [key]: { ...normalized.lines[key], defaultVersion: installed.version,
      defaultVariant: installed.variant || normalized.lines[key].defaultVariant } };
    if (line && !normalized.defaultLine) next.defaultLine = line;
    return next;
  }
  return settings;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  if (!userDataDir) return settings;
  const section = resolveSectionId(payload?.sectionId || payload?.line);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  const normalized = normalizeSettings(next);

  if (section === SECTION_VINEFLOWER) {
    const installed = VineflowerCore.listInstalled(userDataDir);
    const hasDefault = installed.some(
      entry => entry.version === normalized.vineflower.defaultVersion
    );
    if (hasDefault) return settings;
    const latest = newestInstalled(installed, VineflowerCore.compareVersionsDesc);
    next.vineflower = {
      ...(next.vineflower && typeof next.vineflower === "object" ? next.vineflower : {}),
      defaultVersion: latest?.version || null
    };
    return next;
  }

  return settings;
}

module.exports = {
  id: "java",
  label: "Temurin",
  // Each Java line is its own section; a newer patch runs that line's games.
  installSetsDefault: true,
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    const section = resolveSectionId(payload?.sectionId || payload?.line);
    if (section === SECTION_VINEFLOWER) {
      next.vineflower = {
        ...(next.vineflower && typeof next.vineflower === "object" ? next.vineflower : {}),
        defaultVersion:
          typeof payload?.version === "string" && payload.version.trim()
            ? VineflowerCore.normalizeVersion(payload.version.trim())
            : null
      };
      return next;
    }

    const line = section === SECTION_OTHER ? SECTION_OTHER : normalizeLineInput(section, DEFAULT_LINE);
    return { ...next, lines: { ...next.lines, [line]: { ...next.lines?.[line],
      ...(payload?.architecture || payload?.variant ? {defaultVariant: JavaCore.normalizeVariant(payload.architecture || payload.variant)} : {}),
      defaultVersion: payload?.version && payload.version !== "auto" ? JavaCore.normalizeVersion(payload.version) : null } } };
  },
  refreshCatalog,
  delivery: { catalog: "remote", included: "none", sourceBuild: false },
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  sectionIdForLine,
  // One line's state; an Other line's lists only its own versions.
  lineState: ({ settings, userDataDir, line }) => buildLineState(normalizeSettings(settings), userDataDir, line),
  upstream: [JavaCore.upstream, VineflowerCore.source],
  core: {
    java: JavaCore,
    vineflower: VineflowerCore
  },
  __test: {
    resolveSectionId,
    sectionLine,
    summarizeHostAvailability,
    collectLineVariantSet,
    resolveDefaultVariantForLine
  }
};

Custom.configure(module.exports, {
  defaultsPath: sectionId => sectionId === SECTION_VINEFLOWER ? ["vineflower", "defaultVersion"] : ["lines", sectionId, "defaultVersion"],
  providers: [
    { core: JavaCore, versions: ["normalizeVersion"], directories: ["getInstallDir"],
      lists: { listInstalled: ({ args }) => args[1] == null ? LINE_SECTIONS : sectionIdForLine(JavaCore.normalizeLine(args[1])) },
      resolves: { resolveBestInstalled: ({ query }) => sectionIdForLine(JavaCore.normalizeLine(query.line)) },
      compatible: (install, { query }) => !query.strictVariant || !query.variant || install.variant === JavaCore.normalizeVariant(query.variant) },
    { core: VineflowerCore, versions: ["normalizeVersion"], directories: ["getInstallDir"], lists: { listInstalled: SECTION_VINEFLOWER } }
  ],
  sectionForEntry: entry => sectionIdForLine(entry?.runtimeData?.java?.line || entry?.moduleData?.runtimeLine ||
    JavaCore.LTS_LINES.find(line => line >= Number(entry?.moduleData?.requiredJava || DEFAULT_LINE)) || entry?.moduleData?.requiredJava || DEFAULT_LINE),
  selection(install, { entry }) {
    const required = require("./steamworks/runtime").requiredVariant(entry, {
      explicitVariant: JavaCore.normalizeVariant(entry?.runtimeData?.java?.variant), preferredVariant: install.variant
    });
    if (required && install.variant !== required) throw new Error("This game's exact Java Steam bridge requires a different JVM CPU.");
    return {};
  },
  inspect(runtimePath, { sectionId }) {
    if (sectionId === SECTION_VINEFLOWER) {
      const jarPath = fs.statSync(runtimePath).isDirectory() ? path.join(runtimePath, "vineflower.jar") : runtimePath;
      if (!fs.statSync(jarPath).isFile()) throw new Error("Select a Vineflower JAR.");
      const entries = require("../../shared/runtime/zip").readZipEntries(jarPath)?.entries || [];
      if (!entries.some(entry => entry.name === "org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler.class"))
        throw new Error("The selected JAR does not contain the Vineflower decompiler.");
      return { jarPath, executablePath: jarPath, installDir: path.dirname(jarPath), root: path.dirname(jarPath), ready: true };
    }
    const native = Custom.inspectExecutable(runtimePath, { candidates: ["bin/java", "Contents/Home/bin/java", "java"] });
    const home = path.dirname(path.dirname(native.executablePath));
    let runtimeVersion = null;
    try {
      const release = path.join(home, "release");
      if (fs.statSync(release).size <= 64 * 1024)
        runtimeVersion = /^JAVA_VERSION="([^"]+)"/m.exec(fs.readFileSync(release, "utf8"))?.[1] || null;
    } catch {}
    const declaredLine = runtimeVersion?.startsWith("1.8.") ? 8 : Number.parseInt(runtimeVersion, 10);
    const other = resolveSectionId(sectionId) === SECTION_OTHER, line = other ? declaredLine : sectionLine(sectionId);
    if (!Number.isFinite(line) || other && JavaCore.isLtsLine(line) || !other && Number.isFinite(declaredLine) && declaredLine !== line)
      throw new Error(`The selected Java runtime does not belong in the ${other ? "Other" : `Java ${line || sectionId}`} list.`);
    return { ...native, javaPath: native.executablePath, javaHome: home, line,
      variant: native.architecture === "x64" ? "x64" : "arm64", runtimeVersion };
  }
});
