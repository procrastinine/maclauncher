const Github = require("../../shared/runtime/github-releases");
const { githubAssetDigest } = require("../../shared/runtime/github-runtime-catalog");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const SOURCE_URL = "https://github.com/xmoezzz/rfvp/releases";
const REVISION = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;

// A rolling tag can replace an asset without changing the tag or source commit.
// Both identities belong in the selection, including the complete checksum.
function snapshotVersion(tag, revision, digest) {
  const label = String(tag || "").replace(/^v(?=\d)/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label) || !REVISION.test(revision || "") || !DIGEST.test(digest || ""))
    throw new Error("RFVP downloads require an identified source commit and SHA-256.");
  return `${label}-${revision.toLowerCase()}-${digest.toLowerCase()}`;
}

const DEFAULT_REVISION = "0ae09c712b5fa03e4da13017a2cf168a24f62035";
const DEFAULT_DIGEST = "150671d4b89ffc676d996705446d1f1c40f1829a12de1c19e8ba6b0c36a1128b";
const DEFAULT_VERSION = snapshotVersion("pre-release", DEFAULT_REVISION, DEFAULT_DIGEST);
const DEFAULT_ENTRY = Object.freeze({
  version: DEFAULT_VERSION,
  versionLabel: "Pre-release · 2026-10-10 · 0ae09c71 · 150671d4",
  upstreamRevision: DEFAULT_REVISION,
  upstreamTag: "pre-release",
  minimumMacOS: "11.0",
  hostArchitectures: ["arm64", "x64"],
  localBuild: false,
  sourceUrl: `https://github.com/xmoezzz/rfvp/tree/${DEFAULT_REVISION}`,
  asset: Object.freeze({
    filename: "RFVP.dmg",
    url: "https://github.com/xmoezzz/rfvp/releases/download/pre-release/RFVP.dmg",
    sha256: DEFAULT_DIGEST,
    bytes: 49760853,
    assetId: 628439630,
    integritySource: "github-published-sha256"
  })
});

function assetUrlAllowed(url, tag) {
  try {
    const value = new URL(url);
    return value.protocol === "https:" && value.hostname === "github.com" && !value.username && !value.password &&
      !value.search && !value.hash && value.pathname === `/xmoezzz/rfvp/releases/download/${encodeURIComponent(tag)}/RFVP.dmg`;
  } catch { return false; }
}

function createDiscovery(dependencies = {}) {
  return async ({ logger, signal } = {}) => {
    const releases = await (dependencies.fetchGithubReleases || Github.fetchGithubReleases)({
      owner: "xmoezzz", repo: "rfvp", includePrerelease: true, maxPages: 5, logger, signal
    });
    const entries = [];
    for (const release of releases.slice(0, 500)) {
      throwIfAborted(signal);
      if (release.draft || typeof release.tag_name !== "string") continue;
      const assets = (Array.isArray(release.assets) ? release.assets : [])
        .filter(asset => asset.name === "RFVP.dmg" && assetUrlAllowed(asset.browser_download_url, release.tag_name));
      if (assets.length !== 1) continue;
      const asset = assets[0], digest = githubAssetDigest(asset);
      if (!digest || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 512 * 1024 * 1024) continue;
      // RFVP publishes its rolling release with an immutable target commit.
      // Numbered releases using a branch target need only their own tag lookup;
      // the complete tag archive is unrelated to installing this Mac asset.
      const revision = REVISION.test(release.target_commitish || "") ? release.target_commitish
        : await (dependencies.resolveGithubTagCommit || Github.resolveGithubTagCommit)({
          owner: "xmoezzz", repo: "rfvp", tag: release.tag_name, signal
        });
      if (!REVISION.test(revision || "")) throw new Error("The RFVP release source commit could not be identified.");
      const version = snapshotVersion(release.tag_name, revision, digest);
      const date = /^\d{4}-\d{2}-\d{2}/.exec(asset.updated_at || release.published_at || "")?.[0];
      const title = release.tag_name === "pre-release" ? "Pre-release" : release.tag_name.replace(/^v(?=\d)/, "");
      entries.push({
        version, versionLabel: [title, date, revision.slice(0, 8), digest.slice(0, 8)].filter(Boolean).join(" · "),
        upstreamRevision: revision.toLowerCase(), upstreamTag: release.tag_name,
        minimumMacOS: "11.0", hostArchitectures: ["arm64", "x64"], localBuild: false,
        sourceUrl: `https://github.com/xmoezzz/rfvp/tree/${revision.toLowerCase()}`,
        asset: { filename: asset.name, url: asset.browser_download_url, sha256: digest, bytes: asset.size,
          ...(Number.isSafeInteger(asset.id) && asset.id > 0 ? { assetId: asset.id } : {}), integritySource: "github-published-sha256" }
      });
    }
    throwIfAborted(signal);
    return entries;
  };
}

module.exports = { SOURCE_URL, DEFAULT_ENTRY, DEFAULT_VERSION, snapshotVersion, assetUrlAllowed, createDiscovery };
