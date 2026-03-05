const JavaCore = require("./java-runtime");
const VineflowerCore = require("./vineflower-runtime");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");

const DEFAULT_LINE = 21;
const SECTION_VINEFLOWER = "vineflower";
const LINE_SECTIONS = JavaCore.LTS_LINES.map(String);

const lineCatalogPromises = new Map();
const lineCatalogStates = new Map();
for (const line of JavaCore.LTS_LINES) {
  lineCatalogStates.set(line, {
    status: "idle",
    versions: [],
    entriesByVersion: {},
    fetchedAt: null,
    source: null,
    error: null
  });
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
  if (Number.isFinite(value) && JavaCore.LTS_LINES.includes(value)) return value;
  return fallback;
}

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const defaultLine = normalizeLineInput(src.defaultLine, DEFAULT_LINE);
  const linesSrc = src.lines && typeof src.lines === "object" ? src.lines : {};
  const lines = {};

  for (const line of JavaCore.LTS_LINES) {
    const section = linesSrc[line] && typeof linesSrc[line] === "object" ? linesSrc[line] : {};
    let defaultVersion = null;
    if (typeof section.defaultVersion === "string" && section.defaultVersion.trim()) {
      try {
        defaultVersion = JavaCore.normalizeVersion(section.defaultVersion.trim());
      } catch {
        defaultVersion = null;
      }
    }
    const defaultVariant =
      JavaCore.normalizeVariant(section.defaultVariant) || JavaCore.defaultVariantForHost();
    lines[line] = {
      defaultVersion,
      defaultVariant
    };
  }

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
  if (section === SECTION_VINEFLOWER) return SECTION_VINEFLOWER;
  if (LINE_SECTIONS.includes(section)) return section;
  return String(DEFAULT_LINE);
}

function sectionLine(sectionId) {
  const resolved = resolveSectionId(sectionId);
  if (resolved === SECTION_VINEFLOWER) return null;
  return Number(resolved);
}

function ttlValid(fetchedAt, ttlMs) {
  if (!Number.isFinite(fetchedAt)) return false;
  return Date.now() - fetchedAt < ttlMs;
}

async function refreshLineCatalog({ line, logger, force } = {}) {
  const runtimeLine = normalizeLineInput(line, DEFAULT_LINE);
  const existing = lineCatalogStates.get(runtimeLine) || {
    status: "idle",
    versions: [],
    entriesByVersion: {},
    fetchedAt: null,
    source: null,
    error: null
  };
  const ttlMs = 1000 * 60 * 60 * 6;
  if (!force && ttlValid(existing.fetchedAt, ttlMs)) return existing;
  if (lineCatalogPromises.has(runtimeLine)) return lineCatalogPromises.get(runtimeLine);

  lineCatalogStates.set(runtimeLine, {
    ...existing,
    status: "loading",
    error: null
  });

  const promise = (async () => {
    try {
      const res = await JavaCore.fetchAvailableVersionsForLine({
        line: runtimeLine,
        logger
      });
      const next = {
        status: "success",
        versions: res.versions || [],
        entriesByVersion: res.entriesByVersion || {},
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null
      };
      lineCatalogStates.set(runtimeLine, next);
      return next;
    } catch (err) {
      const next = {
        status: "error",
        versions: [],
        entriesByVersion: {},
        fetchedAt: Date.now(),
        source: null,
        error: String(err?.message || err)
      };
      lineCatalogStates.set(runtimeLine, next);
      throw err;
    } finally {
      lineCatalogPromises.delete(runtimeLine);
    }
  })();

  lineCatalogPromises.set(runtimeLine, promise);
  return promise;
}

async function refreshVineflowerCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  if (!force && ttlValid(vineflowerCatalogState.fetchedAt, ttlMs)) {
    return vineflowerCatalogState;
  }
  if (vineflowerCatalogPromise) return vineflowerCatalogPromise;

  vineflowerCatalogState = {
    ...vineflowerCatalogState,
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
        status: "error",
        versions: [],
        releasesByVersion: {},
        fetchedAt: Date.now(),
        source: null,
        error: String(err?.message || err)
      };
      throw err;
    } finally {
      vineflowerCatalogPromise = null;
    }
  })();

  return vineflowerCatalogPromise;
}

