const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/FWGS/xash3d-fwgs/releases";
// The publisher's current Apple archive names; a renamed or reformatted Mac
// download is followed as well.
const PREFERRED = ["xash3d-fwgs-apple-arm64.tar.xz", "xash3d-fwgs-apple-amd64.tar.xz"];

// The rolling tag replaces its archives on every build, so a version names the
// tag, the source commit and, when GitHub publishes one, the archive's checksum.
function snapshotVersion(tag, revision, digest) {
  const label = String(tag || "").replace(/^v(?=\d)/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label) || !/^[a-f0-9]{40}$/i.test(revision || "") || digest && !/^[a-f0-9]{64}$/i.test(digest))
    throw new Error("Xash3D FWGS downloads require an identified tag and source commit.");
  return [label, revision.toLowerCase(), digest?.toLowerCase()].filter(Boolean).join("-");
}

// `continuous` carries the main-branch builds. `continuous-<branch>` releases
// carry feature-branch builds and are left out. Each archive holds the engine
// and the Half-Life game libraries built for one CPU.
const source = Upstream.github({ repository: "FWGS/xash3d-fwgs", prerelease: true, allArchitectures: true,
  recognize: (release, { revision }) => {
    const tag = String(release.tag_name || "");
    if (/^continuous-/i.test(tag)) return null;
    const date = /^\d{4}-\d{2}-\d{2}/.exec(release.published_at || "")?.[0];
    return macDownloads(release.assets, { preferred: PREFERRED }).map(({ asset, architecture }) => {
      const published = Upstream.githubDigest(asset), digest = published?.algorithm === "sha256" ? published.value : null;
      const title = tag === "continuous" ? "Continuous" : tag.replace(/^v(?=\d)/, "");
      return { version: snapshotVersion(tag, revision, digest),
        label: [title, /^\d{4}-\d{2}-\d{2}/.exec(asset.updated_at || "")?.[0] || date, revision.slice(0, 8)].filter(Boolean).join(" · ") + (architecture === "x64" ? " (Intel)" : ""),
        sourceUrl: `https://github.com/FWGS/xash3d-fwgs/tree/${revision.toLowerCase()}`, ...(architecture ? { architecture } : {}), assets: [asset] };
    });
  } });

module.exports = { SOURCE_URL, snapshotVersion, source };
