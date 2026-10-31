const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/xmoezzz/rfvp/releases";

// A rolling tag can replace an asset without changing the tag or source commit,
// so a version names the tag, the commit and, when GitHub publishes one, the
// download's complete checksum.
function snapshotVersion(tag, revision, digest) {
  const label = String(tag || "").replace(/^v(?=\d)/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label) || !/^[a-f0-9]{40}$/i.test(revision || "") || digest && !/^[a-f0-9]{64}$/i.test(digest))
    throw new Error("RFVP downloads require an identified tag and source commit.");
  return [label, revision.toLowerCase(), digest?.toLowerCase()].filter(Boolean).join("-");
}

// The current RFVP.dmg wins; a renamed or reformatted Mac download is followed.
// Its library states the macOS requirement and CPUs after download.
const source = Upstream.github({ repository: "xmoezzz/rfvp", prerelease: true, allArchitectures: true,
  recognize: (release, { revision }) => macDownloads(release.assets, { preferred: "RFVP.dmg" }).map(({ asset, architecture }) => {
    const published = Upstream.githubDigest(asset), digest = published?.algorithm === "sha256" ? published.value : null, date = /^\d{4}-\d{2}-\d{2}/.exec(asset.updated_at || release.published_at || "")?.[0];
    const title = release.tag_name === "pre-release" ? "Pre-release" : release.tag_name.replace(/^v(?=\d)/, "");
    return { version: snapshotVersion(release.tag_name, revision, digest), label: [title, date, revision.slice(0, 8), digest?.slice(0, 8)].filter(Boolean).join(" · "),
      sourceUrl: `https://github.com/xmoezzz/rfvp/tree/${revision.toLowerCase()}`, ...(architecture ? { architecture } : {}), assets: [asset] };
  }) });

module.exports = { SOURCE_URL, snapshotVersion, source };
