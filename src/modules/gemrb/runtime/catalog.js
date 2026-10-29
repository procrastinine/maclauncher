const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

async function mapRelease(release, { resolveRevision, sourceUrl }) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
  if (!match) return null;
  const publishedVersion = match[1];
  return { version: publishedVersion,
    versionLabel: publishedVersion,
    upstreamTag: release.tag_name, publishedVersion,
    upstreamRevision: await resolveRevision(release), sourceUrl,
    localBuild: false, backend: "unqualified-upstream",
    installReason: "No compatible Mac CLI runtime is available for this release. Stock GUI apps cannot use per-game configuration." };
}

module.exports = { mapRelease, discoverCatalog: createGithubReleaseDiscovery({ owner: "gemrb", repo: "gemrb", mapRelease }) };
