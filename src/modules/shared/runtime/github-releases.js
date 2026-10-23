const { fetchUrlBuffer, decodeResponseBody: decodeBody } = require("./download-utils");

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
    /(\d+)\.(\d+)\.(\d+)(?:[-_. ]?(alpha|beta|b|rc)(?:[-_. ]?(\d+))?)?/i
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

function parseOnsyuriMacVersion(input) {
  const raw = String(input || "").trim().replace(/^v(?=\d)/i, "");
  const match = /^(\d+\.\d+\.\d+(?:(?:alpha|beta|rc)\d*)?)-macos-v([1-9]\d*)$/.exec(raw);
  if (match) {
    const upstream = parseOnsyuriVersion(match[1]), macRevision = Number(match[2]);
    if (!upstream || upstream.normalized !== match[1] || !Number.isSafeInteger(macRevision)) return null;
    return { ...upstream, upstreamVersion: upstream.normalized, normalized: raw, macRevision };
  }
  if (/-macos-/i.test(raw)) return null;
  const upstream = parseOnsyuriVersion(input);
  return upstream ? { ...upstream, upstreamVersion: upstream.normalized, macRevision: 0 } : null;
}

function normalizeOnsyuriMacVersion(input) {
  return parseOnsyuriMacVersion(input)?.normalized || null;
}

function compareOnsyuriMacVersionsDesc(a, b) {
  const left = parseOnsyuriMacVersion(a), right = parseOnsyuriMacVersion(b);
  if (!left || !right) return String(b || "").localeCompare(String(a || ""));
  const upstream = compareOnsyuriVersionsDesc(left.upstreamVersion, right.upstreamVersion);
  return upstream || right.macRevision - left.macRevision;
}

function compareOnsyuriMacVersions(a, b) {
  return compareOnsyuriMacVersionsDesc(b, a);
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
  maxPages = 5,
  signal,
  request = fetchUrlBuffer
} = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || "") || !/^[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("Missing or invalid GitHub repo info");
  const pageLimit = Math.max(1, Math.min(20, Math.floor(Number(maxPages)) || 5));
  const headers = {
    "User-Agent": "maclauncher",
    "Accept": "application/vnd.github+json"
  };
  let url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
  let page = 0;
  const releases = [];
  const visited = new Set();
  const releaseIds = new Set();
  let canonicalRepositoryPath = null;

  while (url && page < pageLimit) {
    const parsedUrl = new URL(url);
    const namedRepositoryPath = `/repos/${owner}/${repo}/releases`;
    // GitHub commonly emits canonical numeric /repositories/<id> pagination
    // links even when the first request used an owner/name path.
    if (page > 0 && !canonicalRepositoryPath && /^\/repositories\/\d+\/releases$/.test(parsedUrl.pathname)) canonicalRepositoryPath = parsedUrl.pathname;
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "api.github.com" ||
      (parsedUrl.pathname.toLowerCase() !== namedRepositoryPath.toLowerCase() && parsedUrl.pathname !== canonicalRepositoryPath)) throw new Error("GitHub releases pagination escaped its repository.");
    if (visited.has(url)) break;
    visited.add(url);
    page += 1;
    logger?.info?.(`[github] fetching releases ${owner}/${repo} (page ${page})`);
    const res = await request(url, { headers, signal });
    if (res.status !== 200) {
      throw new Error(`GitHub releases fetch failed (${res.status})`);
    }
    const data = parseJsonResponse(res);
    if (!Array.isArray(data)) throw new Error("GitHub releases response is not a release list.");
    for (const release of data) {
      const identity = release?.id || release?.tag_name;
      if (identity != null && releaseIds.has(identity)) continue;
      if (identity != null) releaseIds.add(identity);
      releases.push(release);
    }
    const links = parseLinkHeader(res.headers?.link || "");
    url = links.next || null;
  }

  return releases.filter(rel => {
    if (!includeDraft && rel?.draft) return false;
    if (!includePrerelease && rel?.prerelease) return false;
    return true;
  });
}

// Release target_commitish is often a moving branch. Resolve the exact tag's
// commit before treating a discovered source version as a pinned build input.
async function resolveGithubTagCommit({ owner, repo, tag, signal, request = fetchUrlBuffer } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || "") || !/^[A-Za-z0-9_.-]+$/.test(repo || "") ||
    typeof tag !== "string" || !tag || tag.includes("\0")) throw new Error("Invalid GitHub tag lookup.");
  const headers = { "User-Agent": "maclauncher", "Accept": "application/vnd.github+json" };
  let url = `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
  for (let i = 0; i < 5; i++) {
    const response = await request(url, { headers, signal });
    if (response.status !== 200) throw new Error(`GitHub tag lookup failed (${response.status}) for ${tag}.`);
    const data = parseJsonResponse(response);
    const object = data.object;
    if (!/^[a-f0-9]{40}$/i.test(object?.sha || "")) throw new Error("GitHub tag has no immutable object identity.");
    if (object.type === "commit") return object.sha.toLowerCase();
    if (object.type !== "tag") throw new Error("GitHub release tag does not identify a commit.");
    url = `https://api.github.com/repos/${owner}/${repo}/git/tags/${object.sha}`;
  }
  throw new Error("GitHub annotated tag chain exceeds its bound.");
}

async function fetchGithubTags({ owner, repo, signal, request = fetchUrlBuffer, maxPages = 5 } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || "") || !/^[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("Invalid GitHub tag repository.");
  const headers = { "User-Agent": "maclauncher", "Accept": "application/vnd.github+json" };
  const tags = [];
  const pageLimit = Math.max(1, Math.min(20, Math.floor(Number(maxPages)) || 5));
  for (let page = 1; page <= pageLimit; page++) {
    const response = await request(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=100&page=${page}`, { headers, signal });
    if (response.status !== 200) throw new Error(`GitHub tags fetch failed (${response.status}).`);
    const entries = parseJsonResponse(response);
    if (!Array.isArray(entries)) throw new Error("GitHub tags response is not a list.");
    tags.push(...entries.filter(entry => entry && typeof entry.name === "string" && /^[a-f0-9]{40}$/i.test(entry.commit?.sha || "")));
    if (entries.length < 100) break;
  }
  return tags;
}

async function fetchGithubCommits({ owner, repo, signal, request = fetchUrlBuffer, limit = 20 } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || "") || !/^[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("Invalid GitHub commit repository.");
  const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
  const response = await request(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=${bounded}`, {
    headers: { "User-Agent": "maclauncher", "Accept": "application/vnd.github+json" }, signal });
  if (response.status !== 200) throw new Error(`GitHub source builds fetch failed (${response.status}).`);
  const entries = parseJsonResponse(response);
  if (!Array.isArray(entries)) throw new Error("GitHub commits response is not a list.");
  return entries.filter(entry => /^[a-f0-9]{40}$/i.test(entry?.sha || "")).slice(0, bounded);
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
  resolveGithubTagCommit,
  fetchGithubTags,
  fetchGithubCommits,
  selectGreenworksAsset,
  collectGreenworksNwVersions,
  selectOnsyuriAsset,
  collectOnsyuriVersions,
  parseSemver,
  compareSemverDesc,
  parseOnsyuriVersion,
  normalizeOnsyuriVersion,
  parseOnsyuriMacVersion,
  normalizeOnsyuriMacVersion,
  compareOnsyuriMacVersionsDesc,
  compareOnsyuriMacVersions,
  compareOnsyuriVersionsDesc,
  compareOnsyuriVersions,
  sortReleases,
  sortReleasesByOnsyuriVersion,
  normalizeArch,
  normalizeSemver
};
