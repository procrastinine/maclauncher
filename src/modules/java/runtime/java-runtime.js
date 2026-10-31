const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Rosetta = require("../../shared/runtime/rosetta");
const Architecture = require("../../shared/runtime/architecture");
const Host = require("../../shared/runtime/host-capabilities");
const Archive = require("../../shared/runtime/archive");
const ReleaseFiles = require("../../shared/runtime/release-files");
const Upstream = require("../../shared/runtime/upstream");
const { attachAbortSignal, createAbortError, throwIfAborted } = require("../../shared/runtime/download-utils");

const ADOPTIUM_API_BASE = "https://api.adoptium.net/v3";
const INSTALL_META_FILE = ".maclauncher-java.json";
// Each long-term-support line has its own section; every other feature
// release Adoptium publishes, a future one included, is listed together.
const LTS_LINES = [8, 11, 17, 21, 25];
// Adoptium clamps larger page_size values to 20, even with a successful response.
const CATALOG_PAGE_SIZE = 20;
const CATALOG_MAX_PAGES = 5;
const VARIANTS = [
  { id: "arm64", label: "Apple Silicon" },
  { id: "x64", label: "Intel" }
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function isEmptyCatalogStatus(status) {
  return status === 404 || status === 204;
}

// A Java feature release: an LTS line or any other major version.
function normalizeLine(input) {
  const line = Number(input);
  if (!Number.isInteger(line) || line < 1 || line > 999) {
    throw new Error(`Invalid Java line: ${String(input ?? "")}`);
  }
  return line;
}

function isLtsLine(line) {
  return LTS_LINES.includes(Number(line));
}

function normalizeVariant(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "x86_64" || value === "x86-64") return "x64";
  return "";
}

function archToVariant(arch) {
  const value = String(arch || "").trim().toLowerCase();
  if (value === "aarch64" || value === "arm64") return "arm64";
  if (value === "x64" || value === "x86_64" || value === "x86-64") return "x64";
  return "";
}

function defaultVariantForHost() {
  return Architecture.selectedArchitecture();
}

function normalizeVersion(input) {
  const raw = String(input ?? "").trim().replace(/^jdk[-_]?/i, "").replace(/^v/i, "");
  if (!raw) throw new Error(`Invalid Java version: ${String(input ?? "")}`);

  const legacy = raw.match(/^(\d+)u(\d+)-b(\d+)$/i);
  if (legacy) {
    return `${Number(legacy[1])}.0.${Number(legacy[2])}+${Number(legacy[3])}`;
  }

  const legacyOpenJdk = raw.match(/^1\.(\d+)\.0_(\d+)(?:-b(\d+))?$/i);
  if (legacyOpenJdk) {
    const base = `${Number(legacyOpenJdk[1])}.0.${Number(legacyOpenJdk[2])}`;
    return legacyOpenJdk[3] == null ? base : `${base}+${Number(legacyOpenJdk[3])}`;
  }

  const semver = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:\+(\d+))?(?:-LTS)?$/i);
  if (!semver) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  const major = Number(semver[1]);
  const minor = Number(semver[2] || 0);
  const patch = Number(semver[3] || 0);
  const revision = semver[4] != null ? Number(semver[4]) : null;
  const build = semver[5] != null ? Number(semver[5]) : null;
  if (![major, minor, patch].every(Number.isFinite)) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  if (build != null && !Number.isFinite(build)) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  if (revision != null && !Number.isFinite(revision)) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  const base = `${major}.${minor}.${patch}${revision == null ? "" : `.${revision}`}`;
  return build == null ? base : `${base}+${build}`;
}

function parseVersionParts(version) {
  const normalized = normalizeVersion(version);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:\+(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    revision: match[4] != null ? Number(match[4]) : 0,
    build: match[5] != null ? Number(match[5]) : null,
    normalized
  };
}

function versionMajor(version) {
  const parts = parseVersionParts(version);
  return parts?.major ?? null;
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.revision !== pb.revision) return pa.revision - pb.revision;
  const ab = Number.isFinite(pa.build) ? pa.build : -1;
  const bb = Number.isFinite(pb.build) ? pb.build : -1;
  if (ab !== bb) return ab - bb;
  return pa.normalized.localeCompare(pb.normalized);
}

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "java");
}

