const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

async function mapRelease(release, { resolveRevision, sourceUrl }) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
  if (!match) return null;
  const publishedVersion = match[1];
  return { version: publishedVersion === "0.9.5" ? "0.9.5-cli-v2" : publishedVersion,
    versionLabel: publishedVersion === "0.9.5" ? "0.9.5 · CLI adapter v2" : publishedVersion,
    upstreamTag: release.tag_name, publishedVersion,
    upstreamRevision: await resolveRevision(release), sourceUrl,
    localBuild: publishedVersion === "0.9.5",
    backend: publishedVersion === "0.9.5" ? "maclauncher-cli-v2" : "unqualified-upstream",
    installReason: publishedVersion === "0.9.5" ? null
      : "No compatible Mac CLI runtime is available for this release. Stock GUI apps cannot use per-game configuration." };
}

module.exports = { mapRelease, discoverCatalog: createGithubReleaseDiscovery({ owner: "gemrb", repo: "gemrb", mapRelease }) };
