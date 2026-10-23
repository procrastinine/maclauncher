const Github = require("../../shared/runtime/github-releases");
const { githubAssetDigest } = require("../../shared/runtime/github-runtime-catalog");
const SOURCE_URL = "https://github.com/mpv-player/mpv/releases";
const DEFAULT_ENTRY = {
  version: "0.41.0-macos-14-arm64", versionLabel: "0.41.0 · Apple Silicon · macOS 14+", upstreamRevision: "41f6a645068483470267271e1d09966ca3b9f413",
  upstreamTag: "v0.41.0", minimumMacOS: "14.0", hostArchitectures: ["arm64"], localBuild: false,
  sourceUrl: "https://github.com/mpv-player/mpv/tree/41f6a645068483470267271e1d09966ca3b9f413",
  asset: { filename: "mpv-v0.41.0-macos-14-arm.zip", url: "https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-macos-14-arm.zip",
    sha256: "5c96f9b21355fc0a11d2e2161ad65f33031070e9fb3f6bd9865fb459b94587e6", bytes: 43693888, assetId: 331762248, integritySource: "github-published-sha256" }
};
function createDiscovery(dependencies = {}) {
  return async ({ signal, logger } = {}) => {
    const releases = await (dependencies.fetchGithubReleases || Github.fetchGithubReleases)({ owner: "mpv-player", repo: "mpv", maxPages: 2, signal, logger });
    const output = [];
    for (const release of releases) {
      if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
      const candidates = (release.assets || []).map(asset => ({ asset, match: /^mpv-v\d+\.\d+\.\d+-macos-(\d+)-arm\.zip$/.exec(asset.name) }))
        .filter(row => row.match && row.asset.name.startsWith(`mpv-${release.tag_name}-`) && githubAssetDigest(row.asset))
        .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
      const selected = candidates[0];if (!selected) continue;
      const { asset, match } = selected;
      const expected = `https://github.com/mpv-player/mpv/releases/download/${release.tag_name}/${asset.name}`;
      if (asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 512 * 1024 * 1024) continue;
      const revision = await (dependencies.resolveGithubTagCommit || Github.resolveGithubTagCommit)({ owner: "mpv-player", repo: "mpv", tag: release.tag_name, signal });
      if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error("The mpv release source could not be identified.");
      const version = release.tag_name.slice(1), floor = match[1];
      output.push({ version: `${version}-macos-${floor}-arm64`, versionLabel: `${version} · Apple Silicon · macOS ${floor}+`,
        upstreamRevision: revision, upstreamTag: release.tag_name, minimumMacOS: `${floor}.0`, hostArchitectures: ["arm64"], localBuild: false,
        sourceUrl: `https://github.com/mpv-player/mpv/tree/${revision}`, asset: { filename: asset.name, url: expected,
          sha256: githubAssetDigest(asset), bytes: asset.size, assetId: asset.id, integritySource: "github-published-sha256" } });
    }
    return output;
  };
}
module.exports = { SOURCE_URL, DEFAULT_ENTRY, createDiscovery };
