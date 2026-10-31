const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const RELEASES = "https://github.com/eglaysher/rlvm/releases";
// RealLive playback starts with 0.14; earlier releases stay listed with that
// reason. The app's executable states its macOS requirement.
const source = Upstream.github({ repository: "eglaysher/rlvm", allArchitectures: true,
  recognize: release => {
    const version = /^release-(\d+(?:\.\d+)+)$/.exec(release.tag_name || "")?.[1];
    if (!version) return null;
    const [major, minor] = version.split(".").map(Number);
    if (major === 0 && minor < 14) return { version, installReason: "RealLive playback requires RLVM 0.14 or later." };
    const downloads = macDownloads(release.assets, { preferred: `rlvm_${version}.dmg` });
    return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, ...(architecture ? { architecture } : {}), assets: [asset] }))
      : { version, installReason: "This release has no macOS app download." };
  } });
module.exports = { RELEASES, source };
