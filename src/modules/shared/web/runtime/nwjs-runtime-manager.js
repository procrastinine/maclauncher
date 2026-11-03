const fs = require("node:fs");
const path = require("node:path");
const AppBundle = require("../../runtime/app-bundle");
const Host = require("../../runtime/host-capabilities");
const Archive = require("../../runtime/archive");
const ReleaseFiles = require("../../runtime/release-files");
const Upstream = require("../../runtime/upstream");
const { throwIfAborted } = require("../../runtime/download-utils");

// Mac platform folders of an NW.js release and the CPU each one serves.
const PLATFORMS = { "osx-arm64": "arm64", "osx-universal": "universal", "osx-x64": "x64" };

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = String(input ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Invalid NW.js version: ${String(input ?? "")}`);
  }
  return v;
}

function normalizeVariant(input) {
  const v = String(input ?? "sdk").trim().toLowerCase();
  if (!v) return "sdk";
  if (v === "sdk" || v === "normal") return "sdk";
  throw new Error(`Invalid NW.js variant: ${String(input ?? "")}`);
}

// The Mac's own CPU, then a universal build, then Intel through Rosetta.
function getDarwinPlatformKeys(arch) {
  if (arch === "arm64") return ["osx-arm64", "osx-universal", "osx-x64"];
  return ["osx-x64", "osx-universal"];
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "nwjs");
}

function getInstallRoots(userDataDir) {
  return [path.join(userDataDir, "runtimes", "nwjs")];
}

function getInstallDirForRoot(rootDir, { version, platformKey, variant }) {
  const v = normalizeVersion(version);
  return path.join(rootDir, v, platformKey, variant);
}

function getInstallDir({ userDataDir, version, platformKey, variant }) {
  return getInstallDirForRoot(installRootDir(userDataDir), { version, platformKey, variant });
}

function getExecutablePathForInstallDir(platformKey, installDir) {
  if (platformKey.startsWith("osx-")) {
    return path.join(installDir, "nwjs.app", "Contents", "MacOS", "nwjs");
  }
  return null;
}

function findNwjsAppRoot(extractedDir) {
  const app = Archive.findEntry(extractedDir, (file, item) => item.isDirectory() && item.name === "nwjs.app");
  if (!app) throw new Error("NW.js extract did not contain nwjs.app");
  return path.dirname(app);
}

// The highest macOS floor of the app's own executable and libraries, read
// from their Mach-O load commands: a later NW.js can need a later macOS than
// its Info.plist states.
function packageMinimumMacOS(appPath, arch) {
  let floor = null;
  const machine = arch === "x64" ? "x86_64" : arch;
  const files = [path.join(appPath, "Contents", "MacOS", "nwjs")];
  const queue = [[path.join(appPath, "Contents", "Frameworks"), 0]];
  while (queue.length && files.length < 64) {
    const [directory, depth] = queue.shift();
    let items = [];
    try { items = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      const file = path.join(directory, item.name);
      if (item.isDirectory() && depth < 6 && item.name !== "Resources") queue.push([file, depth + 1]);
      else if (item.isFile() && (item.name.endsWith(".dylib") || item.name === "nwjs Framework")) files.push(file);
    }
  }
  for (const file of files) {
    try {
      const slices = require("../../runtime/macho-load-commands").readMachOLoadCommands(file).slices;
      const minimum = (slices.find(slice => slice.architecture === machine) || slices[0])?.minimumMacOS;
      if (minimum && (!floor || !Host.versionAtLeast(floor, minimum))) floor = minimum;
    } catch {}
  }
  return floor;
}

function parseSemver(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(b || "").localeCompare(String(a || ""));
  for (let i = 0; i < 3; i++) {
    const d = pb[i] - pa[i];
    if (d !== 0) return d;
  }
  return 0;
}

// Release records of a version index: a list, or an object holding one.
function indexRecords(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.versions || parsed?.data || parsed?.items;
  return (Array.isArray(list) ? list : []).map(item => typeof item === "string" ? { version: item } : item && typeof item === "object" ? item : null)
    .map(item => item && { ...item, version: String(item.version || item.name || item.tag_name || "").trim().replace(/^v/i, "") })
    .filter(item => item && /^\d+\.\d+\.\d+$/.test(item.version));
}

// NW.js lists every release in its version index, with the platforms and
// flavors each one publishes; the download listing answers when the index
// moves. A release's SDK archives live in its version folder.
const source = Upstream.index({ locations: ["https://nwjs.io/versions.json", "https://dl.nwjs.io/versions.json", "https://dl.nwjs.io/index.json", "https://dl.nwjs.io/"],
  hosts: ["nwjs.io"], parse: documents => {
    for (const document of documents) {
      let records;
      try { records = indexRecords(JSON.parse(document.text)); }
      catch { records = [...document.text.matchAll(/href=["']v?(\d+\.\d+\.\d+)\/["']/g)].map(match => ({ version: match[1] })); }
      const byVersion = new Map();
      for (const record of records) if (!byVersion.has(record.version)) byVersion.set(record.version, record);
      if (!byVersion.size) continue;
      return [...byVersion.values()].sort((a, b) => compareSemverDesc(a.version, b.version)).slice(0, 500).map(record => {
        const known = Array.isArray(record.files), keys = Object.keys(PLATFORMS).filter(key => !known || record.files.includes(key));
        const sdk = !Array.isArray(record.flavors) || record.flavors.includes("sdk"), v = record.version;
        return { version: v, sourceUrl: `https://dl.nwjs.io/v${v}/`, ...(known ? { details: { platforms: keys } } : {}),
          ...(sdk ? {} : { installReason: "This NW.js release publishes no SDK build." }),
          files: sdk ? keys.map(key => ({ name: `nwjs-sdk-v${v}-${key}.zip`, url: `https://dl.nwjs.io/v${v}/nwjs-sdk-v${v}-${key}.zip`, architecture: PLATFORMS[key] })) : [] };
      });
    }
    return [];
  } });

