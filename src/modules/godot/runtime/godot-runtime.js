const fs = require("node:fs");
const { cloneOrCopy } = require("../../shared/copy-file");
const os = require("node:os");
const path = require("node:path");
const AppBundle = require("../../shared/runtime/app-bundle");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const Archive = require("../../shared/runtime/archive");
const ReleaseFiles = require("../../shared/runtime/release-files");
const Upstream = require("../../shared/runtime/upstream");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const ARCHIVE_URL = "https://godotengine.org/download/archive/";
const MAX_CATALOG_VERSIONS = 500;
const INSTALL_META_FILE = ".maclauncher-godot.json";
const DEFAULT_VARIANT = "mono";
const VARIANTS = [{ id: "standard", label: "Standard" }, { id: "mono", label: ".NET" }];
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
  if (v === "standard") return "standard";
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
  return structuredClone(require("../../../core/coordinated-runtime-managers").memoizeRuntimeResolution(module.exports,
    JSON.stringify(["listInstalled", userDataDir]), () => listInstalledUncached(userDataDir)));
}

function listInstalledUncached(userDataDir) {
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
        ...AppBundle.appBundleStatus(appPath),
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

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getTagAttribute(tag, name) {
  const attrName = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "i"
  );
  const match = re.exec(String(tag || ""));
  if (!match) return "";
  return decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "");
}

function tagHasClass(tag, className) {
  const classes = getTagAttribute(tag, "class")
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);
  return classes.includes(className);
}

function findNextTagWithClass(text, tagName, className, startIndex = 0) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  re.lastIndex = startIndex;
  let match = null;
  while ((match = re.exec(text))) {
    if (tagHasClass(match[0], className)) {
      return { index: match.index, endIndex: re.lastIndex };
    }
  }
  return null;
}

function extractFirstTagAttribute(text, tagName, attrName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const match = re.exec(String(text || ""));
  if (!match) return "";
  return getTagAttribute(match[0], attrName);
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function extractFirstClassText(text, tagName, className) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match = null;
  while ((match = re.exec(String(text || "")))) {
    const openTagMatch = /^<[^>]*>/.exec(match[0]);
    if (!openTagMatch || !tagHasClass(openTagMatch[0], className)) continue;
    return stripHtmlTags(match[1]).toLowerCase();
  }
  return "";
}

function archiveSlugFromHref(href) {
  const raw = decodeHtmlAttribute(href).trim();
  if (!raw) return "";
  let pathname = raw;
  try {
    pathname = new URL(raw, ARCHIVE_URL).pathname;
  } catch {}
  const match = /^\/download\/archive\/([A-Za-z0-9._-]+)\/?$/.exec(pathname);
  return match?.[1] || "";
}

// Version links of the archive page. Without the archive-version class, as
// after a site redesign, any link to a version's archive page counts.
function extractArchiveAnchors(html, { anyClass = false } = {}) {
  const out = [];
  const seen = new Set();
  const text = String(html || "");
  const re = /<a\b[^>]*>/gi;
  let m = null;
  while ((m = re.exec(text))) {
    if (!anyClass && !tagHasClass(m[0], "archive-version")) continue;
    const slug = archiveSlugFromHref(getTagAttribute(m[0], "href"));
    if (!slug || seen.has(slug) || anyClass && !parseVersionParts(slug)) continue;
    out.push(slug);
    seen.add(slug);
  }
  return out;
}

function parseArchiveSections(html) {
  const out = [];
  const text = String(html || "");
  let position = 0;
  while (position < text.length) {
    const group = findNextTagWithClass(text, "div", "archive-group", position);
    if (!group) break;
    const nextGroup = findNextTagWithClass(text, "div", "archive-group", group.endIndex);
    const segmentEnd = nextGroup ? nextGroup.index : text.length;
    const segment = text.slice(group.index, segmentEnd);
    const baseVersion = extractFirstTagAttribute(segment, "h3", "id").trim();
    const flavor = extractFirstClassText(segment, "span", "archive-version-flavor").trim();
    const releases = findNextTagWithClass(segment, "div", "archive-releases", 0);
    const block = releases ? segment.slice(releases.index) : "";
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
    position = segmentEnd;
  }
  return out;
}

function baseVersionFromSlug(version) {
  const v = String(version || "");
  const dash = v.indexOf("-");
  return dash === -1 ? v : v.slice(0, dash);
}

