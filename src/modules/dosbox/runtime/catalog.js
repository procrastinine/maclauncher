const { createGithubReleaseDiscovery, githubAssetDigest } = require("../../shared/runtime/github-runtime-catalog");

const SOURCE_URL = "https://github.com/dosbox-staging/dosbox-staging/releases";
const DEFAULT_VERSION = "0.83.0";
const PIN = Object.freeze({
  version: DEFAULT_VERSION,
  upstreamRevision: "7b40053b7ac580843d0461eba8c36a47a990e66c",
  upstreamTag: "v0.83.0",
  minimumMacOS: "12.0",
  hostArchitectures: ["arm64", "x64"],
  localBuild: false,
  sourceUrl: `${SOURCE_URL}/tag/v0.83.0`,
  asset: {
    filename: "dosbox-staging-macOS-v0.83.0.dmg",
    url: `${SOURCE_URL}/download/v0.83.0/dosbox-staging-macOS-v0.83.0.dmg`,
    bytes: 44531761,
    sha256: "d8a771adfb8010fa6b5f7fb5351abfba659273ad01c89f03675a92bdbdae8167"
  }
});

function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function createDiscovery(dependencies = {}) {
  return createGithubReleaseDiscovery({ owner: "dosbox-staging", repo: "dosbox-staging", dependencies,
    mapRelease: async (release, { resolveRevision, sourceUrl }) => {
      const match = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
      if (!match || release.prerelease || release.draft || compareVersions(match[1], "0.78.0") < 0) return null;
      const version = match[1], filename = `dosbox-staging-macOS-v${version}.dmg`;
      const expectedUrl = `${SOURCE_URL}/download/${release.tag_name}/${filename}`;
      const asset = release.assets?.find(item => item.name === filename && item.browser_download_url === expectedUrl &&
        Number.isSafeInteger(item.size) && item.size > 0);
      const sha256 = githubAssetDigest(asset);
      const downloadable = asset && (sha256 || Number.isSafeInteger(asset.id) && asset.id > 0);
      return { version, upstreamTag: release.tag_name, upstreamRevision: await resolveRevision(release),
        minimumMacOS: compareVersions(version, "0.83.0") >= 0 ? "12.0" : "11.0",
        hostArchitectures: ["arm64", "x64"], localBuild: false, sourceUrl,
        ...(downloadable ? { asset: { filename, url: expectedUrl, bytes: asset.size,
          ...(Number.isSafeInteger(asset.id) && asset.id > 0 ? { assetId: asset.id } : {}),
          ...(sha256 ? { sha256 } : { integrity: "recorded-local" }) } }
          : { installReason: "A universal macOS archive is not available for this release." }) };
    } });
}

module.exports = { SOURCE_URL, DEFAULT_VERSION, PIN, createDiscovery, compareVersions };