// How a listed release serves one CPU. A listing without platform details
// leaves it to the download.
function availability(row, arch) {
  if (!row.details?.platforms) return {};
  const has = architecture => row.files.some(file => file.architecture === architecture);
  const nativeAvailable = has(arch === "arm64" ? "arm64" : "x64") || has("universal");
  const rosettaFallback = arch === "arm64" && !nativeAvailable && has("x64");
  const unavailable = !nativeAvailable && !rosettaFallback;
  return { nativeAvailable, rosettaFallback, unavailable, mode: unavailable ? "unavailable" : rosettaFallback ? "rosetta" : "native" };
}

// Catalog defaults follow the launcher CPU; alternate CPU catalogs are calculated separately.
async function fetchAvailableVersions({ logger, latestOnly, signal, arch = process.arch } = {}) {
  logger?.info?.("[nwjs] fetching versions");
  const rows = (await source.discover({ logger, signal })).slice(0, latestOnly === true ? 1 : 500);
  if (!rows.length) throw new Error("No NW.js versions found");
  const versions = rows.map(row => row.version);
  const listedAvailability = architecture => Object.fromEntries(rows.map(row => [row.version,
    row.installReason ? { unavailable: true, mode: "unavailable" } : availability(row, architecture)]));
  const availabilityByVersion = listedAvailability(arch);
  const versionRequirements = Object.fromEntries(rows.filter(row => row.installReason).map(row => [row.version, { installReason: row.installReason }]));
  const architectureCatalogs = Object.fromEntries(["arm64", "x64"].map(architecture => {
    const byVersion = listedAvailability(architecture), exactVersions = versions.filter(version => byVersion[version]?.nativeAvailable === true);
    return [architecture, { versions: exactVersions, source: "https://dl.nwjs.io/", availabilityByVersion: byVersion,
      versionRequirements: {}, installableVersions: exactVersions }];
  }));
  return { versions, rows, source: "https://dl.nwjs.io/", mode: latestOnly === true ? "latest" : "all", availabilityByVersion,
    versionRequirements, architectureCatalogs, installableVersions: versions.filter(version => availabilityByVersion[version]?.unavailable !== true) };
}

// The version folder's SHASUMS256.txt names each published archive with its
// SHA-256, in its current format. Without it the listed file installs and its
// hash is recorded.
async function publishedFile(listed, { version, key, signal, logger }) {
  const prefix = `nwjs-sdk-v${version}-${key}.`;
  const checksums = Upstream.index({ locations: [new URL("SHASUMS256.txt", listed.url).href], parse: ([document]) => [{ version,
    files: document.text.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line.trim())).filter(Boolean)
      .map(([, digest, name]) => ({ name: path.posix.basename(name), url: new URL(path.posix.basename(name), listed.url).href, digest })) }] });
  try {
    const [row] = await checksums.discover({ signal, logger });
    const files = (row?.files || []).filter(file => file.name.startsWith(prefix) && ["zip", "tar"].includes(Archive.archiveKind(file.name)))
      .sort((a, b) => Number(!a.name.endsWith(".zip")) - Number(!b.name.endsWith(".zip")));
    if (files[0]) return files[0];
  } catch { throwIfAborted(signal); }
  return listed;
}

