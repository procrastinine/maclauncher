const path = require("node:path");
const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");
const { MAX_CATALOG_ENTRIES } = require("../../shared/runtime/runtime-catalog");
const { VERSION } = require("../detect");

const API = "https://services.api.unity.com/unity/editor/release/v1/releases";
const SOURCE = "https://unity.com/releases/editor/archive";
const MAX_PAGE_SIZE = 25;
const REVIEWED = Object.freeze([{ version: "2020.1.17f1", upstreamRevision: "9957aee8edc2", sourceKind: "release",
  sourceUrl: "https://unity.com/releases/editor/whats-new/2020.1.17f1", releaseDate: "2020-12-09T11:39:40.055Z",
  scriptingBackend: "mono", templateArchitectures: ["x86_64"], minimumMacOS: "10.12",
  asset: { url: "https://download.unity3d.com/download_unity/9957aee8edc2/MacEditorTargetInstaller/UnitySetup-Mac-Mono-Support-for-Editor-2020.1.17f1.pkg",
    filename: "UnitySetup-Mac-Mono-Support-for-Editor-2020.1.17f1.pkg", sha256: "c9db8f02fdd314682f369b31054771add02313b8e40872bf53870861845319c7",
    md5: "8d4a4a27d54b5ac6203bf353c2275954", integritySource: "reviewed-signed-installer-sha256", size: 142522361,
    publisherIdentity: "Unity Technologies ApS (BVPN9UFA9B)" } },
  { version: "5.3.2p3", upstreamRevision: "b6c1a63227dc", sourceKind: "release", sourceUrl: "https://unity.com/releases/editor/whats-new/5.3.2p3",
    scriptingBackend: "mono", templateArchitectures: ["x86_64"], minimumMacOS: "10.7", playerLayout: "fused-mono",
    asset: { url: "https://download.unity3d.com/download_unity/b6c1a63227dc/MacEditorTargetInstaller/UnitySetup-Mac-Support-for-Editor-5.3.2p3.pkg",
      filename: "UnitySetup-Mac-Support-for-Editor-5.3.2p3.pkg", sha256: "afdcedba4167a920e94f0cbb6118ee819aa51bcf969c8e269ab52bc2ab992bcd",
      md5: "90d81f8230257409b3ddbd8e347cc312", integritySource: "reviewed-signed-installer-sha256", size: 101800098,
      publisherIdentity: "Unity Technologies ApS", publisherCertificateSha256: "b5b1c5b631c1d95d089ac28b8a8a899fdeacf730c562c10d54954680f7c2369e" } }]);

function parseIntegrity(integrity) {
  const match = /^(md5|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || "");
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64"), text = bytes.toString("ascii"), length = match[1] === "md5" ? 16 : 32;
  const digest = bytes.length === length ? bytes.toString("hex") : new RegExp(`^[a-f0-9]{${length * 2}}$`, "i").test(text) ? text.toLowerCase() : null;
  return digest ? { algorithm: match[1], digest } : null;
}