async function refreshCatalog({ logger, force, sectionId } = {}) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_VINEFLOWER) {
    return refreshVineflowerCatalog({ logger, force });
  }
  return refreshLineCatalog({ line: Number(section), logger, force });
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
  if (process.arch !== "arm64") return null;
  if (Number(line) === 8) {
    if (hostAvailability?.mode === "rosetta") {
      return {
        title: "Java 8 on Apple Silicon",
        lines: [
          { text: "Java 8 installs use Intel (x64) builds and require Rosetta." },
          { text: "Install Rosetta if launch fails: softwareupdate --install-rosetta", mono: true }
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
    hostArch: process.arch
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
    hostArch: process.arch
  });
  if (choice?.variant) return choice.variant;
  const ordered = orderLineVariants(variants);
  if (ordered[0]) return ordered[0];
  return JavaCore.defaultVariantForHost();
}

function buildLineState(cfg, userDataDir, line) {
  const runtimeLine = normalizeLineInput(line, DEFAULT_LINE);
  const lineCfg = cfg.lines[runtimeLine] || {
    defaultVersion: null,
    defaultVariant: JavaCore.defaultVariantForHost()
  };
  const installed = JavaCore.listInstalled(userDataDir, runtimeLine);
  const catalogState = lineCatalogStates.get(runtimeLine) || {
    status: "idle",
    versions: [],
    entriesByVersion: {},
    fetchedAt: null,
    source: null,
    error: null
  };
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

  return {
    line: runtimeLine,
    defaultVersion: lineCfg.defaultVersion,
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
      source: catalogState.source,
      error: catalogState.error,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && lineCfg?.defaultVersion
          ? JavaCore.compareVersions(String(latestAvailable), String(lineCfg.defaultVersion)) > 0
          : false
    }
  };
}