function listInstalled(userDataDir) {
  return structuredClone(require("../../../../core/coordinated-runtime-managers").memoizeRuntimeResolution(module.exports,
    JSON.stringify(["listInstalled", userDataDir]), () => listInstalledUncached(userDataDir)));
}

function listInstalledUncached(userDataDir) {
  const out = [];
  const seen = new Set();
  const roots = getInstallRoots(userDataDir);

  for (const root of roots) {
    let versions = [];
    try {
      versions = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      continue;
    }

    for (const versionDir of versions) {
      const version = versionDir.name;
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
      const versionPath = path.join(root, version);
      let platforms = [];
      try {
        platforms = fs
          .readdirSync(versionPath, { withFileTypes: true })
          .filter(d => d.isDirectory());
      } catch {
        continue;
      }
      for (const platformDir of platforms) {
        const platformKey = platformDir.name;
        const platformPath = path.join(versionPath, platformKey);
        let variants = [];
        try {
          variants = fs
            .readdirSync(platformPath, { withFileTypes: true })
            .filter(d => d.isDirectory());
        } catch {
          continue;
        }
        for (const variantDir of variants) {
          const variant = variantDir.name;
          if (variant !== "sdk") continue;
          const installDir = path.join(platformPath, variant);
          const exePath = getExecutablePathForInstallDir(platformKey, installDir);
          const appPath = path.join(installDir, "nwjs.app");
          if (!exePath || !fs.existsSync(appPath)) continue;
          const status = AppBundle.appBundleStatus(appPath, { executablePath: exePath });
          const key = `${version}-${platformKey}-${variant}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ version, platformKey, variant, installDir, executablePath: exePath, ...status });
        }
      }
    }
  }

  out.sort((a, b) =>
    `${a.version}-${a.platformKey}-${a.variant}`.localeCompare(`${b.version}-${b.platformKey}-${b.variant}`)
  );
  return out;
}

// Installs a listed release: this Mac's own CPU, then a universal build, then
// Intel through Rosetta. `files` are the release's listed SDK archives; the
// release list is read when the caller has none.
async function installVersion({
  userDataDir,
  version,
  variant,
  platform,
  arch,
  macOSVersion,
  files,
  logger,
  onProgress,
  signal
}) {
  const v = normalizeVersion(version);
  const kind = normalizeVariant(variant);
  const resolvedPlatform = platform || process.platform;
  // Keep the requested/default runtime CPU rather than replacing it with the physical Mac's CPU.
  const resolvedArch = arch || process.arch;

  if (resolvedPlatform !== "darwin") {
    throw new Error(
      `NW.js auto-install is currently only implemented for macOS (platform=${resolvedPlatform})`
    );
  }

  const root = installRootDir(userDataDir);
  ensureDir(root);

  const platformKeys = getDarwinPlatformKeys(resolvedArch);
  let lastErr = null;

  for (const platformKey of platformKeys) {
    const installDir = getInstallDir({ userDataDir, version: v, platformKey, variant: kind });
    const exePath = getExecutablePathForInstallDir(platformKey, installDir);
    if (exePath && AppBundle.appBundleStatus(path.join(installDir, "nwjs.app"), { executablePath: exePath }).ready) {
      return { version: v, platformKey, variant: kind, installDir, executablePath: exePath, ready: true, reason: null };
    }

    files ??= (await source.discover({ logger, signal })).find(row => row.version === v)?.files || [];
    const listed = files.find(file => file.architecture === PLATFORMS[platformKey]);
    if (!listed) continue;
    const file = await publishedFile(listed, { version: v, key: platformKey, signal, logger });
    // Publication must stay on the user's data volume (external/shared volumes
    // cannot rename an extraction from macOS's system temporary directory).
    const tmpDir = fs.mkdtempSync(path.join(root, ".install-"));
    const zipPath = path.join(tmpDir, file.name);
    const extractDir = path.join(tmpDir, "extract");

    try {
      logger?.info?.(`[nwjs] downloading ${file.url}`);
      await source.download(file, zipPath, { onProgress, signal });
      throwIfAborted(signal);

      logger?.info?.(`[nwjs] extracting ${path.basename(zipPath)}`);
      await ReleaseFiles.extractArchive(zipPath, extractDir, signal);

      const appRoot = findNwjsAppRoot(extractDir);
      AppBundle.validateAppBundle(path.join(appRoot, "nwjs.app"), {
        executablePath: path.join(appRoot, "nwjs.app", "Contents", "MacOS", "nwjs")
      });
      // The app's executable and libraries state the macOS they load on.
      const floor = packageMinimumMacOS(path.join(appRoot, "nwjs.app"), platformKey === "osx-x64" ? "x64" : resolvedArch);
      const hostMacOS = macOSVersion || Host.getHostCapabilities().macOSVersion;
      if (floor && hostMacOS && !Host.versionAtLeast(hostMacOS, floor)) throw new Error(`NW.js ${v} requires macOS ${floor} or later.`);

      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.renameSync(appRoot, installDir);

      const finalExe = getExecutablePathForInstallDir(platformKey, installDir);
      if (!finalExe || !fs.existsSync(finalExe)) {
        throw new Error("Installed NW.js executable missing after extraction");
      }
      AppBundle.validateAppBundle(path.join(installDir, "nwjs.app"), { executablePath: finalExe });

      return { version: v, platformKey, variant: kind, installDir, executablePath: finalExe, ready: true, reason: null };
    } catch (e) {
      lastErr = e;
      const statusCode = Number(e?.statusCode || 0);
      if (statusCode === 404) {
        logger?.warn?.(`[nwjs] ${file.url} not found (404), trying next arch…`);
      } else {
        logger?.error?.("[nwjs] install failed", String(e?.stack || e));
        throw e;
      }
    } finally {
      safeRm(tmpDir);
    }
  }

  throw lastErr || new Error(`NW.js ${v} offers no SDK download for this Mac.`);
}

function uninstallVersion({ userDataDir, version, platformKey, variant, installDir }) {
  if (installDir) {
    safeRm(installDir);
    return true;
  }
  const v = normalizeVersion(version);
  const kind = normalizeVariant(variant);
  const roots = getInstallRoots(userDataDir);
  for (const root of roots) {
    const dir = getInstallDirForRoot(root, { version: v, platformKey, variant: kind });
    safeRm(dir);
  }
  return true;
}

function resolveBestInstalled({ userDataDir, version, variant, platform, arch, versions }) {
  const requested = String(version ?? "").trim();
  const v = requested && requested !== "auto" ? normalizeVersion(version) : null;
  const kind = normalizeVariant(variant);

  const resolvedPlatform = platform || process.platform;
  // Installed-runtime preference follows the requested/default launcher CPU.
  const resolvedArch = arch || process.arch;

  if (resolvedPlatform !== "darwin") {
    throw new Error(`NW.js runtime resolution not implemented for platform=${resolvedPlatform}`);
  }

  const keys = getDarwinPlatformKeys(resolvedArch);
  if (!v) {
    return listInstalled(userDataDir).filter(item => item.ready !== false && item.variant === kind &&
      keys.includes(item.platformKey) && (!Array.isArray(versions) || versions.includes(item.version)))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }) ||
        keys.indexOf(a.platformKey) - keys.indexOf(b.platformKey))
      .find(item => AppBundle.appBundleStatus(path.join(item.installDir, "nwjs.app"), { executablePath: item.executablePath }).ready) || null;
  }
  const roots = getInstallRoots(userDataDir);
  for (const platformKey of keys) {
    for (const root of roots) {
      const installDir = getInstallDirForRoot(root, { version: v, platformKey, variant: kind });
      const exe = getExecutablePathForInstallDir(platformKey, installDir);
      if (exe && AppBundle.appBundleStatus(path.join(installDir, "nwjs.app"), { executablePath: exe }).ready) {
        return { version: v, platformKey, variant: kind, installDir, executablePath: exe, ready: true, reason: null };
      }
    }
  }

  return null;
}

module.exports = {
  normalizeVersion,
  normalizeVariant,
  installRootDir,
  listInstalled,
  fetchAvailableVersions,
  installVersion,
  uninstallVersion,
  resolveBestInstalled,
  source,
  __test: { publishedFile }
};
