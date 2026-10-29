const { createGithubReleaseDiscovery } = require("../../../shared/runtime/github-runtime-catalog");

const SOURCE_URL = "https://github.com/kksimp/Mac.apk/releases";

function createCatalogDiscovery(dependencies = {}) {
  return createGithubReleaseDiscovery({ owner: "kksimp", repo: "Mac.apk", dependencies,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      if (!/^v?\d+\.\d+\.\d+$/.test(release.tag_name || "")) return null;
      const asset = release.assets?.find(item => item.name === "macapk.dmg");
      if (!asset || !githubAssetDigest(asset)) return null;
      return { version: release.tag_name.replace(/^v/, ""), upstreamRevision: await resolveRevision(release),
        sourceUrl, hostArchitectures: ["arm64"], minimumMacOS: "26.4", localBuild: false,
        asset: { filename: asset.name, url: asset.browser_download_url, sha256: githubAssetDigest(asset),
          bytes: asset.size, assetId: asset.id, integrity: "publisher-sha256" } };
    } });
}
module.exports = { SOURCE_URL, createCatalogDiscovery };
