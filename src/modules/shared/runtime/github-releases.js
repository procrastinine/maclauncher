const https = require("node:https");
const zlib = require("node:zlib");

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

async function fetchUrlBuffer(url, headers = {}, redirectDepth = 0) {
  if (redirectDepth > 5) {
    throw new Error("Too many redirects while fetching GitHub releases");
  }

  const res = await httpGet(url, headers);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return fetchUrlBuffer(nextUrl, headers, redirectDepth + 1);
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

function parseJsonResponse(res) {
  const decoded = decodeBody(res.body, res.headers);
  const text = decoded.toString("utf8");
  return JSON.parse(text);
}

function parseLinkHeader(value) {
  const links = {};
  const raw = String(value || "");
  if (!raw) return links;
  for (const part of raw.split(",")) {
    const section = part.trim().split(";");
    if (section.length < 2) continue;
    const urlMatch = section[0].trim().match(/^<(.+)>$/);
    const relMatch = section[1].trim().match(/^rel="(.+)"$/);
    if (!urlMatch || !relMatch) continue;
    links[relMatch[1]] = urlMatch[1];
  }
  return links;
}

function normalizeSemver(input) {
  const raw = String(input || "").trim().replace(/^v/i, "");
  if (!raw) return null;
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function parseOnsyuriVersion(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const m = raw.match(
    /(\d+)\.(\d+)\.(\d+)(?:[-_. ]?(alpha|beta|b|rc)[-_. ]?(\d+))?/i
  );
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prereleaseRaw = m[4] ? String(m[4]).toLowerCase() : null;
  let prereleaseType = prereleaseRaw;
  if (prereleaseType === "b") prereleaseType = "beta";
  const prereleaseNum = m[5] ? Number(m[5]) : null;
  if (![major, minor, patch].every(n => Number.isFinite(n))) return null;
  const base = `${major}.${minor}.${patch}`;
  const suffix = prereleaseType
    ? `${prereleaseType}${Number.isFinite(prereleaseNum) ? prereleaseNum : ""}`
    : "";
  return {
    major,
    minor,
    patch,
    prereleaseType: prereleaseType || null,
    prereleaseNum: Number.isFinite(prereleaseNum) ? prereleaseNum : null,
    normalized: `${base}${suffix}`
  };
}

function normalizeOnsyuriVersion(input) {
  const parsed = parseOnsyuriVersion(input);
  return parsed ? parsed.normalized : null;
}

function parseSemver(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
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

function prereleaseRank(type) {
  if (!type) return 3;
  if (type === "rc") return 2;
  if (type === "beta") return 1;
  if (type === "alpha") return 0;
  return 0;
}

function compareOnsyuriVersionsDesc(a, b) {
  const pa = parseOnsyuriVersion(a);
  const pb = parseOnsyuriVersion(b);
  if (!pa || !pb) return String(b || "").localeCompare(String(a || ""));
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;
  const ra = prereleaseRank(pa.prereleaseType);
  const rb = prereleaseRank(pb.prereleaseType);
  if (ra !== rb) return rb - ra;
  const na = Number.isFinite(pa.prereleaseNum) ? pa.prereleaseNum : 0;
  const nb = Number.isFinite(pb.prereleaseNum) ? pb.prereleaseNum : 0;
  if (na !== nb) return nb - na;
  return 0;
}

function compareOnsyuriVersions(a, b) {
  return compareOnsyuriVersionsDesc(b, a);
}

function sortReleases(releases) {
  const list = Array.isArray(releases) ? releases.slice() : [];
  list.sort((a, b) => {
    const va = normalizeSemver(a?.tag_name || a?.name || "");
    const vb = normalizeSemver(b?.tag_name || b?.name || "");
    if (va && vb && va !== vb) return compareSemverDesc(va, vb);
    const da = Date.parse(a?.published_at || a?.created_at || "") || 0;
    const db = Date.parse(b?.published_at || b?.created_at || "") || 0;
    return db - da;
  });
  return list;
}

function sortReleasesByOnsyuriVersion(releases) {
  const list = Array.isArray(releases) ? releases.slice() : [];
  list.sort((a, b) => {
    const va = normalizeOnsyuriVersion(a?.tag_name || a?.name || "");
    const vb = normalizeOnsyuriVersion(b?.tag_name || b?.name || "");
    if (va && vb && va !== vb) return compareOnsyuriVersionsDesc(va, vb);
    if (va && !vb) return -1;
    if (!va && vb) return 1;
    const da = Date.parse(a?.published_at || a?.created_at || "") || 0;
    const db = Date.parse(b?.published_at || b?.created_at || "") || 0;
    return db - da;
  });
  return list;
}

async function fetchGithubReleases({
  owner,
  repo,
  logger,
  includePrerelease = false,
  includeDraft = false,
  maxPages = 5
} = {}) {
  if (!owner || !repo) throw new Error("Missing GitHub repo info");
  const headers = {
    "User-Agent": "maclauncher",
    "Accept": "application/vnd.github+json"
  };
  let url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
  let page = 0;
  const releases = [];

  while (url && page < maxPages) {
    page += 1;
    logger?.info?.(`[github] fetching releases ${owner}/${repo} (page ${page})`);
    const res = await fetchUrlBuffer(url, headers);
    if (res.status !== 200) {
      throw new Error(`GitHub releases fetch failed (${res.status})`);
    }
    const data = parseJsonResponse(res);
    if (Array.isArray(data)) releases.push(...data);
    const links = parseLinkHeader(res.headers?.link || "");
    url = links.next || null;
  }

  return releases.filter(rel => {
    if (!includeDraft && rel?.draft) return false;
    if (!includePrerelease && rel?.prerelease) return false;
    return true;
  });
}

function normalizeArch(input) {
  const value = String(input || "").toLowerCase();
  if (value === "arm64" || value === "aarch64") return "aarch64";
  if (value === "x64" || value === "x86_64" || value === "x86-64") return "x86-64";
  return value || "";
}

function isDarwinAsset(name) {
  const lower = String(name || "").toLowerCase();
  return lower.includes("osx") || lower.includes("darwin") || lower.includes("mac");
}

function findGreenworksAsset(release, nwVersion) {
  const nw = normalizeSemver(nwVersion);
  if (!nw || !release?.assets) return null;
  const needle = new RegExp(`nw-v?${nw.replace(/\./g, "\\.")}`, "i");
  return release.assets.find(asset => {
    const name = String(asset?.name || "");
    return needle.test(name) && isDarwinAsset(name);
  }) || null;
}

function collectGreenworksNwVersions(releases) {
  const found = new Set();
  for (const rel of releases || []) {
    for (const asset of rel?.assets || []) {
      const name = String(asset?.name || "");
      if (!isDarwinAsset(name)) continue;
      const m = name.match(/nw-v?(\d+\.\d+\.\d+)/i);
      if (m?.[1]) found.add(m[1]);
    }
  }
  return Array.from(found).sort(compareSemverDesc);
}

function selectGreenworksAsset(releases, { nwVersion } = {}) {
  const sorted = sortReleases(releases || []);
  for (const rel of sorted) {
    const asset = findGreenworksAsset(rel, nwVersion);
    if (asset) {
      return {
        release: rel,
        asset,
        nwVersion: normalizeSemver(nwVersion),
        version: normalizeSemver(rel?.tag_name || rel?.name || "") || null
      };
    }
  }
  return null;
}

function matchesOnsyuriAsset(name, { arch, variant }) {
  const lower = String(name || "").toLowerCase();
  if (variant === "web") {
    return lower.includes("web") && (lower.endsWith(".7z") || lower.endsWith(".zip"));
  }
  if (!isDarwinAsset(name)) return false;
  if (arch) {
    const normalized = normalizeArch(arch);
    return lower.includes(normalized);
  }
  return lower.includes("darwin");
}

function collectOnsyuriVersions(releases, { arch, variant } = {}) {
  const versions = [];
  for (const rel of releases || []) {
    const assets = rel?.assets || [];
    const hasMatch = assets.some(asset =>
      matchesOnsyuriAsset(asset?.name || "", { arch, variant })
    );
    if (!hasMatch) continue;
    const v = normalizeOnsyuriVersion(rel?.tag_name || rel?.name || "");
    if (v) versions.push(v);
  }
  return Array.from(new Set(versions)).sort(compareOnsyuriVersionsDesc);
}

function selectOnsyuriAsset(releases, { arch, variant } = {}) {
  const sorted = sortReleasesByOnsyuriVersion(releases || []);
  for (const rel of sorted) {
    const asset =
      rel?.assets?.find(item => matchesOnsyuriAsset(item?.name || "", { arch, variant })) ||
      null;
    if (asset) {
      return {
        release: rel,
        asset,
        version: normalizeOnsyuriVersion(rel?.tag_name || rel?.name || "") || null
      };
    }
  }
  return null;
}

module.exports = {
  fetchGithubReleases,
  selectGreenworksAsset,
  collectGreenworksNwVersions,
  selectOnsyuriAsset,
  collectOnsyuriVersions,
  parseSemver,
  compareSemverDesc,
  parseOnsyuriVersion,
  normalizeOnsyuriVersion,
  compareOnsyuriVersionsDesc,
  compareOnsyuriVersions,
  sortReleases,
  sortReleasesByOnsyuriVersion,
  normalizeArch,
  normalizeSemver
};
