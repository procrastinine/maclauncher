const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn, spawnSync } = require("node:child_process");

const {
  attachAbortSignal,
  createAbortError,
  downloadToFile,
  fetchUrlBuffer,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

const ADOPTIUM_API_BASE = "https://api.adoptium.net/v3";
const INSTALL_META_FILE = ".maclauncher-java.json";
const LTS_LINES = [8, 11, 17, 21, 25];
const VARIANTS = [
  { id: "arm64", label: "Apple Silicon" },
  { id: "x64", label: "Intel" }
];

let rosettaAvailableCache = null;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function decodeBody(body, headers) {
  const enc = String(headers?.["content-encoding"] || "").toLowerCase();
  try {
    if (enc.includes("gzip")) return zlib.gunzipSync(body);
    if (enc.includes("deflate")) return zlib.inflateSync(body);
    if (enc.includes("br")) return zlib.brotliDecompressSync(body);
  } catch {}
  return body;
}

function isEmptyCatalogStatus(status) {
  return status === 404 || status === 204;
}

function normalizeLine(input) {
  const line = Number(input);
  if (!Number.isFinite(line) || !LTS_LINES.includes(line)) {
    throw new Error(`Unsupported Java line: ${String(input ?? "")}`);
  }
  return line;
}

function normalizeVariant(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "x86_64" || value === "x86-64") return "x64";
  return "";
}

function variantToArch(variant) {
  return normalizeVariant(variant) === "arm64" ? "aarch64" : "x64";
}

function archToVariant(arch) {
  const value = String(arch || "").trim().toLowerCase();
  if (value === "aarch64" || value === "arm64") return "arm64";
  if (value === "x64" || value === "x86_64" || value === "x86-64") return "x64";
  return "";
}