function extractArchiveVersions(html, latestOnly) {
  const wantsLatest = latestOnly === true;
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

  let versions = extractArchiveAnchors(html);
  if (!versions.length) versions = extractArchiveAnchors(html, { anyClass: true });
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

// Godot lists every release on its archive page, grouped by version; each
// release's own page links its downloads.
const source = Upstream.index({ locations: [ARCHIVE_URL], parse: ([document], { latestOnly }) =>
  Array.from(new Set(extractArchiveVersions(document.text, latestOnly === true))).filter(has64BitMacRelease).sort(compareVersionsDesc)
    .slice(0, MAX_CATALOG_VERSIONS).map(version => ({ version, sourceUrl: new URL(`${version}/`, ARCHIVE_URL).toString() })) });

async function fetchAvailableVersions({ latestOnly, logger, signal } = {}) {
  const wantsLatest = latestOnly === true;
  logger?.info?.(`[godot] fetching archive list from ${ARCHIVE_URL}`);
  const rows = await source.discover({ logger, signal, latestOnly: wantsLatest });
  if (!rows.length) throw new Error("No Godot versions found in archive");
  return { versions: rows.map(row => row.version), rows, source: ARCHIVE_URL, mode: wantsLatest ? "latest" : "all" };
}

function normalizeDownloadUrl(raw) {
  return String(raw || "").replace(/&amp;/g, "&");
}

// Download links: the publisher's download service with its slug and
// platform, or a direct HTTPS link to an archive file.
function extractDownloadLinks(html) {
  const out = [];
  const text = String(html || "");
  const re = /href=["'](https:\/\/[^"'\s]+)["']/gi;
  let m = null;
  while ((m = re.exec(text))) {
    const link = normalizeDownloadUrl(m[1]);
    if (/^https:\/\/downloads\.godotengine\.org\/\?/.test(link) || Archive.archiveKind(link.split(/[?#]/)[0])) out.push(link);
  }
  return out;
}

// The Mac editor archive of the selected variant. ZIP comes first, then tar
// and disk images, so a publisher's change of format is still followed.
function selectMacDownload(links, variant = DEFAULT_VARIANT) {
  const list = Array.isArray(links) ? links : [];
  const candidates = [];
  for (const raw of list) {
    let url = null;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const service = url.hostname === "downloads.godotengine.org";
    const slug = service ? url.searchParams.get("slug") || "" : path.posix.basename(url.pathname);
    const platform = service ? url.searchParams.get("platform") || "" : Archive.isMacName(slug.replace(/\./g, "_")) ? "macos" : "";
    if (!slug || !platform) continue;
    const slugLower = slug.toLowerCase();
    const platformLower = platform.toLowerCase();
    const isMac = platformLower.includes("macos") || platformLower.includes("osx");
    const kind = Archive.archiveKind(slugLower);
    const isDotNet = slugLower.includes("mono") || slugLower.includes("dotnet");
    if (!isMac || !kind || /export_templates|debug_symbols|\.sha|checksum/.test(slugLower) ||
      isDotNet !== (resolveVariant(variant) === "mono") || /(?:^|\.)32(?:\.|$)/.test(platformLower)) continue;
    // Godot 2.1 publishes one Intel fat archive; its archive page still names
    // separate 32/64-bit files that the publisher does not distribute.
    const releaseVersion = url.searchParams.get("version") || "";
    if (service && /^2\.1(?:\.|$)/.test(releaseVersion) && /^osx\.(?:32|64)\.zip$/i.test(slug)) {
      url.searchParams.set("slug", "osx.fat.zip");
      return { url: url.toString(), slug: "osx.fat.zip", platform };
    }
    candidates.push({ url: url.toString(), slug, platform, rank: ["zip", "tar", "dmg"].indexOf(kind) });
  }
  const [selected] = candidates.sort((a, b) => a.rank - b.rank);
  return selected ? { url: selected.url, slug: selected.slug, platform: selected.platform } : null;
}

function selectMacDotNetDownload(links) {return selectMacDownload(links, "mono");}

function has64BitMacRelease(version) {
  const [major = 0, minor = 0, patch = 0] = parseVersionParts(version)?.base || [];
  return major > 2 || major === 2 && (minor > 0 || patch > 0);
}

// The Mac editor download of a listed release, read from its release page.
// Godot 2.0 releases remain in the original publisher repository, whose
// archive pages name absent files, so their exact release assets are read.
async function resolveDownloadUrl({ version, variant, sourceUrl, logger, signal } = {}) {
  const v = normalizeVersion(version);
  if (!has64BitMacRelease(v)) throw new Error("Godot 1.x and 2.0 have no 64-bit macOS download.");
  const [major, minor] = parseVersionParts(v).base, wanted = resolveVariant(variant);
  const early = major === 2 && minor === 0;
  const page = Upstream.index({ locations: [early ? `https://api.github.com/repos/godotengine/godot/releases/tags/${encodeURIComponent(v)}`
    : sourceUrl || new URL(`${v}/`, ARCHIVE_URL).toString()], hosts: ["godotengine.org", "github.com"], parse: ([document]) => {
    if (early) {
      const release = JSON.parse(document.text);
      const asset = wanted === "standard" && release.tag_name === v && release.assets?.find(item => /osx(?:\.|_)(?:fat|64)\.zip$/i.test(item.name || ""));
      return [{ version: v, files: asset ? [{ name: asset.name, url: asset.browser_download_url, bytes: asset.size, digest: asset.digest }] : [] }];
    }
    const selected = selectMacDownload(extractDownloadLinks(document.text), wanted);
    return [{ version: v, files: selected ? [{ name: selected.slug, url: selected.url }] : [] }];
  } });
  logger?.info?.(`[godot] reading the ${v} downloads`);
  const [file] = (await page.discover({ logger, signal }))[0]?.files || [];
  if (!file) throw new Error(early ? "This Godot release has no supported 64-bit macOS download."
    : `macOS ${wanted === "mono" ? ".NET" : "Standard"} download not found`);
  return file;
}

function extractZip(zipPath, destDir, signal) {
  return ReleaseFiles.extractArchive(zipPath, destDir, signal);
}

async function copyBundle(src, dest, signal) {
  await cloneOrCopy(src, dest, { signal });
}

async function installVersion({ userDataDir, version, variant, sourceUrl, logger, onProgress, signal } = {}) {
  const v = normalizeVersion(version);
  const resolvedVariant = resolveVariant(variant);
  const installDir = getInstallDir({ userDataDir, version: v, variant: resolvedVariant });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-godot-"));
  let zipPath = path.join(tmpDir, `godot-${v}-${resolvedVariant}.zip`);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    const download = await resolveDownloadUrl({ version: v, variant: resolvedVariant, sourceUrl, logger, signal });
    // The archive keeps the published file's format.
    zipPath = path.join(tmpDir, `godot-${v}-${resolvedVariant}${ReleaseFiles.archiveFormat(download.name) || ".zip"}`);
    logger?.info?.(`[godot] downloading ${download.url}`);
    const { sha256, integrity } = await source.download(download, zipPath, { onProgress, signal });
    throwIfAborted(signal);
    await extractZip(zipPath, extractDir, signal);

    const appPath = findAppBundle(extractDir, resolvedVariant);
    if (!appPath) throw new Error("Godot app bundle not found in zip");
    const executable = AppBundle.resolveAppBundleExecutablePath(appPath);
    const architectures = readMachOLoadCommands(executable).architectures;
    const selected = require("../../shared/runtime/architecture").selectedArchitecture();
    const nativeArch = selected === "x64" ? "x86_64" : selected;
    if (!architectures.includes(nativeArch) && !(nativeArch === "arm64" && architectures.includes("x86_64"))) {
      throw new Error("The Godot download has no supported 64-bit executable for this Mac.");
    }

    safeRm(installDir);
    ensureDir(installDir);
    const destAppPath = path.join(installDir, path.basename(appPath));
    await copyBundle(appPath, destAppPath, signal);

    writeInstallMeta(installDir, {
      version: v,
      variant: resolvedVariant,
      architectures,
      appName: path.basename(destAppPath),
      source: "godotengine.org",
      downloadUrl: download.url,
      archiveSha256: sha256,
      integrity,
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
  source,
  __test: {
    findAppBundle,
    parseArchiveSections,
    extractArchiveVersions,
    extractDownloadLinks,
    selectMacDownload,
    selectMacDotNetDownload,
    compareVersions
  }
};
