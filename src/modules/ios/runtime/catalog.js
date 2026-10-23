const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const SOURCE_URL = "https://github.com/PlayCover/PlayCover/releases";
const VERSION = /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const catalog = [{ version: "4.0.0-prerelease", versionLabel: "4.0.0-prerelease · Pre-release", prerelease: true,
  upstreamRevision: "a7b1693d4fa4310367990cd35d4ebafb20e5c965",
  asset: { filename: "PlayCover_4.0.0-prerelease.dmg", url: "https://github.com/PlayCover/PlayCover/releases/download/4.0.0-prerelease/PlayCover_4.0.0-prerelease.dmg",
    sha256: "54e01381205ed7de05f8316ca229eab39ab8f6202b0dda4de07e98396e64d79e", bytes: 7031217,
    assetId: 617729765, integrity: "publisher-sha256" } },
  { version: "3.1.0", upstreamRevision: "a103786e03b7f6257b6b489dfc49ca6712423a2e",
    asset: { filename: "PlayCover_3.1.0.dmg", url: "https://github.com/PlayCover/PlayCover/releases/download/3.1.0/PlayCover_3.1.0.dmg",
      sha256: "5c3a291827f4802f665daf5c33a6bfe6ef0df2c6dff3f9e554db6514176196e7", integritySource: "recorded-local" } }
].map(entry => ({ ...entry, sourceUrl: `${SOURCE_URL}/tag/${entry.version}`, hostArchitectures: ["arm64"], minimumMacOS: "12.0", localBuild: false }));

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
