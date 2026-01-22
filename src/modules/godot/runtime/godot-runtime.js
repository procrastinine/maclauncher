const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const ARCHIVE_URL = "https://godotengine.org/download/archive/";
const INSTALL_META_FILE = ".maclauncher-godot.json";
const DEFAULT_VARIANT = "mono";
const VARIANTS = [{ id: "mono", label: ".NET" }];
const FLAVOR_RANK = {
  stable: 5,
  rc: 4,
  beta: 3,
  alpha: 2,
  dev: 1
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = String(input ?? "").trim();
  if (!v) throw new Error(`Invalid Godot version: ${String(input ?? "")}`);
  if (/[^0-9A-Za-z._-]/.test(v) || v.includes("/") || v.includes("\\")) {
    throw new Error(`Invalid Godot version: ${String(input ?? "")}`);
  }
  return v;
}

function normalizeVariant(input) {
  const v = String(input ?? "").trim().toLowerCase();
  if (!v) return "";
  if (v === "mono" || v === "dotnet") return "mono";
  return "";
}

function resolveVariant(input) {
  const v = normalizeVariant(input) || DEFAULT_VARIANT;
  if (!VARIANTS.some(variant => variant.id === v)) {
    throw new Error(`Unsupported Godot variant: ${String(input ?? "")}`);
  }
  return v;
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "godot");
}

function getInstallDir({ userDataDir, version, variant }) {
  const v = normalizeVersion(version);
  const resolvedVariant = resolveVariant(variant);
  return path.join(installRootDir(userDataDir), v, resolvedVariant);
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

function parseVersionParts(version) {
  const v = String(version || "").trim();
  if (!v) return null;
  const dash = v.indexOf("-");
  const base = dash === -1 ? v : v.slice(0, dash);
  const flavorRaw = dash === -1 ? "" : v.slice(dash + 1);
  const nums = base.split(".").map(part => Number(part));
  if (!nums.length || nums.some(n => !Number.isFinite(n))) return null;

  let kind = "stable";
  let num = 0;
  const flavor = flavorRaw.toLowerCase();
  if (flavor) {
    if (flavor === "stable") {
      kind = "stable";
    } else if (flavor.startsWith("rc")) {
      kind = "rc";
      num = Number(flavor.slice(2)) || 0;
    } else if (flavor.startsWith("beta")) {
      kind = "beta";
      num = Number(flavor.slice(4)) || 0;
    } else if (flavor.startsWith("alpha")) {
      kind = "alpha";
      num = Number(flavor.slice(5)) || 0;
    } else if (flavor.startsWith("dev")) {
      kind = "dev";
      num = Number(flavor.slice(3)) || 0;
    } else {
      kind = flavor;
    }
  }

  return {
    base: nums,
    flavor: { kind, num }
  };
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));

  const max = Math.max(pa.base.length, pb.base.length, 3);
  for (let i = 0; i < max; i++) {
    const av = pa.base[i] || 0;
    const bv = pb.base[i] || 0;
    if (av !== bv) return av - bv;
  }

  const ra = FLAVOR_RANK[pa.flavor.kind] || 0;
  const rb = FLAVOR_RANK[pb.flavor.kind] || 0;
  if (ra !== rb) return ra - rb;
  if (pa.flavor.num !== pb.flavor.num) return pa.flavor.num - pb.flavor.num;
  return String(a || "").localeCompare(String(b || ""));
}

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
}

