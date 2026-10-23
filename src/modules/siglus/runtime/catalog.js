const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const REVISION = "5f358ef1360b0439e92aed2b749e8f25d8721954";
const VERSION = "1.0.0-preview.5f358ef1360b";
const RELEASES = "https://github.com/xmoezzz/siglus_rs/releases";
const ASSETS = {
  arm64: { filename: "siglus-macos-arm64.app.tar.gz", assetId: 621421334, sha256: "5ad165e007bc71abfca665d01fb9e120add85002a79bbd78ce7a2fafa43c5cfd" },
  x64: { filename: "siglus-macos-x86_64.app.tar.gz", assetId: 621421346, sha256: "ac7d516fd04910e271fec062cedba248ef03a394551c33415fc4bbb83c57518c" }
};
function reviewedEntry(arch = process.arch) {
  const asset = ASSETS[arch];
  if (!asset) throw new Error("Siglus requires an Apple Silicon or Intel Mac.");
  return { version: VERSION, versionLabel: "1.0.0 · preview 5f358ef", upstreamVersion: "1.0.0", upstreamTag: "pre-release",
    upstreamRevision: REVISION, sourceUrl: `${RELEASES}/tag/pre-release`, nativeApi: "game_run_entry-v1", hostArchitectures: [arch],
    asset: { ...asset, url: `${RELEASES}/download/pre-release/${asset.filename}` } };
}
function sourceEntry(version, revision, sourceUrl) {
  return { version, upstreamVersion: version, upstreamTag: version, upstreamRevision: revision, sourceUrl, localBuild: false,
    installReason: "Source release. The matching native preview is available separately." };
}
function createDiscovery({ arch = process.arch, dependencies = {} } = {}) {
  const assetName = ASSETS[arch]?.filename;
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
        upstreamVersion, upstreamTag: tag, upstreamRevision: revision, sourceUrl,
        hostArchitectures: [arch], nativeApi: "game_run_entry-v1",
        asset: { filename: assetName, url: expected, sha256: digest, assetId: asset.id, size: asset.size } };
    } });
}
module.exports = { REVISION, VERSION, RELEASES, ASSETS, reviewedEntry, sourceEntry, createDiscovery };
