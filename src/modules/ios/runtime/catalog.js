const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const SOURCE_URL = "https://github.com/PlayCover/PlayCover/releases";
const VERSION = /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const catalog = [];

function createCatalogDiscovery(dependencies = {}) {
  return createGithubReleaseDiscovery({ owner: "PlayCover", repo: "PlayCover", includePrerelease: true, dependencies,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      if (!VERSION.test(release.tag_name || "")) return null;
      const version = release.tag_name.replace(/^v/, ""), prerelease = release.prerelease === true || version.includes("-");
      const asset = release.assets?.find(item => /^PlayCover.*\.dmg$/i.test(item.name));
      return { version, upstreamRevision: await resolveRevision(release), sourceUrl, prerelease,
        versionLabel: prerelease ? `${version} · Pre-release` : version,
        hostArchitectures: ["arm64"], minimumMacOS: "12.0", localBuild: false,
        ...(asset ? { asset: { filename: asset.name, url: asset.browser_download_url, sha256: githubAssetDigest(asset), assetId: asset.id,
          integrity: githubAssetDigest(asset) ? "publisher-sha256" : "recorded-local" } }
          : { installReason: "This release has no PlayCover disk image." }) };
    } });
}
module.exports = { catalog, SOURCE_URL, createCatalogDiscovery };
