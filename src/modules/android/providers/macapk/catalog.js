const Upstream = require("../../../shared/runtime/upstream");
const { macDownloads } = require("../../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/kksimp/Mac.apk/releases";

// The current file name wins; a renamed or reformatted download is followed.
// A name without a CPU word is the publisher's Apple Silicon build. The
// application states its macOS requirement, which is read after download.
const source = Upstream.github({ repository: "kksimp/Mac.apk", allArchitectures: true,
  recognize: release => {
    const version = /^v?(\d+(?:\.\d+)+)$/.exec(release.tag_name || "")?.[1];
    if (!version) return null;
    const downloads = macDownloads(release.assets, { preferred: "macapk.dmg", platformWord: false });
    return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, architecture: architecture || "arm64", assets: [asset] }))
      : { version, architecture: "arm64", installReason: "This release has no Mac download." };
  } });

module.exports = { SOURCE_URL, source };
