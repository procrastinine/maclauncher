const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const RELEASES = "https://github.com/xmoezzz/siglus_rs/releases";
function sourceEntry(version, revision, sourceUrl) {
  return { version, upstreamVersion: version, upstreamTag: version, upstreamRevision: revision, sourceUrl, localBuild: false,
    installReason: "Source release. The matching native preview is available separately." };
}
function createDiscovery({ arch = process.arch, dependencies = {} } = {}) {
  const assetName = arch === "arm64" ? "siglus-macos-arm64.app.tar.gz" : arch === "x64" ? "siglus-macos-x86_64.app.tar.gz" : null;
  return createGithubReleaseDiscovery({ owner: "xmoezzz", repo: "siglus_rs", includePrerelease: true, dependencies,
    assetFilter: asset => asset.name === assetName,
    mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
      const tag = release.tag_name || "", tagVersion = /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
      const upstreamVersion = tagVersion || /^Version:\s*v?(\d+\.\d+\.\d+)\s*$/m.exec(release.body || "")?.[1];
      if (!upstreamVersion || (!tagVersion && tag !== "pre-release")) return null;
      const revision = await resolveRevision(release);
      const declared = /^Commit:\s*([a-f0-9]{40})\s*$/m.exec(release.body || "")?.[1];
      if (!/^[a-f0-9]{40}$/.test(revision) || (declared && declared !== revision)) throw new Error("Siglus preview commit does not match its tag.");
      const asset = (release.assets || []).find(item => item.name === assetName), digest = githubAssetDigest(asset);
      if (!asset || !digest) return sourceEntry(upstreamVersion, revision, sourceUrl);
      const expected = `${RELEASES}/download/${encodeURIComponent(tag)}/${assetName}`;
      if (asset.browser_download_url !== expected) throw new Error("Siglus native release asset has an unexpected source.");
      const preview = tag === "pre-release" || release.prerelease;
      return { version: preview ? `${upstreamVersion}-preview.${revision.slice(0, 12)}` : upstreamVersion,
        versionLabel: preview ? `${upstreamVersion} · preview ${revision.slice(0, 7)}` : upstreamVersion,
        upstreamVersion, upstreamTag: tag, upstreamRevision: revision, sourceUrl, prerelease: Boolean(preview),
        hostArchitectures: [arch], nativeApi: "game_run_entry-v1",
        asset: { filename: assetName, url: expected, sha256: digest, assetId: asset.id, size: asset.size } };
    } });
}
module.exports = { RELEASES, sourceEntry, createDiscovery };
