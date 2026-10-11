const crypto = require("node:crypto");
const path = require("node:path");
const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../../shared/runtime/runtime-catalog");

const ID = "gamemaker-official";
const VERSION = /^(?:1\.4\.\d{1,5}|\d{1,4}\.\d{1,5}\.\d{1,5}\.\d{1,6})$/;
const FEEDS = Object.freeze([
  { channel: "Stable", url: "https://gms.yoyogames.com/Zeus-Runtime.rss" },
  { channel: "LTS 2026", url: "https://gms.yoyogames.com/Zeus-Runtime-LTS2026.rss" },
  { channel: "LTS 2022", url: "https://gms.yoyogames.com/Zeus-Runtime-LTS.rss" },
  { channel: "Studio 1.4", family: "studio-1.4", url: "https://store.yoyogames.com/downloads/gm-studio/update-studio.rss" }
]);
const states = new Map();
const refreshing = new Map();
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function versionCompare(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let index = 0; index < 4; index++) if ((x[index] || 0) !== (y[index] || 0)) return (y[index] || 0) - (x[index] || 0);
  return 0;
}
function xmlText(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const entities = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (entities[entity]) return entities[entity];
    const number = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    if (!Number.isSafeInteger(number) || number < 32 || number > 0x10ffff) throw new Error("Invalid runtime feed XML entity.");
    return String.fromCodePoint(number);
  });
}
function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (Object.hasOwn(result, match[1]) || match[3].length > 4096) throw new Error("Duplicate or oversized runtime feed attribute.");
    result[match[1]] = xmlText(match[3]);
  }
  return result;
}
function officialPackage(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "gms.yoyogames.com" || url.port || url.username || url.password || url.search || url.hash ||
    !/^\/[A-Za-z0-9._-]{1,150}\.zip$/.test(url.pathname)) throw new Error("Runtime feed package is not a public official GameMaker ZIP.");
  url.protocol = "https:";
  return url.toString();
}
function legacyPackage(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password || url.search || url.hash) throw new Error("Legacy runtime feed package is not a public official GameMaker ZIP.");
  const prefix = url.hostname === "updater.yoyogames.com" ? "/api/download/mac/" : url.hostname === "store.yoyogames.com" ? "/downloads/gm-studio/" : null;
  const filename = prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.zip$/i.test(filename)) throw new Error("Legacy runtime feed package is not a public official GameMaker ZIP.");
  return `https://store.yoyogames.com/downloads/gm-studio/${filename}`;
}
function packageFromTag(tag, module, version, legacy = false) {
  const attr = attributes(tag), tagVersion = attr["sparkle:version"] || attr["ns0:version"];
  if (tagVersion && tagVersion !== version) throw new Error("Runtime module version disagrees with its release.");
  const bytes = Number(attr.length), signature = attr["sparkle:dsaSignature"] || attr["ns0:dsaSignature"];
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1024 ** 3 || !/^[A-Za-z0-9+/=]{20,512}$/.test(signature || "")) throw new Error("Runtime feed module lacks a bounded size/vendor signature.");
  const url = legacy ? legacyPackage(attr.url) : officialPackage(attr.url);
  return { module, url, filename: path.posix.basename(new URL(url).pathname), bytes, signature,
    ...(legacy ? { publishedUrl: attr.url } : {}) };
}
function parseFeed(body, feed) {
  if (!FEEDS.some(item => item.url === feed?.url) || body.length > 8 * 1024 ** 2) throw new Error("Invalid official runtime feed source or size.");
  const xml = body.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/.test(xml)) throw new Error("Runtime feed must be bounded RSS without external entities.");
  const entries = [], feedSha256 = digest(body);
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    if (entries.length >= 500) throw new Error("Runtime feed has too many releases.");
    const item = match[1], enclosure = /<enclosure\b([^>]*)>([\s\S]*?)<\/enclosure>/.exec(item);
    if (!enclosure) continue;
    const attr = attributes(enclosure[1]), version = attr["sparkle:version"] || attr["ns0:version"];
    const legacy = feed.family === "studio-1.4";
    const macTags = legacy ? [...enclosure[2].matchAll(/<module\b([^>]*?)\/?\s*>/g)].filter(tag => attributes(tag[1]).name === "Mac") : [];
    if (legacy && !macTags.length) continue;
    if (legacy ? !/^1\.4\.\d{1,5}$/.test(version || "") : !/^\d{1,4}\.\d{1,5}\.\d{1,5}\.\d{1,6}$/.test(version || "")) throw new Error("Runtime feed release lacks an exact four-part version or legacy Studio 1.4 build.");
    if (legacy && macTags.length !== 1) throw new Error("Runtime feed contains duplicate Mac modules.");
    const packages = legacy ? [packageFromTag(macTags[0][1], "mac", version, true)] : [packageFromTag(enclosure[1], "core", version)];
    if (legacy) {
      entries.push({ version, upstreamRevision: `vendor-runtime:${version}`, backend: "official-studio-vm", family: "studio-1.4", channel: feed.channel,
        source: feed.url, sourceUrl: feed.url, feedSha256, publishedAt: /<pubDate>([^<]*)<\/pubDate>/.exec(item)?.[1] || null,
        packages, gameplayQualified: false, provenance: "official-https-feed", vendorSignatureVerified: false });
      continue;
    }
    const names = new Set(["core"]);
    for (const moduleTag of enclosure[2].matchAll(/<module\b([^>]*?)\/?\s*>/g)) {
      const module = attributes(moduleTag[1]).name;
      if (!["mac", "macYYC", "base-module-osx-arm64", "base-module-osx-x64"].includes(module)) continue;
      if (names.has(module)) throw new Error("Runtime feed contains duplicate Mac modules.");
      names.add(module); packages.push(packageFromTag(moduleTag[1], module, version));
    }
    if (!names.has("mac")) continue;
    entries.push({ version, upstreamRevision: `vendor-runtime:${version}`, backend: "official-studio-vm", channel: feed.channel,
      source: feed.url, sourceUrl: feed.url, feedSha256, publishedAt: /<pubDate>([^<]*)<\/pubDate>/.exec(item)?.[1] || null,
      packages, gameplayQualified: false, provenance: "official-https-feed", vendorSignatureVerified: false });
  }
  if (!entries.length) throw new Error("Official feed contained no Mac runtime releases.");
  return entries;
}
function validateEntry(entry) {
  try {
    if (!VERSION.test(entry.version || "") || entry.upstreamRevision !== `vendor-runtime:${entry.version}` ||
      !FEEDS.some(feed => feed.url === entry.source) || !/^[a-f0-9]{64}$/.test(entry.feedSha256 || "") ||
      !Array.isArray(entry.packages) || entry.packages.length < 1 || entry.packages.length > 5) return false;
    const legacy = entry.family === "studio-1.4";
    if (legacy && (!/^1\.4\.\d{1,5}$/.test(entry.version) || entry.source !== FEEDS.find(feed => feed.family === "studio-1.4").url)) return false;
    const modules = entry.packages.map(item => item.module);
    if ((!legacy && !modules.includes("core")) || !modules.includes("mac") || (legacy && modules.length !== 1) || new Set(modules).size !== modules.length ||
      modules.some(module => !["core", "mac", "macYYC", "base-module-osx-arm64", "base-module-osx-x64"].includes(module))) return false;
    if (!legacy && entry.source === FEEDS.find(feed => feed.family === "studio-1.4").url) return false;
    return entry.packages.every(item => (legacy ? legacyPackage(item.url) === item.url && legacyPackage(item.publishedUrl) === item.url : officialPackage(item.url) === item.url) && path.posix.basename(new URL(item.url).pathname) === item.filename &&
      Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= 1024 ** 3 && /^[A-Za-z0-9+/=]{20,512}$/.test(item.signature || ""));
  } catch { return false; }
}
const packageIdentity = entry => JSON.stringify([...entry.packages].sort((a, b) => a.module.localeCompare(b.module)).map(({ module, url, bytes, signature }) => ({ module, url, bytes, signature })));
function cachedCatalog(userDataDir) {
  return userDataDir ? readRuntimeCatalog({ userDataDir, managerId: ID, validateEntry }) : null;
}
function stateFor(userDataDir) { return states.get(userDataDir) || { status: cachedCatalog(userDataDir) ? "success" : "idle", error: null }; }
async function refreshCatalog({ userDataDir, signal, logger, onProgress, fetch = fetchUrlBuffer } = {}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir) || userDataDir.includes("\0")) throw new Error("Runtime Refresh needs the launcher's absolute data directory.");
  if (refreshing.has(userDataDir)) return refreshing.get(userDataDir);
  const refresh = (async () => {
    states.set(userDataDir, { status: "loading", error: null });
    try {
      const results = await Promise.all(FEEDS.map(async feed => {
        const timedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        const response = await fetch(feed.url, { signal: timedSignal, maxRedirects: 0, headers: { "User-Agent": "MacLauncher/1.0" } });
        if (response.status !== 200) throw new Error(`${feed.channel} runtime feed returned HTTP ${response.status}.`);
        throwIfAborted(signal);
        const entries = parseFeed(response.body, feed);
        onProgress?.({ phase: "catalog", channel: feed.channel, releases: entries.length });
        return entries;
      }));
      const prior = new Map((cachedCatalog(userDataDir)?.entries || []).map(entry => [entry.version, entry]));
      const merged = new Map();
      for (const entry of results.flat()) {
        const old = prior.get(entry.version), duplicate = merged.get(entry.version);
        if (old && packageIdentity(old) !== packageIdentity(entry)) throw new Error(`Official ${entry.version} artifact identity changed since the last refresh; existing selection was preserved.`);
        if (duplicate && packageIdentity(duplicate) !== packageIdentity(entry)) throw new Error(`Official feeds disagree on ${entry.version} package identities.`);
        merged.set(entry.version, duplicate ? { ...duplicate, channels: [...new Set([...(duplicate.channels || [duplicate.channel]), entry.channel])] } : entry);
      }
      const entries = [...merged.values()].sort((a, b) => versionCompare(a.version, b.version));
      require("./official-installer").ownedDirectory(userDataDir, "runtimes/gamemaker-official");
      const result = writeRuntimeCatalog({ userDataDir, managerId: ID, entries, source: FEEDS.map(feed => feed.url).join(" · ") });
      states.set(userDataDir, { status: "success", error: null });
      logger?.info?.(`[gamemaker] refreshed ${entries.length} official Mac runtime releases`);
      return result;
    } catch (error) { states.set(userDataDir, { status: "error", error: error.message }); throw error; }
    finally { refreshing.delete(userDataDir); }
  })();
  refreshing.set(userDataDir, refresh);
  return refresh;
}
function selectPackages(release, arch = process.arch) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Official runtime installation supports Apple Silicon and Intel Macs.");
  if (release.family === "studio-1.4") return require("./official-legacy").resolveBuild(release.version).packages;
  const byName = new Map(release.packages.map(item => [item.module, item]));
  const baseModules = release.packages.filter(item => item.module.startsWith("base-module-osx-"));
  const base = byName.get(`base-module-osx-${arch}`);
  if (baseModules.length && !base) throw new Error(`Official ${release.version} does not offer a ${arch} native base module.`);
  if (!byName.has("core") || !byName.has("mac") || !byName.has("macYYC")) throw new Error(`Official ${release.version} is missing the Mac modules required by Igor.`);
  return [byName.get("core"), ...(base ? [base] : []), byName.get("mac"), byName.get("macYYC")];
}
module.exports = { FEEDS, VERSION, versionCompare, parseFeed, validateEntry, cachedCatalog, stateFor, refreshCatalog, selectPackages, packageIdentity };
