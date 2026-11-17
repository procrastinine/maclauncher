const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const RELEASES = "https://github.com/eglaysher/rlvm/releases";
const source = Upstream.github({ repository: "eglaysher/rlvm", allArchitectures: true,
  recognize: release => {
    const version = /^release-(\d+(?:\.\d+)+)$/.exec(release.tag_name || "")?.[1];
    if (!version) return null;
    const downloads = macDownloads(release.assets, { preferred: `rlvm_${version}.dmg` });
    return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, ...(architecture ? { architecture } : {}), assets: [asset] }))
      : { version, installReason: "This release has no macOS app download." };
  } });
const projectBuilds = { projectId: "rlvm", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true };
module.exports = { RELEASES, source, projectBuilds };
