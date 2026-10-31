const { decodeResponseBody: decodeBody } = require("./download-utils");
const { request: fetchUrlBuffer } = require("./github-transport");

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

async function fetchGithubReleases({
  owner,
  repo,
  logger,
  includePrerelease = false,
  includeDraft = false,
  maxPages = 5,
  assetFilter,
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
    const res = await request(url, { headers, signal, deferAssetSizes: true });
    if (res.status !== 200) {
      throw new Error(`GitHub releases fetch failed (${res.status})`);
    }
    const data = parseJsonResponse(res);
    if (!Array.isArray(data)) throw new Error("GitHub releases response is not a release list.");
    if (res.headers?.["x-maclauncher-github-web"] === "1") {
      // Public release pages display rounded sizes. Resolve exact bytes only for
      // assets used by this catalog; keep every published name and digest.
      const selected = data.filter(release => (includeDraft || !release.draft) && (includePrerelease || !release.prerelease))
        .flatMap(release => (release.assets || []).filter(asset => !assetFilter || assetFilter(asset, release)));
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, selected.length) }, async () => {
        while (next < selected.length) {
          const asset = selected[next++];
          const head = await request(asset.browser_download_url, { signal, method: "HEAD", assetDigest: asset.digest });
          const bytes = Number(head.headers?.["content-length"]);
          if (head.status !== 200 || !Number.isSafeInteger(bytes) || bytes < 1) throw new Error("GitHub release asset has no exact public size.");
          asset.size = bytes;
        }
      }));
    }
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

// The newest commits of a branch, or of the default branch.
async function fetchGithubCommits({ owner, repo, branch, signal, request = fetchUrlBuffer, limit = 20 } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || "") || !/^[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("Invalid GitHub commit repository.");
  const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
  const response = await request(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=${bounded}${branch ? `&sha=${encodeURIComponent(branch)}` : ""}`, {
    headers: { "User-Agent": "maclauncher", "Accept": "application/vnd.github+json" }, signal });
  if (response.status !== 200) throw new Error(`GitHub source builds fetch failed (${response.status}).`);
  const entries = parseJsonResponse(response);
  if (!Array.isArray(entries)) throw new Error("GitHub commits response is not a list.");
  return entries.filter(entry => /^[a-f0-9]{40}$/i.test(entry?.sha || "")).slice(0, bounded);
}

// A repository's license notice at an exact revision. A license file named
// other than LICENSE, or moved, is found through GitHub's license lookup.
// Null when the repository publishes no usable notice: nothing is written and
// the caller continues without one.
async function fetchGithubLicense({ owner, repo, revision, destination, signal, request = fetchUrlBuffer, download } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || "") || !/^[A-Za-z0-9_.-]+$/.test(repo || "") || !/^[A-Za-z0-9_.-]+$/.test(revision || ""))
    throw new Error("Invalid GitHub license lookup.");
  const fs = require("node:fs");
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${revision}/LICENSE`;
  let source = url;
  try { await (download || require("./upstream-transport").downloadToFile)(url, destination, { signal }); }
  catch (error) {
    if (signal?.aborted) throw error;
    fs.rmSync(destination, { force: true });
    const response = await request(`https://api.github.com/repos/${owner}/${repo}/license?ref=${encodeURIComponent(revision)}`,
      { headers: { "User-Agent": "maclauncher", "Accept": "application/vnd.github+json" }, signal });
    const data = response.status === 200 ? parseJsonResponse(response) : null;
    if (data?.encoding !== "base64" || typeof data.content !== "string") return null;
    fs.writeFileSync(destination, Buffer.from(data.content, "base64"));
    source = typeof data.download_url === "string" ? data.download_url : source;
  }
  const bytes = fs.readFileSync(destination);
  if (!bytes.length || bytes.length > 1024 * 1024 || bytes.includes(0)) { fs.rmSync(destination, { force: true }); return null; }
  return { licenseUrl: source, licenseSha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex") };
}

module.exports = {
  fetchGithubReleases,
  resolveGithubTagCommit,
  fetchGithubTags,
  fetchGithubCommits,
  fetchGithubLicense
};
