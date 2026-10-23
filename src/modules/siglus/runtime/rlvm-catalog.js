const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const VERSION = "0.14";
const REVISION = "a85b19c2bce61f9b1328220148aeb13b62929eea";
const RELEASES = "https://github.com/eglaysher/rlvm/releases";
const ASSET = Object.freeze({ filename: "rlvm_0.14.dmg", assetId: 258884, size: 2024263,
  url: `${RELEASES}/download/release-0.14/rlvm_0.14.dmg`,
  sha256: "b6e206bb35a0824a60588e461d6c9334556f11ebff00eda89ed36228c925e8b4",
  integritySource: "pinned-release-sha256" });
function reviewedEntry() {
  return { version: VERSION, upstreamRevision: REVISION, upstreamTag: "release-0.14",
    sourceUrl: `${RELEASES}/tag/release-0.14`, minimumMacOS: "13.0", asset: ASSET };
}
function createDiscovery({ dependencies = {} } = {}) {
  return createGithubReleaseDiscovery({ owner: "eglaysher", repo: "rlvm", dependencies,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      const version = /^release-(\d+\.\d+(?:\.\d+)?)$/.exec(release.tag_name || "")?.[1];
      if (!version) return null;
      const entry = { version, upstreamTag: release.tag_name, upstreamRevision: await resolveRevision(release), sourceUrl,
        minimumMacOS: "13.0", localBuild: false };
      const [major, minor] = version.split(".").map(Number);
      if (major === 0 && minor < 14) return { ...entry, installReason: "RealLive playback requires RLVM 0.14 or later." };
      const filename = `rlvm_${version}.dmg`, asset = release.assets?.find(item => item.name === filename);
      if (!asset) return { ...entry, installReason: "This release has no macOS app download." };
      const url = `${RELEASES}/download/${encodeURIComponent(release.tag_name)}/${filename}`;
      if (asset.browser_download_url !== url) throw new Error("The RLVM release asset has an unexpected source.");
      const digest = githubAssetDigest(asset);
      return { ...entry, asset: { filename, url, assetId: asset.id, size: asset.size,
        ...(version === VERSION ? { sha256: ASSET.sha256, integritySource: ASSET.integritySource }
          : digest ? { sha256: digest } : { integrity: "recorded-local" }) } };
    } });
}
module.exports = { VERSION, REVISION, RELEASES, ASSET, reviewedEntry, createDiscovery };
