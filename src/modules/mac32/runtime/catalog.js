const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const SOURCE_URL = "https://github.com/Shagulka/mac32/releases";
const DEFAULT_VERSION = "0.1";
const DEFAULT_ENTRY = Object.freeze({
  version: DEFAULT_VERSION, upstreamTag: "v0.1",
  upstreamRevision: "dcfed5b9ad1ca1356bddd39ac6a26e564d536c28",
  sourceUrl: "https://github.com/Shagulka/mac32/tree/dcfed5b9ad1ca1356bddd39ac6a26e564d536c28",
  architecture: "x86_64", hostArchitectures: ["arm64", "x64"], requiresRosettaOnArm: true,
  minimumMacOS: "26.0", localBuild: false,
  asset: Object.freeze({ filename: "mac32-0.1-macos.zip",
    url: "https://github.com/Shagulka/mac32/releases/download/v0.1/mac32-0.1-macos.zip",
    sha256: "66c3205ad100d76ee4db5fb1cc69ffe910bcd5a384bb0a3cab3ebeef05af3ef2",
    bytes: 660386, integritySource: "reviewed-sha256" })
});

const MINIMUM_MACOS = "26.0";
function createDiscovery(dependencies = {}) {
  return createGithubReleaseDiscovery({ owner: "Shagulka", repo: "mac32", maxPages: 5, maxEntries: 100, dependencies,
    assetFilter: (asset, release) => asset.name === `mac32-${String(release.tag_name).replace(/^v/, "")}-macos.zip`,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      const match = /^v?(\d+\.\d+(?:\.\d+)?)$/.exec(release.tag_name || "");
      if (!match || release.draft || release.prerelease) return null;
      const version = match[1], filename = `mac32-${version}-macos.zip`;
      const url = `https://github.com/Shagulka/mac32/releases/download/${release.tag_name}/${filename}`;
      const assets = (release.assets || []).filter(asset => asset.name === filename && asset.browser_download_url === url);
      if (assets.length !== 1) return null;
      const asset = assets[0], sha256 = githubAssetDigest(asset);
      if (!sha256 || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 256 * 1024 * 1024) return null;
      const upstreamRevision = await resolveRevision(release);
      if (!/^[a-f0-9]{40}$/i.test(upstreamRevision || "")) throw new Error("The mac32 release source commit could not be identified.");
      return { version, upstreamTag: release.tag_name, upstreamRevision, sourceUrl,
        architecture: "x86_64", hostArchitectures: ["arm64", "x64"], requiresRosettaOnArm: true, localBuild: false,
        minimumMacOS: MINIMUM_MACOS,
        asset: { filename, url, sha256, bytes: asset.size,
          ...(Number.isSafeInteger(asset.id) && asset.id > 0 ? { assetId: asset.id } : {}), integritySource: "github-published-sha256" } };
    }
  });
}

module.exports = { SOURCE_URL, DEFAULT_VERSION, DEFAULT_ENTRY, MINIMUM_MACOS, createDiscovery };
