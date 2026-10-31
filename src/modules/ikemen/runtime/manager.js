const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Upstream = require("../../shared/runtime/upstream");
const { macDownloads, locatePackaged } = require("../../shared/runtime/release-files");

// Releases may move the engine into a folder; known names win over any app.
const resolveExecutable = root => locatePackaged(root,
  ["I.K.E.M.E.N-Go.app/Contents/MacOS/Ikemen_GO_MacOSARM", "Ikemen_GO_MacOS", "Ikemen_GO", /\.app$/i]) || path.join(root, "Ikemen_GO");

// Names without a CPU follow the publisher's builds: Apple Silicon from 1.0,
// Intel before it. The executable states its macOS requirement.
const source = Upstream.github({ repository: "ikemen-engine/Ikemen-GO", allArchitectures: true,
  recognize: release => {
    const version = /^v?(\d+(?:\.\d+)+(?:-[A-Za-z0-9][A-Za-z0-9.]*)?)$/.exec(release.tag_name || "")?.[1];
    if (!version) return null;
    const unnamed = Number(version.split(".")[0]) >= 1 ? "arm64" : "x64";
    const rows = macDownloads(release.assets).map(({ asset, architecture }) => ({ version, architecture: architecture || unnamed, assets: [asset] }))
      .filter((item, index, list) => list.findIndex(other => other.architecture === item.architecture) === index);
    return rows.length ? rows : { version, installReason: "No Mac package is available for this release. A compatible local runtime can be imported." };
  } });

module.exports = createPinnedNativeManager({ id: "ikemen", label: "Ikemen GO",
  sourceUrl: "https://github.com/ikemen-engine/Ikemen-GO/releases", upstream: source,
  resolveExecutable });
module.exports.resolveExecutable = resolveExecutable;
