const Github = require("../../shared/runtime/github-releases");
const { githubAssetDigest } = require("../../shared/runtime/github-runtime-catalog");
const SOURCE_URL = "https://github.com/mpv-player/mpv/releases";
function createDiscovery(dependencies = {}) {
  return async ({ signal, logger } = {}) => {
    const releases = await (dependencies.fetchGithubReleases || Github.fetchGithubReleases)({ owner: "mpv-player", repo: "mpv", includePrerelease: true, maxPages: 2,
      assetFilter: asset => /^mpv-.+-macos-\d+-arm\.zip$/.test(asset.name || ""), signal, logger });
    const output = [];
    for (const release of releases) {
      if (release.draft) continue;
      const snapshot = release.tag_name === "git-release";
      if (!snapshot && (release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name))) continue;
      // git-release is a moving tag. Its release notes identify the actual
      // source commit; asset names also contain that commit and a CI run ID.
      const commit = snapshot ? /^\s*[-*]?\s*Commit:\s*`?([a-f0-9]{40})`?\s*$/im.exec(release.body || "")?.[1]?.toLowerCase() : null;
      if (snapshot && !commit) throw new Error("The mpv development build has no exact source commit. Refresh versions again.");
      const candidates = (release.assets || []).flatMap(asset => {
        const match = snapshot ? /^mpv-(v\d+\.\d+\.\d+-dev-g([a-f0-9]{7,40})-(\d+))-macos-(\d+)-arm\.zip$/i.exec(asset.name)
          : /^mpv-(v\d+\.\d+\.\d+)-macos-(\d+)-arm\.zip$/.exec(asset.name);
        if (!match || !githubAssetDigest(asset) || (snapshot ? !commit.startsWith(match[2].toLowerCase()) : match[1] !== release.tag_name)) return [];
        return [{ asset, build: match[1].slice(1), floor: snapshot ? match[4] : match[2] }];
      }).sort((a, b) => Number(a.floor) - Number(b.floor));
      const selected = candidates[0];if (!selected) continue;
      const { asset, build, floor } = selected;
      const expected = `https://github.com/mpv-player/mpv/releases/download/${release.tag_name}/${asset.name}`;
      if (asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 512 * 1024 * 1024) continue;
      const revision = commit || await (dependencies.resolveGithubTagCommit || Github.resolveGithubTagCommit)({ owner: "mpv-player", repo: "mpv", tag: release.tag_name, signal });
      if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error("The mpv release source could not be identified.");
      output.push({ version: `${build}-macos-${floor}-arm64`, versionLabel: `${snapshot ? `Git ${revision.slice(0, 9)} · ${build}` : build} · Apple Silicon · macOS ${floor}+`,
        upstreamRevision: revision, ...(snapshot ? { sourceKind: "commit", channel: "development", downloadTag: release.tag_name } : { upstreamTag: release.tag_name }),
        minimumMacOS: `${floor}.0`, hostArchitectures: ["arm64"], localBuild: false,
        sourceUrl: `https://github.com/mpv-player/mpv/tree/${revision}`, asset: { filename: asset.name, url: expected,
          sha256: githubAssetDigest(asset), bytes: asset.size, assetId: asset.id, integritySource: "github-published-sha256" } });
    }
    return output;
  };
}
module.exports = { SOURCE_URL, createDiscovery };