function buildVineflowerState(cfg, userDataDir) {
  const installed = VineflowerCore.listInstalled(userDataDir);
  const latestInstalled = newestInstalled(installed, VineflowerCore.compareVersionsDesc);
  const latestAvailable = Array.isArray(vineflowerCatalogState.versions)
    ? vineflowerCatalogState.versions[0] || null
    : null;

  return {
    defaultVersion: cfg.vineflower.defaultVersion || null,
    installed,
    installing: null,
    variants: [],
    catalog: {
      status: vineflowerCatalogState.status,
      versions: vineflowerCatalogState.versions,
      fetchedAt: vineflowerCatalogState.fetchedAt,
      source: vineflowerCatalogState.source,
      error: vineflowerCatalogState.error,
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
  const lineStates = JavaCore.LTS_LINES.map(line => ({
    id: String(line),
    label: `Java ${line}`,
    ...buildLineState(cfg, userDataDir, line)
  }));

  const vineflower = buildVineflowerState(cfg, userDataDir);

  return {
    defaultLine: cfg.defaultLine,
    lines: Object.fromEntries(lineStates.map(state => [state.line, state])),
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
  logger,
  onProgress,
  downloads,
  forceCatalog
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
    variant: requestedVariant,
    hostArch: process.arch
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
    ({ signal, onProgress: taskProgress }) =>
      JavaCore.installVersion({
        userDataDir,
        line: runtimeLine,
        version: selected.version,
        variant: selected.variant,
        logger,
        onProgress: taskProgress,
        signal,
        lineCatalog: lineCatalogStates.get(runtimeLine)
      }),
    { onProgress }
  );
}

async function installVineflowerRuntime({
  userDataDir,
  version,
  logger,
  onProgress,
  downloads
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
    ({ signal, onProgress: taskProgress }) =>
      VineflowerCore.installVersion({
        userDataDir,
        version: targetVersion,
        logger,
        onProgress: taskProgress,
        signal,
        releasesByVersion: vineflowerCatalogState.releasesByVersion
      }),
    { onProgress }
  );
}

async function installRuntime({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  sectionId,
  line,
  downloads
} = {}) {
  const section = resolveSectionId(sectionId || line);
  if (section === SECTION_VINEFLOWER) {
    return installVineflowerRuntime({
      userDataDir,
      version,
      logger,
      onProgress,
      downloads
    });
  }

  const runtimeLine = normalizeLineInput(line || section, DEFAULT_LINE);
  return installLineRuntime({
    userDataDir,
    line: runtimeLine,
    version,
    variant,
    logger,
    onProgress,
    downloads
  });
}

function uninstallRuntime({ userDataDir, version, variant, installDir, sectionId, line }) {
  const section = resolveSectionId(sectionId || line);
  if (section === SECTION_VINEFLOWER) {
    return VineflowerCore.uninstallVersion({ userDataDir, version, installDir });
  }
  const runtimeLine = normalizeLineInput(line || section, DEFAULT_LINE);
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
  const section = resolveSectionId(payload?.sectionId || payload?.line);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  const normalized = normalizeSettings(next);

  if (section === SECTION_VINEFLOWER) {
    const current = normalized.vineflower.defaultVersion;
    if (
      installed.version &&
      (!current || VineflowerCore.compareVersions(installed.version, current) > 0)
    ) {
      next.vineflower = {
        ...(next.vineflower && typeof next.vineflower === "object" ? next.vineflower : {}),
        defaultVersion: installed.version
      };
    }
    return next;
  }

  const line = normalizeLineInput(section, DEFAULT_LINE);
  const lineSettings =
    next.lines && typeof next.lines === "object" ? { ...next.lines } : {};
  const currentVariant = normalized.lines[line]?.defaultVariant || JavaCore.defaultVariantForHost();
  if (!installed.version) return next;
  lineSettings[line] = {
    ...(lineSettings[line] && typeof lineSettings[line] === "object" ? lineSettings[line] : {}),
    defaultVersion: installed.version,
    defaultVariant: installed.variant || currentVariant
  };
  next.lines = lineSettings;
  next.defaultLine = line;
  return next;
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

  const line = normalizeLineInput(section, DEFAULT_LINE);
  const installed = JavaCore.listInstalled(userDataDir, line);
  const lineSettings = normalized.lines[line] || {
    defaultVersion: null,
    defaultVariant: JavaCore.defaultVariantForHost()
  };
  const hasDefault = installed.some(
    entry =>
      entry.version === lineSettings.defaultVersion &&
      entry.variant === lineSettings.defaultVariant
  );
  if (hasDefault) return settings;

  const latest = newestInstalled(installed, JavaCore.compareVersionsDesc);
  const nextLines = next.lines && typeof next.lines === "object" ? { ...next.lines } : {};
  nextLines[line] = {
    ...(nextLines[line] && typeof nextLines[line] === "object" ? nextLines[line] : {}),
    defaultVersion: latest?.version || null,
    defaultVariant: latest?.variant || lineSettings.defaultVariant
  };
  next.lines = nextLines;
  if (!next.defaultLine) next.defaultLine = line;
  return next;
}

module.exports = {
  id: "java",
  label: "Java",
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

    const line = normalizeLineInput(section, DEFAULT_LINE);
    const version =
      typeof payload?.version === "string" && payload.version.trim()
        ? JavaCore.normalizeVersion(payload.version.trim())
        : null;
    const variant =
      JavaCore.normalizeVariant(payload?.variant) || JavaCore.defaultVariantForHost();
    const lines = next.lines && typeof next.lines === "object" ? { ...next.lines } : {};
    lines[line] = {
      ...(lines[line] && typeof lines[line] === "object" ? lines[line] : {}),
      defaultVersion: version,
      defaultVariant: variant
    };
    next.lines = lines;
    next.defaultLine = line;
    return next;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
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
