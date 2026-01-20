const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

async function fetchUrlBuffer(url, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while fetching NW.js versions");

  const res = await httpGet(url);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return fetchUrlBuffer(nextUrl, redirectDepth + 1);
  }

  const chunks = [];
  return new Promise((resolve, reject) => {
    res.on("data", c => chunks.push(Buffer.from(c)));
    res.on("error", reject);
    res.on("end", () => resolve({ status, headers: res.headers || {}, body: Buffer.concat(chunks) }));
  });
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

async function fetchAvailableVersions({ logger } = {}) {
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
      const res = await fetchUrlBuffer(url);
      if (res.status !== 200) throw new Error(`Fetch failed (${res.status})`);

      const decoded = decodeBody(res.body, res.headers);
      const text = decoded.toString("utf8");

      const isJson = url.endsWith(".json") || String(res.headers?.["content-type"] || "").includes("json");
      const versions = isJson
        ? extractVersionsFromJson(JSON.parse(text))
        : extractVersionsFromHtml(text);

      const unique = Array.from(new Set(versions)).filter(v => /^\d+\.\d+\.\d+$/.test(v));
      unique.sort(compareSemverDesc);
      if (unique.length === 0) throw new Error("No versions found");
      return { versions: unique, source: url };
    } catch (e) {
      lastErr = e;
      logger?.warn?.(`[nwjs] version fetch failed for ${url}: ${String(e?.message || e)}`);
    }
  }

  throw lastErr || new Error("Failed to fetch NW.js versions");
}

async function downloadToFile(url, destPath, onProgress, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading NW.js");

  const res = await httpGet(url);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFile(nextUrl, destPath, onProgress, redirectDepth + 1);
  }

  if (status !== 200) {
    res.resume();
    const err = new Error(`Download failed (${status})`);
    err.statusCode = status;
    throw err;
  }

  const total = Number(res.headers["content-length"] || 0) || null;

  ensureDir(path.dirname(destPath));
  const out = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    const cleanup = e => {
      try {
        out.close();
      } catch {}
      safeRm(destPath);
      reject(e);
    };

    res.on("data", chunk => {
      downloaded += chunk.length || 0;
      try {
        onProgress?.({ downloaded, total });
      } catch {}
    });
    res.on("error", cleanup);
    out.on("error", cleanup);
    out.on("finish", () => resolve({ downloaded, total }));
    res.pipe(out);
  });
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", b => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractZipDarwin(zipPath, destDir) {
  ensureDir(destDir);
  // `ditto` is available on macOS and preserves app bundles correctly.
  await runCommand("/usr/bin/ditto", ["-x", "-k", zipPath, destDir]);
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
          if (!exePath || !fs.existsSync(exePath)) continue;
          const key = `${version}-${platformKey}-${variant}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ version, platformKey, variant, installDir, executablePath: exePath });
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
  onProgress
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
    if (exePath && fs.existsSync(exePath)) {
      return { version: v, platformKey, variant: kind, installDir, executablePath: exePath };
    }

    const url = getDownloadUrl(v, platformKey, kind);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-nwjs-"));
    const zipPath = path.join(tmpDir, `nwjs-v${v}-${platformKey}-${kind}.zip`);
    const extractDir = path.join(tmpDir, "extract");

    try {
      logger?.info?.(`[nwjs] downloading ${url}`);
      await downloadToFile(url, zipPath, onProgress);

      logger?.info?.(`[nwjs] extracting ${path.basename(zipPath)}`);
      await extractZipDarwin(zipPath, extractDir);

      const appRoot = findNwjsAppRoot(extractDir);

      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.renameSync(appRoot, installDir);

      const finalExe = getExecutablePathForInstallDir(platformKey, installDir);
      if (!finalExe || !fs.existsSync(finalExe)) {
        throw new Error("Installed NW.js executable missing after extraction");
      }

      return { version: v, platformKey, variant: kind, installDir, executablePath: finalExe };
    } catch (e) {
      lastErr = e;
      const statusCode = Number(e?.statusCode || 0);
      if (statusCode === 404) {
        logger?.warn?.(`[nwjs] ${url} not found (404), trying next arch…`);
      } else {
        logger?.error?.("[nwjs] install failed", String(e?.stack || e));
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
      if (exe && fs.existsSync(exe)) {
        return { version: v, platformKey, variant: kind, installDir, executablePath: exe };
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