function findAppBundle(root, variant) {
  const candidates = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.toLowerCase().endsWith(".app")) continue;
    candidates.push(path.join(root, entry.name));
  }

  if (candidates.length === 0) {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nestedRoot = path.join(root, entry.name);
      let nested = [];
      try {
        nested = fs.readdirSync(nestedRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const nestedEntry of nested) {
        if (!nestedEntry.isDirectory()) continue;
        if (!nestedEntry.name.toLowerCase().endsWith(".app")) continue;
        candidates.push(path.join(nestedRoot, nestedEntry.name));
      }
    }
  }

  if (candidates.length === 0) return null;

  const wantsMono = normalizeVariant(variant) === "mono";
  const scored = candidates.map(p => {
    const name = path.basename(p).toLowerCase();
    let score = 0;
    if (name.includes("godot")) score += 2;
    if (wantsMono && (name.includes("mono") || name.includes("dotnet"))) score += 2;
    return { path: p, score, name };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return scored[0]?.path || null;
}

function listInstalled(userDataDir) {
  const root = installRootDir(userDataDir);
  const out = [];
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  } catch {
    return out;
  }

  for (const versionDir of versions) {
    const versionRaw = versionDir.name;
    let version = null;
    try {
      version = normalizeVersion(versionRaw);
    } catch {
      continue;
    }

    let variants = [];
    try {
      variants = fs
        .readdirSync(path.join(root, versionRaw), { withFileTypes: true })
        .filter(entry => entry.isDirectory());
    } catch {
      continue;
    }

    for (const variantDir of variants) {
      const variantRaw = variantDir.name;
      const variant = normalizeVariant(variantRaw);
      if (!variant) continue;
      const installDir = path.join(root, versionRaw, variantRaw);
      const meta = readInstallMeta(installDir);
      const appPath = findAppBundle(installDir, variant);
      if (!meta && !appPath) continue;
      out.push({
        version,
        variant,
        installDir,
        appPath: appPath || null,
        platformKey: "macos",
        source: meta?.source || null
      });
    }
  }

  out.sort((a, b) => {
    const byVersion = compareVersionsDesc(a.version, b.version);
    if (byVersion !== 0) return byVersion;
    return String(a.variant || "").localeCompare(String(b.variant || ""));
  });

  return out;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

async function fetchUrlBuffer(url, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while fetching Godot data");

  const res = await httpGet(url, {
    "User-Agent": "MacLauncher"
  });
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

function extractArchiveAnchors(html) {
  const out = [];
  const text = String(html || "");
  const re = /<a[^>]*class=archive-version[^>]*href=(?:"|')?\/download\/archive\/([A-Za-z0-9._-]+)(?:"|')?/gi;
  let m = null;
  while ((m = re.exec(text))) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function parseArchiveSections(html) {
  const out = [];
  const text = String(html || "");
  const groupRe =
    /<div class=archive-group>[\s\S]*?<h3 id=([^>\s]+)>[^<]*<\/h3>[\s\S]*?(?:archive-version-flavor>([^<]+)<)?[\s\S]*?<\/div><\/div><div class=(?:"card base-padding archive-releases"|card base-padding archive-releases)>([\s\S]*?)(?=<div class=archive-group>|$)/gi;
  let m = null;
  while ((m = groupRe.exec(text))) {
    const baseVersion = m[1] ? String(m[1]).trim() : "";
    const flavor = m[2] ? String(m[2]).trim().toLowerCase() : "";
    const block = m[3] || "";
    const versions = [];
    const seen = new Set();
    const links = extractArchiveAnchors(block);
    for (const version of links) {
      if (seen.has(version)) continue;
      versions.push(version);
      seen.add(version);
    }
    if (baseVersion && versions.length > 0) {
      out.push({ baseVersion, flavor, versions });
    }
  }
  return out;
}

function baseVersionFromSlug(version) {
  const v = String(version || "");
  const dash = v.indexOf("-");
  return dash === -1 ? v : v.slice(0, dash);
}

function extractArchiveVersions(html, latestOnly) {
  const wantsLatest = latestOnly !== false;
  const sections = parseArchiveSections(html);
  if (sections.length > 0) {
    if (!wantsLatest) {
      return sections.flatMap(section => section.versions);
    }
    return sections
      .map(section => {
        const desired = section.flavor
          ? `${section.baseVersion}-${section.flavor}`
          : null;
        if (desired && section.versions.includes(desired)) return desired;
        return section.versions[0] || null;
      })
      .filter(Boolean);
  }

  const versions = extractArchiveAnchors(html);
  if (!wantsLatest) return versions;

  const seen = new Set();
  const latest = [];
  for (const version of versions) {
    const base = baseVersionFromSlug(version);
    if (seen.has(base)) continue;
    latest.push(version);
    seen.add(base);
  }
  return latest;
}

async function fetchAvailableVersions({ latestOnly, logger } = {}) {
  const wantsLatest = latestOnly !== false;
  logger?.info?.(`[godot] fetching archive list from ${ARCHIVE_URL}`);
  const res = await fetchUrlBuffer(ARCHIVE_URL);
  if (res.status !== 200) throw new Error(`Godot archive fetch failed (${res.status})`);
  const decoded = decodeBody(res.body, res.headers);
  const html = decoded.toString("utf8");
  const versions = extractArchiveVersions(html, wantsLatest);
  if (!versions.length) throw new Error("No Godot versions found in archive");
  return { versions, source: "godotengine.org" };
}

function normalizeDownloadUrl(raw) {
  return String(raw || "").replace(/&amp;/g, "&");
}

function extractDownloadLinks(html) {
  const out = [];
  const text = String(html || "");
  const re = /href=["'](https:\/\/downloads\.godotengine\.org\/\?[^"']+)["']/gi;
  let m = null;
  while ((m = re.exec(text))) {
    if (m[1]) out.push(normalizeDownloadUrl(m[1]));
  }
  return out;
}

function selectMacDotNetDownload(links) {
  const list = Array.isArray(links) ? links : [];
  for (const raw of list) {
    let url = null;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const slug = url.searchParams.get("slug") || "";
    const platform = url.searchParams.get("platform") || "";
    if (!slug || !platform) continue;
    const slugLower = slug.toLowerCase();
    const platformLower = platform.toLowerCase();
    const isMac = platformLower.includes("macos") || platformLower.includes("osx");
    const isZip = slugLower.endsWith(".zip");
    const isDotNet = slugLower.includes("mono") || slugLower.includes("dotnet");
    if (!isMac || !isZip || !isDotNet) continue;
    return { url: url.toString(), slug, platform };
  }
  return null;
}

async function resolveDownloadUrl({ version, logger } = {}) {
  const v = normalizeVersion(version);
  const pageUrl = new URL(`${v}/`, ARCHIVE_URL).toString();
  logger?.info?.(`[godot] fetching downloads page ${pageUrl}`);
  const res = await fetchUrlBuffer(pageUrl);
  if (res.status !== 200) throw new Error(`Godot downloads fetch failed (${res.status})`);
  const decoded = decodeBody(res.body, res.headers);
  const html = decoded.toString("utf8");
  const links = extractDownloadLinks(html);
  const selected = selectMacDotNetDownload(links);
  if (!selected) throw new Error("macOS .NET download not found");
  return selected;
}

async function downloadToFile(url, destPath, onProgress, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading Godot");

  const res = await httpGet(url, { "User-Agent": "MacLauncher" });
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

async function extractZip(zipPath, destDir) {
  const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, destDir]);
}

async function copyBundle(src, dest) {
  const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
  await runCommand(ditto, [src, dest]);
}

async function installVersion({ userDataDir, version, variant, logger, onProgress } = {}) {
  const v = normalizeVersion(version);
  const resolvedVariant = resolveVariant(variant);
  const installDir = getInstallDir({ userDataDir, version: v, variant: resolvedVariant });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-godot-"));
  const zipPath = path.join(tmpDir, `godot-${v}-${resolvedVariant}.zip`);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    const download = await resolveDownloadUrl({ version: v, logger });
    logger?.info?.(`[godot] downloading ${download.url}`);
    await downloadToFile(download.url, zipPath, onProgress);
    await extractZip(zipPath, extractDir);

    const appPath = findAppBundle(extractDir, resolvedVariant);
    if (!appPath) throw new Error("Godot app bundle not found in zip");

    safeRm(installDir);
    ensureDir(installDir);
    const destAppPath = path.join(installDir, path.basename(appPath));
    await copyBundle(appPath, destAppPath);

    writeInstallMeta(installDir, {
      version: v,
      variant: resolvedVariant,
      appName: path.basename(destAppPath),
      source: "godotengine.org",
      downloadUrl: download.url,
      installedAt: new Date().toISOString()
    });

    return {
      version: v,
      variant: resolvedVariant,
      installDir,
      appPath: destAppPath,
      platformKey: "macos"
    };
  } finally {
    safeRm(zipPath);
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, version, variant } = {}) {
  const v = normalizeVersion(version);
  const resolvedVariant = resolveVariant(variant);
  const installDir = getInstallDir({ userDataDir, version: v, variant: resolvedVariant });
  safeRm(installDir);
  return true;
}

module.exports = {
  ARCHIVE_URL,
  DEFAULT_VARIANT,
  VARIANTS,
  normalizeVersion,
  normalizeVariant,
  resolveVariant,
  compareVersions,
  compareVersionsDesc,
  installRootDir,
  getInstallDir,
  listInstalled,
  fetchAvailableVersions,
  resolveDownloadUrl,
  installVersion,
  uninstallVersion,
  __test: {
    parseArchiveSections,
    extractArchiveVersions,
    extractDownloadLinks,
    selectMacDotNetDownload,
    compareVersions
  }
};
