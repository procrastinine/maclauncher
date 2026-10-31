const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/PlayCover/PlayCover/releases";

// Stable releases and prereleases. The current disk image name wins; a renamed
// or reformatted Mac download is followed. A name without a CPU word is the
// publisher's Apple Silicon build. PlayTools states its macOS requirement.
const source = Upstream.github({ repository: "PlayCover/PlayCover", prerelease: true, allArchitectures: true,
  recognize: release => {
    const version = /^v?(\d+(?:\.\d+)+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?)$/.exec(release.tag_name || "")?.[1];
    if (!version) return null;
    const prerelease = release.prerelease === true || version.includes("-");
    const row = { version, prerelease, architecture: "arm64", ...(prerelease ? { label: `${version} · Pre-release` } : {}) };
    const current = (release.assets || []).map(item => String(item?.name || "")).filter(name => /^PlayCover.*\.dmg$/i.test(name));
    const asset = macDownloads(release.assets, { preferred: current, platformWord: false }).find(item => item.architecture !== "x64")?.asset;
    return asset ? { ...row, assets: [asset] } : { ...row, installReason: "This release has no PlayCover download for Apple Silicon." };
  } });

module.exports = { SOURCE_URL, source };