function releaseEntry(release) {
  if (!release || !VERSION.test(release.version || "") || !/^[a-f0-9]{12,40}$/.test(release.shortRevision || "") || !Array.isArray(release.downloads)) return null;
  const modules = release.downloads.flatMap(download => Array.isArray(download?.modules)
    ? download.modules.filter(module => module && typeof module === "object").map(module => ({ ...module, platform: download.platform })) : []);
  const legacy = Number(release.version.split(".")[0]) <= 2017;
  const candidates = modules.filter(module => (module.id === "mac-mono" || (legacy && module.id === "mac")) && module.type === "PKG").sort((a, b) => Number(b.platform === "LINUX") - Number(a.platform === "LINUX"));
  for (const module of candidates) {
    let url;
    try { url = new URL(module.url); } catch { continue; }
    const filename = path.posix.basename(url.pathname), digest = parseIntegrity(module.integrity);
    if (url.protocol !== "https:" || url.hostname !== "download.unity3d.com" || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(`/download_unity/${release.shortRevision}/`) || filename !== `UnitySetup-Mac-${module.id === "mac" ? "" : "Mono-"}Support-for-Editor-${release.version}.pkg` || !digest) continue;
    const size = module.downloadSize?.unit === "BYTE" && Number.isSafeInteger(module.downloadSize.value) ? module.downloadSize.value : null;
    const entry = { version: release.version, upstreamRevision: release.shortRevision, sourceKind: "release",
      sourceUrl: `https://unity.com/releases/editor/whats-new/${release.version}`, releaseDate: release.releaseDate || null,
      scriptingBackend: "mono", securityLabel: release.label?.labelText || null,
      asset: { url: url.toString(), filename, ...(digest.algorithm === "sha256" ? { sha256: digest.digest } : { md5: digest.digest, integrity: "publisher-md5" }),
        size, publisherIdentity: "Unity Technologies ApS (BVPN9UFA9B)" } };
    // Preserve verified legacy certificates/SHA-256 only for the same published
    // component identity, never for a reissued package or another revision.
    const verified = REVIEWED.find(pin => pin.version === entry.version && pin.upstreamRevision === entry.upstreamRevision &&
      pin.asset.url === entry.asset.url && pin.asset[digest.algorithm] === digest.digest);
    return verified ? { ...entry, ...verified, releaseDate: entry.releaseDate || verified.releaseDate || null,
      asset: { ...entry.asset, ...verified.asset } } : entry;
  }
  return null;
}

async function releasePage({ version, offset = 0, limit = MAX_PAGE_SIZE, signal, fetch = fetchUrlBuffer } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Unity release pagination is invalid.");
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset), order: "RELEASE_DATE_DESC" });
  if (version) { if (!VERSION.test(version)) throw new Error("Invalid exact Unity version."); query.set("version", version); }
  throwIfAborted(signal);
  const result = await fetch(`${API}?${query}`, { signal });
  throwIfAborted(signal);
  if (result.status !== 200 || result.body.length > 16 * 1024 * 1024) throw new Error(`Unity release lookup failed (HTTP ${result.status}).`);
  const data = JSON.parse(result.body.toString("utf8"));
  if (!Array.isArray(data.results) || data.results.length > limit || !Number.isSafeInteger(data.total) || data.total < 0 ||
      data.offset !== undefined && data.offset !== offset || data.limit !== undefined && data.limit !== limit ||
      !data.results.length && offset < data.total) throw new Error("Unity release metadata is invalid.");
  return data;
}

async function discoverCatalog({ signal, logger, fetch } = {}) {
  const entries = new Map(), pageSize = MAX_PAGE_SIZE;
  for (let offset = 0; offset < MAX_CATALOG_ENTRIES; offset += pageSize) {
    const page = await releasePage({ offset, limit: pageSize, signal, ...(fetch ? { fetch } : {}) });
    for (const release of page.results) { const entry = releaseEntry(release); if (entry && !entries.has(entry.version)) entries.set(entry.version, entry); }
    if (offset + page.results.length >= page.total || page.results.length < pageSize) break;
  }
  logger?.info?.(`[unity] ${entries.size} Mac Mono player releases; catalog limited to ${MAX_CATALOG_ENTRIES} recent editor releases. Exact older versions resolve on Play.`);
  return [...entries.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

async function discoverVersion(version, options = {}) {
  // Unity's version filter is full-text search, not an equality guarantee.
  for (let offset = 0; offset < MAX_CATALOG_ENTRIES; offset += MAX_PAGE_SIZE) {
    const page = await releasePage({ ...options, version, offset, limit: MAX_PAGE_SIZE });
    const exact = page.results.find(release => release?.version === version);
    if (exact) {
      const entry = releaseEntry(exact);
      if (entry) return entry;
      break;
    }
    if (offset + page.results.length >= page.total || page.results.length < MAX_PAGE_SIZE) break;
  }
  throw new Error(`Unity ${version} has no published, verifiable Mac Mono player component. Import a matching Mac player in Runtimes.`);
}

module.exports = { API, SOURCE, REVIEWED, MAX_PAGE_SIZE, parseIntegrity, releaseEntry, releasePage, discoverCatalog, discoverVersion };
