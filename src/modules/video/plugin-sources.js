const Github = require("../shared/runtime/github-releases");
const Transport = require("../shared/runtime/github-transport");
const { decodeResponseBody, throwIfAborted } = require("../shared/runtime/download-utils");

const UOSC_SOURCE = "https://github.com/tomasklaen/uosc/releases/latest";
const THUMBFAST_SOURCE = "https://github.com/po5/thumbfast";

function snapshotVersionLabel(commit) {
  const date = commit?.commit?.committer?.date || commit?.commit?.author?.date;
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}T/.test(date)
    ? `${date.slice(0, 10)} snapshot` : "Source snapshot";
}

function knownSource(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || url.port) return null;
    const normalized = url.origin + url.pathname.replace(/\/$/, "").toLowerCase();
    return [UOSC_SOURCE, THUMBFAST_SOURCE].includes(normalized) ? normalized : null;
  } catch { return null; }
}
function revision(value, label) {
  if (!/^[a-f0-9]{40}$/i.test(value || "")) throw new Error(`The ${label} source has no exact commit identity.`);
  return value.toLowerCase();
}
function releaseAsset(asset, tag, filename) {
  const expected = `https://github.com/tomasklaen/uosc/releases/download/${encodeURIComponent(tag)}/${filename}`;
  if (!asset || asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size < 1)
    throw new Error(`The latest uosc release has no valid ${filename} download.`);
  const digest = typeof asset.digest === "string" ? asset.digest : "";
  if (/^sha256:/i.test(digest) && !/^sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error(`The uosc ${filename} checksum is invalid.`);
  return { url: expected, bytes: asset.size, ...(/^sha256:[a-f0-9]{64}$/i.test(digest) ? { sha256: digest.slice(7).toLowerCase() } : {}) };
}

async function resolveKnownSource(source, { signal, logger } = {}, dependencies = {}) {
  const known = knownSource(source);
  if (!known) return null;
  throwIfAborted(signal);
  const request = dependencies.request || Transport.request;
  if (known === UOSC_SOURCE) {
    const releases = await (dependencies.fetchGithubReleases || Github.fetchGithubReleases)({ owner: "tomasklaen", repo: "uosc", maxPages: 1, signal, logger,
      assetFilter: asset => ["uosc.zip", "uosc.conf"].includes(asset.name), ...(dependencies.request ? { request } : {}) });
    const latest = Github.sortReleases(releases).find(release => release && !release.draft && !release.prerelease);
    const tag = latest?.tag_name;
    if (typeof tag !== "string" || !tag || /[\0\r\n]/.test(tag)) throw new Error("No stable uosc release was found.");
    const archive = releaseAsset(latest.assets?.find(asset => asset.name === "uosc.zip"), tag, "uosc.zip");
    const configuration = releaseAsset(latest.assets?.find(asset => asset.name === "uosc.conf"), tag, "uosc.conf");
    const upstreamRevision = revision(await (dependencies.resolveGithubTagCommit || Github.resolveGithubTagCommit)({ owner: "tomasklaen", repo: "uosc", tag, signal,
      ...(dependencies.request ? { request } : {}) }), "uosc");
    throwIfAborted(signal);
    return { ...archive, archive: true, label: "uosc", sourceUrl: `https://github.com/tomasklaen/uosc/releases/tag/${encodeURIComponent(tag)}`,
      updateSource: UOSC_SOURCE, upstreamRevision, versionLabel: tag,
      extraAssets: [{ ...configuration, relative: "script-opts/uosc.conf" },
        { url: `https://raw.githubusercontent.com/tomasklaen/uosc/${upstreamRevision}/LICENSE.LGPL`, relative: "LICENSE.LGPL" }] };
  }
  const response = await request("https://api.github.com/repos/po5/thumbfast/commits/HEAD", { signal,
    headers: { "User-Agent": "MacLauncher", Accept: "application/vnd.github+json" } });
  if (response.status !== 200) throw new Error(`The latest thumbfast source could not be resolved (${response.status}).`);
  const commit = JSON.parse(decodeResponseBody(response.body, response.headers).toString("utf8"));
  const upstreamRevision = revision(commit.sha, "thumbfast");
  throwIfAborted(signal);
  const base = `https://raw.githubusercontent.com/po5/thumbfast/${upstreamRevision}`;
  return { url: `${base}/thumbfast.lua`, extension: ".lua", label: "thumbfast", sourceUrl: THUMBFAST_SOURCE,
    updateSource: THUMBFAST_SOURCE, upstreamRevision, versionLabel: snapshotVersionLabel(commit),
    extraAssets: [{ url: `${base}/LICENSE`, relative: "LICENSE" }] };
}

module.exports = { UOSC_SOURCE, THUMBFAST_SOURCE, resolveKnownSource, snapshotVersionLabel };
