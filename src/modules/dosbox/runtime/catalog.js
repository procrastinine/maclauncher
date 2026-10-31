const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/dosbox-staging/dosbox-staging/releases";

function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

// Stable releases from 0.78.0, the first with a macOS disk image. The current
// file name is preferred; a renamed or reformatted Mac download is found too.
const source = Upstream.github({ repository: "dosbox-staging/dosbox-staging", allArchitectures: true,
  recognize: release => {
    const version = /^v?(\d+(?:\.\d+)+)$/.exec(release.tag_name || "")?.[1];
    if (!version || compareVersions(version, "0.78.0") < 0) return null;
    const downloads = macDownloads(release.assets, { preferred: [`dosbox-staging-macOS-v${version}.dmg`] });
    return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, architecture, assets: [asset] }))
      : { version, installReason: "This release has no macOS download." };
  } });

module.exports = { SOURCE_URL, source, compareVersions };