function defaultVariantForHost() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function normalizeVersion(input) {
  const raw = String(input ?? "").trim().replace(/^jdk[-_]?/i, "").replace(/^v/i, "");
  if (!raw) throw new Error(`Invalid Java version: ${String(input ?? "")}`);

  const legacy = raw.match(/^(\d+)u(\d+)-b(\d+)$/i);
  if (legacy) {
    return `${Number(legacy[1])}.0.${Number(legacy[2])}+${Number(legacy[3])}`;
  }

  const semver = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\+(\d+))?/);
  if (!semver) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  const major = Number(semver[1]);
  const minor = Number(semver[2] || 0);
  const patch = Number(semver[3] || 0);
  const build = semver[4] != null ? Number(semver[4]) : null;
  if (![major, minor, patch].every(Number.isFinite)) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  if (build != null && !Number.isFinite(build)) {
    throw new Error(`Invalid Java version: ${String(input ?? "")}`);
  }
  return build == null ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}+${build}`;
}

function parseVersionParts(version) {
  const normalized = normalizeVersion(version);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    build: match[4] != null ? Number(match[4]) : null,
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

  const targetLines = line != null ? [normalizeLine(line)] : LTS_LINES;
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
          requiresRosetta: process.arch === "arm64" && variant === "x64"
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

async function extractArchive(archivePath, destDir, signal) {
  const lower = String(archivePath || "").toLowerCase();
  if (lower.endsWith(".zip")) {
    await runCommand("/usr/bin/ditto", ["-x", "-k", archivePath, destDir], { signal });
    return;
  }
  await runCommand("/usr/bin/tar", ["-xzf", archivePath, "-C", destDir], { signal });
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
    page_size: String(Number.isFinite(size) ? size : 25),
    project: "jdk",
    sort_order: "DESC"
  });
  return `${ADOPTIUM_API_BASE}/assets/feature_releases/${runtimeLine}/ga?${query.toString()}`;
}

function extractVersionFromRelease(release) {
  const candidates = [
    release?.version_data?.semver,
    release?.version?.semver,
    release?.release_name,
    release?.openjdk_version,
    release?.version_data?.openjdk_version,
    release?.binary?.openjdk_version,
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
      ? release.binaries[0]
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

  return {
    line: expectedLine,
    version,
    variant,
    url,
    fileName: name,
    checksum: pkg?.checksum || null,
    size: Number.isFinite(Number(pkg?.size)) ? Number(pkg.size) : null,
    publishedAt
  };
}

async function fetchLineAssets({ line, variant, logger, signal, pageSize = 25 } = {}) {
  const runtimeLine = normalizeLine(line);
  const runtimeVariant = normalizeVariant(variant) || defaultVariantForHost();
  const arch = variantToArch(runtimeVariant);

  const headers = {
    "User-Agent": "MacLauncher",
    "Accept": "application/json"
  };

  const assets = [];
  const maxPages = 5;
  for (let page = 0; page < maxPages; page += 1) {
    const url = buildLineCatalogUrl({ line: runtimeLine, arch, page, pageSize });
    logger?.info?.(`[java] fetching Adoptium catalog ${url}`);
    const res = await fetchUrlBuffer(url, { headers, signal });
    if (isEmptyCatalogStatus(res.status)) {
      logger?.info?.(
        `[java] no Adoptium assets for line ${runtimeLine} (${runtimeVariant})`
      );
      return [];
    }
    if (res.status !== 200) {
      throw new Error(`Java catalog fetch failed (${res.status})`);
    }
    const body = decodeBody(res.body, res.headers);
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (err) {
      throw new Error(`Failed to parse Java catalog response: ${String(err?.message || err)}`);
    }

    const list = Array.isArray(parsed) ? parsed : [];
    for (const release of list) {
      const asset = extractAssetFromRelease(release, runtimeLine, runtimeVariant);
      if (asset) assets.push(asset);
    }

    if (list.length < pageSize) break;
  }

  const byVersion = new Map();
  for (const asset of assets) {
    const current = byVersion.get(asset.version);
    if (!current || asset.publishedAt > current.publishedAt) {
      byVersion.set(asset.version, asset);
    }
  }

  return Array.from(byVersion.values()).sort((a, b) => compareVersionsDesc(a.version, b.version));
}

async function fetchAvailableVersionsForLine({ line, logger, signal } = {}) {
  const runtimeLine = normalizeLine(line);
  const source = `${ADOPTIUM_API_BASE}/assets/feature_releases/${runtimeLine}/ga`;

  const byVersion = new Map();
  for (const variant of ["arm64", "x64"]) {
    const assets = await fetchLineAssets({ line: runtimeLine, variant, logger, signal });
    for (const asset of assets) {
      const current =
        byVersion.get(asset.version) ||
        {
          version: asset.version,
          line: runtimeLine,
          assets: { arm64: null, x64: null }
        };
      current.assets[variant] = asset;
      byVersion.set(asset.version, current);
    }
  }

  const entries = Array.from(byVersion.values()).sort((a, b) => compareVersionsDesc(a.version, b.version));
  return {
    line: runtimeLine,
    source,
    versions: entries.map(entry => entry.version),
    entriesByVersion: Object.fromEntries(entries.map(entry => [entry.version, entry.assets]))
  };
}

function availableVariantsForVersion(entryAssets) {
  const set = new Set();
  if (entryAssets?.arm64) set.add("arm64");
  if (entryAssets?.x64) set.add("x64");
  return set;
}

function chooseVariantForHost({ availableVariants, preferredVariant, hostArch = process.arch }) {
  const preferred = normalizeVariant(preferredVariant);
  const hasArm64 = availableVariants.has("arm64");
  const hasX64 = availableVariants.has("x64");

  if (hostArch === "arm64") {
    if (preferred === "arm64") {
      if (hasArm64) return { variant: "arm64", requiresRosetta: false, mode: "native" };
      if (hasX64) return { variant: "x64", requiresRosetta: true, mode: "rosetta" };
      return null;
    }
    if (preferred === "x64") {
      if (hasX64) return { variant: "x64", requiresRosetta: true, mode: "rosetta" };
      if (hasArm64) return { variant: "arm64", requiresRosetta: false, mode: "native" };
      return null;
    }
    if (hasArm64) return { variant: "arm64", requiresRosetta: false, mode: "native" };
    if (hasX64) return { variant: "x64", requiresRosetta: true, mode: "rosetta" };
    return null;
  }

  if (preferred === "arm64") {
    if (hasX64) return { variant: "x64", requiresRosetta: false, mode: "native" };
    return null;
  }
  if (hasX64) return { variant: "x64", requiresRosetta: false, mode: "native" };
  return null;
}

function selectCatalogAsset({ lineCatalog, version, variant, hostArch = process.arch } = {}) {
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
    const chosen = chooseVariantForHost({
      availableVariants: available,
      preferredVariant: variant,
      hostArch
    });
    if (!chosen) continue;
    const asset = assets[chosen.variant];
    if (!asset) continue;
    return {
      version: candidateVersion,
      variant: chosen.variant,
      requiresRosetta: chosen.requiresRosetta,
      asset
    };
  }

  return null;
}

function resolveBestInstalled({ userDataDir, line, version, variant, hostArch = process.arch } = {}) {
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
  if (process.platform !== "darwin" || process.arch !== "arm64") return true;
  if (!force && rosettaAvailableCache != null) return rosettaAvailableCache;
  try {
    const result = spawnSync("arch", ["-x86_64", "/usr/bin/true"], {
      stdio: "ignore"
    });
    rosettaAvailableCache = result.status === 0;
  } catch {
    rosettaAvailableCache = false;
  }
  return rosettaAvailableCache;
}

async function installVersion({
  userDataDir,
  line,
  version,
  variant,
  logger,
  onProgress,
  signal,
  lineCatalog
} = {}) {
  const runtimeLine = normalizeLine(line);
  const selection = selectCatalogAsset({
    lineCatalog,
    version,
    variant,
    hostArch: process.arch
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
  const fileName = selection.asset.fileName || `java-${runtimeLine}-${runtimeVersion}-${runtimeVariant}.tar.gz`;
  const archivePath = path.join(tmpDir, fileName);
  const extractDir = path.join(tmpDir, "extract");

  try {
    ensureDir(extractDir);
    logger?.info?.(`[java] downloading ${selection.asset.url}`);
    await downloadToFile(selection.asset.url, archivePath, {
      headers: { "User-Agent": "MacLauncher" },
      onProgress,
      signal
    });
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
    fs.cpSync(sourceRoot, installDir, { recursive: true });

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
      javaRelativePath: path.relative(installDir, installedJavaPath),
      requiresRosetta: process.arch === "arm64" && runtimeVariant === "x64",
      installedAt: Date.now()
    });

    return {
      line: runtimeLine,
      version: runtimeVersion,
      variant: runtimeVariant,
      installDir,
      javaPath: installedJavaPath,
      requiresRosetta: process.arch === "arm64" && runtimeVariant === "x64"
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
  normalizeVersion,
  normalizeVariant,
  variantToArch,
  archToVariant,
  defaultVariantForHost,
  compareVersions,
  compareVersionsDesc,
  versionMajor,
  installRootDir,
  getInstallDir,
  listInstalled,
  fetchAvailableVersionsForLine,
  selectCatalogAsset,
  resolveBestInstalled,
  installVersion,
  uninstallVersion,
  isRosettaAvailable,
  __test: {
    chooseVariantForHost,
    compareVersions,
    extractVersionFromRelease,
    isEmptyCatalogStatus
  }
};
