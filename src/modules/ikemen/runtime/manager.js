const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const discoverCatalog = createGithubReleaseDiscovery({ owner: "ikemen-engine", repo: "Ikemen-GO",
  mapRelease: async (release, { resolveRevision, githubAssetDigest, sourceUrl }) => {
    if (!/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(release.tag_name || "")) return null;
    const version = release.tag_name.slice(1);
    const asset = release.assets?.find(item => /-macos\.zip$/i.test(item.name));
    const revision = await resolveRevision(release);
    return { version, upstreamRevision: revision, sourceUrl, prerelease: Boolean(release.prerelease), localBuild: false,
      ...(asset ? { asset: { filename: asset.name, url: asset.browser_download_url,
        sha256: githubAssetDigest(asset), assetId: asset.id,
        integrity: githubAssetDigest(asset) ? "publisher-sha256" : "recorded-local" },
        ...(/^1\./.test(version) ? { hostArchitectures: ["arm64"] } : {}) }
        : { installReason: "No Mac package is available for this release. A compatible local runtime can be imported." }) };
  } });

module.exports = createPinnedNativeManager({ id: "ikemen", label: "Ikemen GO",
  sourceUrl: "https://github.com/ikemen-engine/Ikemen-GO/releases", discoverCatalog,
  catalog: [],
  resolveExecutable: root => {
    const fs = require("node:fs");
    for (const relative of ["I.K.E.M.E.N-Go.app/Contents/MacOS/Ikemen_GO_MacOSARM", "Ikemen_GO_MacOS", "Ikemen_GO"]) {
      const candidate = path.join(root, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
    const app = fs.readdirSync(root).find(name => name.toLowerCase().endsWith(".app"));
    return app ? path.join(root, app) : path.join(root, "Ikemen_GO");
  } });
