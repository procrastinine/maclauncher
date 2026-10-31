const Upstream = require("../shared/runtime/upstream");
const { compareVersions } = require("../shared/runtime/version-order");
const { throwIfAborted } = require("../shared/runtime/download-utils");

const UOSC_SOURCE = "https://github.com/tomasklaen/uosc/releases/latest";
const THUMBFAST_SOURCE = "https://github.com/po5/thumbfast";
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

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
// The uosc ZIP or default configuration of a release: the exact current name,
// else a renamed uosc file of the same type.
function uoscAsset(assets, extension) {
  const named = (assets || []).filter(asset => typeof asset?.name === "string" && asset.name.toLowerCase().endsWith(extension) &&
    /^uosc(?:[._-]|$)/i.test(asset.name) && !/(?:^|[._-])(?:debug|symbols?|source)(?:[._-]|$)/i.test(asset.name));
  return named.find(asset => asset.name === "uosc" + extension) || named[0] || null;
}
// Stable uosc releases with both the ZIP and its default configuration. GitHub's
// digest verifies a download when GitHub publishes one.
const uosc = Upstream.github({ repository: "tomasklaen/uosc", recognize: release => {
  const tag = release?.tag_name;
  if (typeof tag !== "string" || !SAFE_VERSION.test(tag)) return [];
  const archive = uoscAsset(release.assets, ".zip"), configuration = uoscAsset(release.assets, ".conf");
  if (!archive || !configuration) return [];
  return { version: tag, label: tag, sourceUrl: `https://github.com/tomasklaen/uosc/releases/tag/${encodeURIComponent(tag)}`,
    assets: [archive, configuration] };
} });
// thumbfast publishes no releases. Its current commit is a source snapshot,
// downloaded from commit-addressed URLs.
const thumbfast = Upstream.githubCommits({ repository: "po5/thumbfast", limit: 1,
  recognize: commit => ({ version: String(commit.sha).toLowerCase(), label: snapshotVersionLabel(commit), sourceUrl: THUMBFAST_SOURCE, paths: ["thumbfast.lua"] }) });

// Catalog entries in the plugin manager's shape. Each carries its exact
// downloads; the license notice comes from the repository at the same revision.
function entry(row, repository, filename) {
  return { version: row.version, versionLabel: row.label || row.version, upstreamRevision: row.revision, sourceUrl: row.sourceUrl,
    ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}), licenseRepository: repository,
    assets: row.files.map(listed => ({ ...Upstream.asset(listed), filename: filename(listed.name) })) };
}
async function discoverUosc({ signal, logger } = {}) {
  // The ZIP comes first; its configuration installs as script-opts/uosc.conf.
  const entries = (await uosc.discover({ signal, logger })).filter(row => row.files.length === 2)
    .map(row => entry(row, "tomasklaen/uosc", name => /\.zip$/i.test(name) ? "uosc.zip" : "script-opts/uosc.conf"));
  throwIfAborted(signal);
  if (!entries.length) throw new Error("No stable uosc release was found.");
  return entries.sort((a, b) => compareVersions(b.version, a.version));
}
async function discoverThumbfast({ signal, logger } = {}) {
  const entries = (await thumbfast.discover({ signal, logger })).map(row => entry(row, "po5/thumbfast", name => name));
  throwIfAborted(signal);
  if (!entries.length) throw new Error("The latest thumbfast source could not be resolved.");
  return entries;
}

/** Published versions of a known plugin (`uosc` or `thumbfast`), newest first. */
async function discoverVersions(id, options = {}) {
  throwIfAborted(options.signal);
  if (id === "uosc") return discoverUosc(options);
  if (id === "thumbfast") return discoverThumbfast(options);
  throw new Error("The selected mpv plugin is unavailable.");
}

// An added plugin whose URL names uosc or thumbfast follows the newest version.
async function resolveKnownSource(source, { signal, logger } = {}) {
  const known = knownSource(source);
  if (!known) return null;
  const [newest] = await discoverVersions(known === UOSC_SOURCE ? "uosc" : "thumbfast", { signal, logger });
  const [main, ...extra] = newest.assets;
  const shared = { label: known === UOSC_SOURCE ? "uosc" : "thumbfast", sourceUrl: newest.sourceUrl, updateSource: known,
    upstreamRevision: newest.upstreamRevision, versionLabel: newest.versionLabel, licenseRepository: newest.licenseRepository,
    extraAssets: extra.map(({ filename, ...asset }) => ({ ...asset, relative: filename })) };
  const { filename, ...download } = main;
  return filename.endsWith(".zip") ? { ...download, archive: true, ...shared } : { ...download, extension: ".lua", ...shared };
}

module.exports = { UOSC_SOURCE, THUMBFAST_SOURCE, SAFE_VERSION, uosc, thumbfast, discoverVersions, resolveKnownSource, snapshotVersionLabel };
