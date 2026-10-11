const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const AppBundle = require("../../runtime/app-bundle");
const {
  attachAbortSignal,
  createAbortError,
  fetchUrlBuffer,
  downloadToFile,
  throwIfAborted
} = require("../../runtime/download-utils");

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

function getDarwinPlatformKeys(arch) {
  if (arch === "arm64") return ["osx-arm64", "osx-x64"];
  return ["osx-x64"];
}

function getDownloadUrl(version, platformKey, variant) {
  const v = normalizeVersion(version);
  const pkg = variant === "sdk" ? "nwjs-sdk" : "nwjs";
  return `https://dl.nwjs.io/v${v}/${pkg}-v${v}-${platformKey}.zip`;
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
  const direct = path.join(extractedDir, "nwjs.app");
  if (fs.existsSync(direct)) return extractedDir;

  try {
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(extractedDir, entry.name, "nwjs.app");
      if (fs.existsSync(candidate)) return path.join(extractedDir, entry.name);
    }
  } catch {}

  throw new Error("NW.js extract did not contain nwjs.app");
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

function extractVersionsFromJson(parsed) {
  const out = [];

  function add(val) {
    const v = String(val || "").trim().replace(/^v/i, "");
    if (/^\d+\.\d+\.\d+$/.test(v)) out.push(v);
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object") {
        add(item.version);
        add(item.name);
        add(item.tag_name);
      }
    }
    return out;
  }

  if (parsed && typeof parsed === "object") {
    const maybeList = parsed.versions || parsed.data || parsed.items;
    if (Array.isArray(maybeList)) {
      out.push(...extractVersionsFromJson(maybeList));
    }
  }

  return out;
}

function extractVersionsFromHtml(html) {
  const out = [];
  const re = /href=["']v?(\d+\.\d+\.\d+)\/["']/g;
  let m = null;
  while ((m = re.exec(String(html || "")))) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function extractAvailabilityFromJson(parsed, versions, arch) {
  const records = Array.isArray(parsed) ? parsed : parsed?.versions || parsed?.data || parsed?.items;
  const availability = {};
  for (const item of Array.isArray(records) ? records : []) {
    if (!item || typeof item !== "object") continue;
    const version = String(item.version || item.name || item.tag_name || "").replace(/^v/i, "");
    if (!versions.includes(version) || !Array.isArray(item.files)) continue;
    const nativeKey = arch === "arm64" ? "osx-arm64" : "osx-x64";
    const nativeAvailable = item.files.includes(nativeKey);
    const rosettaFallback = arch === "arm64" && !nativeAvailable && item.files.includes("osx-x64");
    const sdkAvailable = !Array.isArray(item.flavors) || item.flavors.includes("sdk");
    const unavailable = !sdkAvailable || (!nativeAvailable && !rosettaFallback);
    availability[version] = {
      nativeAvailable: nativeAvailable && sdkAvailable,
      rosettaFallback: rosettaFallback && sdkAvailable,
      unavailable,
      mode: unavailable ? "unavailable" : rosettaFallback ? "rosetta" : "native"
    };
  }
  return availability;
}

async function fetchAvailableVersions({ logger, latestOnly, signal, arch = process.arch, fetcher = fetchUrlBuffer } = {}) {
  const sources = [
    "https://nwjs.io/versions.json",
    "https://dl.nwjs.io/versions.json",
    "https://dl.nwjs.io/index.json",
    "https://dl.nwjs.io/"
  ];

  let lastErr = null;

  for (const url of sources) {
    try {
      logger?.info?.(`[nwjs] fetching versions from ${url}`);
      const res = await fetcher(url, { signal });
      if (res.status !== 200) throw new Error(`Fetch failed (${res.status})`);

      const decoded = decodeBody(res.body, res.headers);
      const text = decoded.toString("utf8");

      const isJson = url.endsWith(".json") || String(res.headers?.["content-type"] || "").includes("json");
      const parsed = isJson ? JSON.parse(text) : null;
      const versions = isJson
        ? extractVersionsFromJson(parsed)
        : extractVersionsFromHtml(text);

      const unique = Array.from(new Set(versions)).filter(v => /^\d+\.\d+\.\d+$/.test(v));
      unique.sort(compareSemverDesc);
      if (unique.length === 0) throw new Error("No versions found");
      const visible = unique.slice(0, latestOnly === true ? 1 : 500);
      const availabilityByVersion = extractAvailabilityFromJson(parsed, visible, arch);
      return {
        versions: visible,
        source: url,
        mode: latestOnly === true ? "latest" : "all",
        availabilityByVersion,
        installableVersions: visible.filter(version => availabilityByVersion[version]?.unavailable !== true)
      };
    } catch (e) {
      throwIfAborted(signal);
      lastErr = e;
      logger?.warn?.(`[nwjs] version fetch failed for ${url}: ${String(e?.message || e)}`);
    }
  }

  throw lastErr || new Error("Failed to fetch NW.js versions");
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
    child.stdout.on("data", b => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
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

async function extractZipDarwin(zipPath, destDir, signal) {
  ensureDir(destDir);
  // `ditto` is available on macOS and preserves app bundles correctly.
  await runCommand("/usr/bin/ditto", ["-x", "-k", zipPath, destDir], { signal });
}

function listInstalled(userDataDir) {
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

async function installVersion({
  userDataDir,
  version,
  variant,
  platform,
  arch,
  logger,
  onProgress,
  signal
}) {
  const v = normalizeVersion(version);
  const kind = normalizeVariant(variant);
  const resolvedPlatform = platform || process.platform;
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

    const url = getDownloadUrl(v, platformKey, kind);
    // Publication must stay on the user's data volume (external/shared volumes
    // cannot rename an extraction from macOS's system temporary directory).
    const tmpDir = fs.mkdtempSync(path.join(root, ".install-"));
    const zipPath = path.join(tmpDir, `nwjs-v${v}-${platformKey}-${kind}.zip`);
    const extractDir = path.join(tmpDir, "extract");

    try {
      logger?.info?.(`[nwjs] downloading ${url}`);
      await downloadToFile(url, zipPath, { onProgress, signal });
      throwIfAborted(signal);

      logger?.info?.(`[nwjs] extracting ${path.basename(zipPath)}`);
      await extractZipDarwin(zipPath, extractDir, signal);

      const appRoot = findNwjsAppRoot(extractDir);
      AppBundle.validateAppBundle(path.join(appRoot, "nwjs.app"), {
        executablePath: path.join(appRoot, "nwjs.app", "Contents", "MacOS", "nwjs")
      });

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
        logger?.warn?.(`[nwjs] ${url} not found (404), trying next arch…`);
      } else {
        logger?.error?.("[nwjs] install failed", String(e?.stack || e));
        throw e;
      }
    } finally {
      safeRm(tmpDir);
    }
  }

  throw lastErr || new Error("Failed to install NW.js");
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

function resolveBestInstalled({ userDataDir, version, variant, platform, arch }) {
  const v = normalizeVersion(version);
  const kind = normalizeVariant(variant);

  const resolvedPlatform = platform || process.platform;
  const resolvedArch = arch || process.arch;

  if (resolvedPlatform !== "darwin") {
    throw new Error(`NW.js runtime resolution not implemented for platform=${resolvedPlatform}`);
  }

  const keys = getDarwinPlatformKeys(resolvedArch);
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
  resolveBestInstalled
};
