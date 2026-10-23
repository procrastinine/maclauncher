const { createGithubReleaseDiscovery } = require("../../../shared/runtime/github-runtime-catalog");

const SOURCE_URL = "https://github.com/kksimp/Mac.apk/releases";
const catalog = [{ version: "1.0.2303", upstreamRevision: "f5338a9dfa901fa78ef0be02d5eb44daaba037e9",
  hostArchitectures: ["arm64"], minimumMacOS: "26.4", localBuild: false,
  sourceUrl: `${SOURCE_URL}/tag/v1.0.2303`,
  asset: { filename: "macapk.dmg", url: `${SOURCE_URL}/download/v1.0.2303/macapk.dmg`,
    sha256: "af32b4d7e972f761629549818759cf1866d8f7c3a89b6e96b1bc8de585565d39", bytes: 114163044,
    assetId: 663148267, integrity: "publisher-sha256" } },
  { version: "1.0.2279", upstreamRevision: "bed18c3d96beef25c0654bce877b169d7a958066",
  hostArchitectures: ["arm64"], minimumMacOS: "26.4", localBuild: false,
  sourceUrl: `${SOURCE_URL}/tag/v1.0.2279`,
  asset: { filename: "macapk.dmg", url: `${SOURCE_URL}/download/v1.0.2279/macapk.dmg`,
    sha256: "fc1e772cc0cac1f0880787744b14384326f254968d59590060c4d376f211fffc", bytes: 104748626,
    assetId: 658376920, integrity: "publisher-sha256" } },
  { version: "1.0.2237", upstreamRevision: "f6491e9c824180a237dc080db0804cbc8a6f2526",
  hostArchitectures: ["arm64"], minimumMacOS: "26.4", localBuild: false,
  sourceUrl: `${SOURCE_URL}/tag/v1.0.2237`,
  asset: { filename: "macapk.dmg", url: `${SOURCE_URL}/download/v1.0.2237/macapk.dmg`,
    sha256: "790b34dea56667f6a2c8424611716d55f3b6747b608272d081c995ff1cffcdd5", bytes: 104292340,
    assetId: 656467795, integrity: "publisher-sha256" } }];

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
module.exports = { catalog, SOURCE_URL, createCatalogDiscovery };
