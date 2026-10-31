const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/Shagulka/mac32/releases";

// mac32 hosts 32-bit Intel code in an Intel process, so an Apple Silicon-only
// download is left out. Its macOS requirement is the host executable's own
// deployment version, read after download.
const source = Upstream.github({ repository: "Shagulka/mac32", allArchitectures: true,
  recognize: release => {
    const version = /^v?(\d+(?:\.\d+)+)$/.exec(release.tag_name || "")?.[1];
    if (!version) return null;
    const asset = macDownloads(release.assets, { preferred: `mac32-${version}-macos.zip` }).find(item => item.architecture !== "arm64")?.asset;
    return asset ? { version, architecture: "x64", details: { hostArchitectures: ["arm64", "x64"] }, assets: [asset] }
      : { version, architecture: "x64", installReason: "This release has no Intel Mac download." };
  } });

module.exports = { SOURCE_URL, source };