function getInstallDir({ userDataDir, line, version, variant }) {
  const runtimeLine = normalizeLine(line);
  const runtimeVersion = normalizeVersion(version);
  const runtimeVariant = normalizeVariant(variant) || defaultVariantForHost();
  return path.join(installRootDir(userDataDir), String(runtimeLine), runtimeVersion, runtimeVariant);
}

function metaPath(installDir) {
  return path.join(installDir, INSTALL_META_FILE);
}

function readInstallMeta(installDir) {
  try {
    const p = metaPath(installDir);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeInstallMeta(installDir, payload) {
  try {
    const p = metaPath(installDir);
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {}
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findJavaBinary(rootDir, maxDepth = 6) {
  const directCandidates = [
    path.join(rootDir, "bin", "java"),
    path.join(rootDir, "Contents", "Home", "bin", "java"),
    path.join(rootDir, "Home", "bin", "java")
  ];
  for (const candidate of directCandidates) {
    if (existsFile(candidate)) return candidate;
  }

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.name) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isFile()) {
        if (entry.name === "java" && path.basename(path.dirname(full)) === "bin") {
          return full;
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      queue.push({ dir: full, depth: current.depth + 1 });
    }
  }

  return null;
}

function resolveInstallJavaPath(installDir) {
  const meta = readInstallMeta(installDir);
  const relativeJavaPath =
    typeof meta?.javaRelativePath === "string" && meta.javaRelativePath.trim()
      ? meta.javaRelativePath.trim()
      : null;
  if (relativeJavaPath) {
    const candidate = path.join(installDir, relativeJavaPath);
    if (existsFile(candidate)) return candidate;
  }
  return findJavaBinary(installDir);
}

function listInstalled(userDataDir, line) {
  const root = installRootDir(userDataDir);
  const out = [];

  let targetLines = line != null ? [normalizeLine(line)] : [];
  if (line == null) {
    try { targetLines = fs.readdirSync(root).filter(name => /^\d{1,3}$/.test(name)).map(Number).filter(value => value > 0); } catch {}
  }
  for (const runtimeLine of targetLines) {
    const lineDir = path.join(root, String(runtimeLine));
    let versions = [];
    try {
      versions = fs.readdirSync(lineDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
    } catch {
      continue;
    }

    for (const versionEntry of versions) {
      let version = null;
      try {
        version = normalizeVersion(versionEntry.name);
      } catch {
        continue;
      }

      const versionDir = path.join(lineDir, versionEntry.name);
      let variants = [];
      try {
        variants = fs.readdirSync(versionDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
      } catch {
        continue;
      }

      for (const variantEntry of variants) {
        const variant = normalizeVariant(variantEntry.name);
        if (!variant) continue;
        const installDir = path.join(versionDir, variantEntry.name);
        const javaPath = resolveInstallJavaPath(installDir);
        if (!javaPath) continue;
        const meta = readInstallMeta(installDir);
        out.push({
          line: runtimeLine,
          version,
          variant,
          installDir,
          javaPath,
          source: meta?.source || null,
          downloadUrl: meta?.downloadUrl || null,
          requiresRosetta: Architecture.requiresRosetta(variant)
        });
      }
    }
  }

  out.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    const byVersion = compareVersionsDesc(a.version, b.version);
    if (byVersion !== 0) return byVersion;
    return String(a.variant || "").localeCompare(String(b.variant || ""));
  });

  return out;
}

function runCommand(cmd, args, options) {
  const { signal, ...spawnOptions } = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const removeAbort = attachAbortSignal(signal, () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", err => {
      removeAbort();
      reject(err);
    });
    child.on("close", code => {
      removeAbort();
      if (signal?.aborted) return reject(createAbortError());
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// The package is read by its published name; tar detects the compression of
// a package without a known archive extension.
async function extractArchive(archivePath, destDir, signal) {
  if (Archive.archiveKind(archivePath)) return ReleaseFiles.extractArchive(archivePath, destDir, signal);
  await runCommand("/usr/bin/tar", ["-xf", archivePath, "-C", destDir], { signal });
}

function buildLineCatalogUrl({ line, arch, page, pageSize }) {
  const runtimeLine = normalizeLine(line);
  const architecture = String(arch || "").trim();
  const p = Number(page);
  const size = Number(pageSize);
  const query = new URLSearchParams({
    architecture,
    heap_size: "normal",
    image_type: "jdk",
    jvm_impl: "hotspot",
    os: "mac",
    page: String(Number.isFinite(p) ? p : 0),
    page_size: String(Number.isFinite(size) ? size : CATALOG_PAGE_SIZE),
    project: "jdk",
    sort_order: "DESC"
  });
  return `${ADOPTIUM_API_BASE}/assets/feature_releases/${runtimeLine}/ga?${query.toString()}`;
}

function extractVersionFromRelease(release) {
  const candidates = [
    release?.version_data?.openjdk_version,
    release?.version?.openjdk_version,
    release?.release_name,
    release?.openjdk_version,
    release?.binary?.openjdk_version,
    release?.version_data?.semver,
    release?.version?.semver,
    release?.binary?.package?.name
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizeVersion(candidate);
    } catch {}
  }
  return null;
}

function extractAssetFromRelease(release, expectedLine, expectedVariant) {
  const binary = release?.binary && typeof release.binary === "object"
    ? release.binary
    : Array.isArray(release?.binaries)
      ? release.binaries.find(item =>
          archToVariant(item?.architecture || item?.arch) === expectedVariant &&
          (!item?.os || item.os === "mac") &&
          (!item?.image_type || item.image_type === "jdk")
        )
      : null;
  if (!binary || typeof binary !== "object") return null;
  const variant = archToVariant(binary.architecture || binary.arch || "");
  if (!variant || variant !== expectedVariant) return null;
  const imageType = String(binary.image_type || "").toLowerCase();
  if (imageType && imageType !== "jdk") return null;
  const osId = String(binary.os || "").toLowerCase();
  if (osId && osId !== "mac") return null;

  const pkg = binary.package && typeof binary.package === "object" ? binary.package : null;
  const url = typeof pkg?.link === "string" && pkg.link.trim() ? pkg.link.trim() : null;
  if (!url) return null;

  const version = extractVersionFromRelease(release);
  if (!version) return null;
  if (versionMajor(version) !== expectedLine) return null;

  const name =
    typeof pkg?.name === "string" && pkg.name.trim()
      ? pkg.name.trim()
      : path.basename(new URL(url).pathname);

  const publishedAt =
    Date.parse(String(release?.timestamp || release?.updated_at || release?.release_date || "")) ||
    Date.now();

  let semverVersion = null;
  try {
    const semver = String(release?.version_data?.semver || release?.version?.semver || "");
    // Adoptium's encoded SemVer can append build metadata such as +101.0.LTS.
    semverVersion = normalizeVersion(semver.replace(/\+(\d+)(?:\.\d+)*(?:\.LTS)?$/i, "+$1"));
  } catch {}

  return {
    line: expectedLine,
    version,
    semverVersion,
    variant,
    url,
    fileName: name,
    // Adoptium publishes each package's SHA-256 next to its link.
    checksum: /^[a-f0-9]{64}$/i.test(String(pkg?.checksum || "")) ? String(pkg.checksum).toLowerCase() : null,
    size: Number.isFinite(Number(pkg?.size)) ? Number(pkg.size) : null,
    publishedAt
  };
}

// The feature releases Adoptium publishes, with its long-term-support lines.
const releasesSource = Upstream.index({ locations: [`${ADOPTIUM_API_BASE}/info/available_releases`], parse: ([document]) => {
  const info = JSON.parse(document.text), lts = new Set((info?.available_lts_releases || []).map(Number));
  return [...new Set((info?.available_releases || []).map(Number))].filter(line => Number.isInteger(line) && line > 0 && line <= 999)
    .sort((a, b) => b - a).map(line => ({ version: String(line), details: { lts: lts.has(line) || isLtsLine(line) } }));
} });

async function fetchAvailableLines({ logger, signal } = {}) {
  const rows = await releasesSource.discover({ logger, signal });
  return { lines: rows.map(row => Number(row.version)), lts: rows.filter(row => row.details?.lts).map(row => Number(row.version)) };
}

// One line's GA releases for both Mac CPUs, newest first, paged 20 at a
// time. Each package, on Adoptium's or GitHub's hosts, carries the SHA-256
// and size Adoptium publishes.
function lineSource(line, { pageSize = CATALOG_PAGE_SIZE, maxPages = CATALOG_MAX_PAGES } = {}) {
  const size = Math.min(CATALOG_PAGE_SIZE, Math.max(1, Math.floor(Number(pageSize) || CATALOG_PAGE_SIZE)));
  const pages = Math.min(10, Math.max(1, Math.floor(Number(maxPages) || CATALOG_MAX_PAGES)));
  const url = (arch, page) => buildLineCatalogUrl({ line, arch, page, pageSize: size });
  return Upstream.index({ locations: ["aarch64", "x64"].map(arch => url(arch, 0)), hosts: ["adoptium.net", "github.com"], parse: async (documents, { fetch: readPage, logger }) => {
    const rows = [];
    for (const first of documents) {
      const arch = new URL(first.url).searchParams.get("architecture"), variant = archToVariant(arch);
      for (let page = 0, document = first; document && page < pages; page += 1) {
        if (isEmptyCatalogStatus(document.status)) break;
        if (document.status !== 200) throw new Error(`Java catalog fetch failed (${document.status})`);
        const parsed = JSON.parse(document.text);
        if (!Array.isArray(parsed)) throw new Error("Java catalog response must be an array");
        for (const release of parsed.slice(0, size)) {
          // A release that cannot be read is skipped; the others stay listed.
          try {
            const asset = extractAssetFromRelease(release, line, variant);
            if (asset) rows.push({ version: asset.version, architecture: variant, details: asset, files: [{ name: asset.fileName, url: asset.url,
              bytes: asset.size, ...(asset.checksum ? { digest: asset.checksum, algorithm: "sha256" } : {}), architecture: variant }] });
          } catch (error) {
            logger?.warn?.(`[java] skipped an unreadable Adoptium release: ${String(error?.message || error)}`);
          }
        }
        if (parsed.length < size) break;
        document = page + 1 < pages ? await readPage(url(arch, page + 1)) : null;
      }
    }
    return rows;
  } });
}

async function fetchLineAssets({ line, variant, logger, signal, pageSize, maxPages } = {}) {
  const runtimeLine = normalizeLine(line), runtimeVariant = normalizeVariant(variant) || defaultVariantForHost();
  const byVersion = new Map();
  for (const row of await lineSource(runtimeLine, { pageSize, maxPages }).discover({ logger, signal })) {
    if (row.architecture !== runtimeVariant || !row.files[0]) continue;
    const asset = { ...row.details, file: row.files[0] }, current = byVersion.get(asset.version);
    if (!current || asset.publishedAt > current.publishedAt) byVersion.set(asset.version, asset);
  }
  return Array.from(byVersion.values()).sort((a, b) => compareVersionsDesc(a.version, b.version));
}

async function fetchAvailableVersionsForLine({ line, logger, signal, latestOnly } = {}) {
  const runtimeLine = normalizeLine(line);
  const source = `${ADOPTIUM_API_BASE}/assets/feature_releases/${runtimeLine}/ga`;
  logger?.info?.(`[java] fetching Adoptium catalog for Java ${runtimeLine}`);
  const rows = await lineSource(runtimeLine, latestOnly === true ? { pageSize: 1, maxPages: 1 } : {}).discover({ logger, signal });

  const byVersion = new Map();
  const versionAliases = new Map();
  for (const row of rows) {
    if (!row.files[0]) continue;
    const variant = row.architecture, asset = { ...row.details, file: row.files[0] };
    if (asset.semverVersion && asset.semverVersion !== asset.version) versionAliases.set(asset.semverVersion, asset.version);
    const current = byVersion.get(asset.version) || { version: asset.version, line: runtimeLine, assets: { arm64: null, x64: null } };
    if (!current.assets[variant] || asset.publishedAt > current.assets[variant].publishedAt) current.assets[variant] = asset;
    byVersion.set(asset.version, current);
  }

  const sorted = Array.from(byVersion.values()).sort((a, b) => compareVersionsDesc(a.version, b.version));
  // An answer without any Mac build keeps the cached list.
  if (!sorted.length) throw new Error(`Adoptium lists no Mac build for Java ${runtimeLine}.`);
  const entries = latestOnly === true ? sorted.slice(0, 1) : sorted;
  const entriesByVersion = Object.fromEntries(entries.map(entry => [entry.version, entry.assets]));
  for (const [alias, canonical] of versionAliases) {
    if (!entriesByVersion[alias] && entriesByVersion[canonical]) {
      entriesByVersion[alias] = entriesByVersion[canonical];
    }
  }
  return {
    line: runtimeLine,
    source,
    mode: latestOnly === true ? "latest" : "all",
    versions: entries.map(entry => entry.version),
    entriesByVersion
  };
}

function availableVariantsForVersion(entryAssets) {
  const set = new Set();
  if (entryAssets?.arm64) set.add("arm64");
  if (entryAssets?.x64) set.add("x64");
  return set;
}

// The shared build resolver picks the variant: a build choice made for this
// call's CPU stays as given, a preferred variant comes next, then the launcher's
// CPU, then another CPU this Mac runs. Rosetta is needed for an Intel build in
// the Apple Silicon app.
function chooseVariantForHost({ availableVariants, preferredVariant, hostArch = Architecture.selectedArchitecture() }) {
  const offers = architecture => availableVariants.has(architecture);
  const variant = Architecture.chooseArchitecture({ request: hostArch !== Architecture.defaultArchitecture() ? { architecture: hostArch } : null,
    saved: normalizeVariant(preferredVariant), launcher: hostArch, offers });
  if (!offers(variant)) return null;
  const requiresRosetta = variant === "x64" && hostArch === "arm64";
  return { variant, requiresRosetta, mode: requiresRosetta ? "rosetta" : "native" };
}

function selectCatalogAsset({ lineCatalog, version, variant, hostArch = Architecture.selectedArchitecture(), strictVariant = false } = {}) {
  const catalog = lineCatalog && typeof lineCatalog === "object" ? lineCatalog : {};
  const entriesByVersion =
    catalog.entriesByVersion && typeof catalog.entriesByVersion === "object"
      ? catalog.entriesByVersion
      : {};
  const requestedVersion = version ? normalizeVersion(version) : null;

  const candidates = requestedVersion
    ? [requestedVersion]
    : Array.isArray(catalog.versions)
      ? catalog.versions.slice()
      : Object.keys(entriesByVersion).sort(compareVersionsDesc);

  for (const candidateVersion of candidates) {
    const assets = entriesByVersion[candidateVersion];
    if (!assets) continue;
    const available = availableVariantsForVersion(assets);
    if (strictVariant && variant && !available.has(normalizeVariant(variant))) continue;
    const chosen = chooseVariantForHost({
      availableVariants: available,
      preferredVariant: variant,
      hostArch
    });
    if (!chosen) continue;
    const asset = assets[chosen.variant];
    if (!asset) continue;
    return {
      version: asset.version || candidateVersion,
      variant: chosen.variant,
      requiresRosetta: chosen.requiresRosetta,
      asset
    };
  }

  return null;
}

function resolveBestInstalled({ userDataDir, line, version, variant, hostArch = Architecture.selectedArchitecture(), strictVariant = false } = {}) {
  const runtimeLine = normalizeLine(line);
  const installed = listInstalled(userDataDir, runtimeLine);
  const requestedVersion = version ? normalizeVersion(version) : null;

  const byVersion = new Map();
  for (const item of installed) {
    if (requestedVersion && item.version !== requestedVersion) continue;
    const bucket = byVersion.get(item.version) || [];
    bucket.push(item);
    byVersion.set(item.version, bucket);
  }

  const versions = Array.from(byVersion.keys()).sort(compareVersionsDesc);
  for (const candidateVersion of versions) {
    const candidates = byVersion.get(candidateVersion) || [];
    const available = new Set(candidates.map(item => item.variant));
    if (strictVariant && variant && !available.has(normalizeVariant(variant))) continue;
    const chosen = chooseVariantForHost({
      availableVariants: available,
      preferredVariant: variant,
      hostArch
    });
    if (!chosen) continue;
    const match = candidates.find(item => item.variant === chosen.variant);
    if (!match) continue;
    return {
      ...match,
      requiresRosetta: chosen.requiresRosetta
    };
  }

  return null;
}

function isRosettaAvailable({ force = false } = {}) {
  return Rosetta.isAvailable({ force });
}

async function installVersion({
  userDataDir,
  line,
  version,
  variant,
  logger,
  onProgress,
  signal,
  lineCatalog,
  hostArch = Architecture.selectedArchitecture(),
  strictVariant = false
} = {}) {
  const runtimeLine = normalizeLine(line);
  const selection = selectCatalogAsset({
    lineCatalog,
    version,
    variant,
    hostArch,
    strictVariant
  });
  if (!selection?.asset?.url) {
    const requested = version ? ` ${String(version)}` : "";
    throw new Error(`No installable Java asset found for line ${runtimeLine}${requested}.`);
  }

  const runtimeVersion = normalizeVersion(selection.version);
  const runtimeVariant = normalizeVariant(selection.variant) || defaultVariantForHost();
  const installDir = getInstallDir({
    userDataDir,
    line: runtimeLine,
    version: runtimeVersion,
    variant: runtimeVariant
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-"));
  const fileName = path.basename(String(selection.asset.fileName || "")) || `java-${runtimeLine}-${runtimeVersion}-${runtimeVariant}.tar.gz`;
  const archivePath = path.join(tmpDir, fileName);
  const extractDir = path.join(tmpDir, "extract");

  try {
    ensureDir(extractDir);
    logger?.info?.(`[java] downloading ${selection.asset.url}`);
    // Adoptium's published SHA-256 and size verify the package.
    const file = selection.asset.file || Upstream.listedFile({ filename: fileName, url: selection.asset.url,
      sha256: selection.asset.checksum || undefined, bytes: selection.asset.size || undefined });
    if (!file) throw new Error(`The Java ${runtimeVersion} package has no HTTPS download.`);
    const { sha256, integrity } = await releasesSource.download(file, archivePath, { onProgress, signal });
    throwIfAborted(signal);

    await extractArchive(archivePath, extractDir, signal);
    throwIfAborted(signal);

    const extractedJavaPath = findJavaBinary(extractDir);
    if (!extractedJavaPath) {
      throw new Error("Installed Java archive did not include a java executable.");
    }

    const sourceRoot = path.dirname(path.dirname(extractedJavaPath));
    safeRm(installDir);
    ensureDir(path.dirname(installDir));
    fs.cpSync(sourceRoot, installDir, { recursive: true, verbatimSymlinks: true });

    const installedJavaPath = path.join(installDir, "bin", "java");
    if (!existsFile(installedJavaPath)) {
      const nested = findJavaBinary(installDir);
      if (!nested) {
        throw new Error("Installed Java runtime is missing bin/java.");
      }
      if (path.resolve(nested) !== path.resolve(installedJavaPath)) {
        throw new Error("Installed Java runtime layout is unsupported.");
      }
    }

    try {
      fs.chmodSync(installedJavaPath, 0o755);
    } catch {}

    writeInstallMeta(installDir, {
      line: runtimeLine,
      version: runtimeVersion,
      variant: runtimeVariant,
      source: "Adoptium",
      downloadUrl: selection.asset.url,
      archiveSha256: sha256,
      integrity,
      javaRelativePath: path.relative(installDir, installedJavaPath),
      requiresRosetta: Architecture.requiresRosetta(runtimeVariant),
      installedAt: Date.now()
    });

    return {
      line: runtimeLine,
      version: runtimeVersion,
      variant: runtimeVariant,
      installDir,
      javaPath: installedJavaPath,
      requiresRosetta: Architecture.requiresRosetta(runtimeVariant)
    };
  } finally {
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, line, version, variant, installDir } = {}) {
  const target = installDir || getInstallDir({ userDataDir, line, version, variant });
  safeRm(target);
  return true;
}

module.exports = {
  ADOPTIUM_API_BASE,
  INSTALL_META_FILE,
  LTS_LINES,
  VARIANTS,
  normalizeLine,
  isLtsLine,
  normalizeVersion,
  normalizeVariant,
  archToVariant,
  defaultVariantForHost,
  compareVersions,
  compareVersionsDesc,
  versionMajor,
  installRootDir,
  getInstallDir,
  listInstalled,
  fetchAvailableLines,
  fetchAvailableVersionsForLine,
  selectCatalogAsset,
  resolveBestInstalled,
  installVersion,
  uninstallVersion,
  isRosettaAvailable,
  upstream: releasesSource,
  __test: {
    chooseVariantForHost,
    compareVersions,
    extractVersionFromRelease,
    extractAssetFromRelease,
    fetchLineAssets,
    isEmptyCatalogStatus
  }
};
