const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { UMT_BUILDS } = require("./catalog");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

async function mapRelease(release, { resolveRevision, githubAssetDigest, sourceUrl }) {
  const cliVersion = release.tag_name.replace(/^v(?=\d)/, "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(cliVersion)) return null;
  const assets = release.assets.filter(asset => new RegExp(`^UTMT_CLI_v${cliVersion.replaceAll(".", "\\.")}-macOS(?:-x86)?\\.zip$`).test(asset.name));
  if (!assets.length) return null;
  const upstreamRevision = await resolveRevision(release);
  return assets.map(asset => {
    const reviewed = UMT_BUILDS.find(pin => pin.asset.url === asset.browser_download_url);
    const architecture = reviewed?.architecture || (asset.name.includes("-x86") ? "x86_64" : "native-macos");
    const sha256 = githubAssetDigest(asset);
    return { version: reviewed?.version || `${cliVersion}-${architecture}`, cliVersion, upstreamTag: release.tag_name, upstreamRevision, backend: "cli", architecture,
      license: "GPL-3.0-only", evidence: "upstream-release-artifact", sourceUrl, localBuild: false,
      publishedAt: release.published_at, asset: { url: asset.browser_download_url, filename: asset.name,
        ...(sha256 ? { sha256 } : { integrity: "recorded-local", assetId: asset.id }), bytes: asset.size } };
  });
}
const discoverCatalog = createGithubReleaseDiscovery({ owner: "UnderminersTeam", repo: "UndertaleModTool", mapRelease });

// Architecture is part of the selectable version; no moving nightly or implicit fallback.
const catalog = [...UMT_BUILDS].sort((a, b) => (a.architecture === (process.arch === "x64" ? "x86_64" : process.arch) ? -1 : 1));
const manager = createPinnedNativeManager({
  id: "undertale-mod-cli", label: "UndertaleModTool CLI", catalog, recommendedVersion: catalog[0].version, discoverCatalog,
  sourceUrl: "https://github.com/UnderminersTeam/UndertaleModTool/releases",
  resolveExecutable: root => path.join(root, "UndertaleModCli")
});

module.exports = { manager, mapRelease, discoverCatalog };
