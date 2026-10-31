const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://github.com/EasyRPG/Player/releases";
const ARCHIVE_URL = "https://easyrpg.org/downloads/player/";

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number), b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return difference;
  }
  return 0;
}
// Entries of a directory listing directly inside `base`: folders end in "/".
function entries(html, base) {
  const found = new Set();
  for (const [, href] of String(html).matchAll(/href=["']([^"'?#]+)["']/gi)) {
    try {
      const url = new URL(href, base);
      if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname)) continue;
      const rest = url.pathname.slice(new URL(base).pathname.length);
      if (/^[^/]+\/?$/.test(rest)) found.add(decodeURIComponent(rest));
    } catch {}
  }
  return [...found];
}

// easyrpg.org lists one folder per release; each folder lists the release's
// files. Releases from 0.8, the first with a Mac app, are listed. The current
// app archive name wins; a renamed or reformatted Mac download is followed.
// The publisher states no checksum, so the download's own is recorded.
const source = Upstream.index({ locations: [ARCHIVE_URL], allArchitectures: true,
  parse: async ([listing], { fetch: read, latestOnly, logger }) => {
    const versions = entries(listing.text, listing.url).map(name => /^(\d+(?:\.\d+)+)\/$/.exec(name)?.[1])
      .filter(version => version && compareVersions(version, "0.8") >= 0).sort((a, b) => compareVersions(b, a)).slice(0, latestOnly ? 1 : 100);
    const rows = [];
    for (const version of versions) {
      const folder = `${ARCHIVE_URL}${version}/`;
      try {
        const document = await read(folder);
        if (document?.status !== 200) throw new Error(`the release folder answered ${document?.status}`);
        const names = entries(document.text, folder).filter(name => !name.endsWith("/") && !/libretro/i.test(name));
        const downloads = macDownloads(names.map(name => ({ name })), { preferred: `easyrpg-player-${version}-macos.app.zip` });
        rows.push(...(downloads.length ? downloads.map(({ asset, architecture }) => ({ version, sourceUrl: folder, ...(architecture ? { architecture } : {}),
          files: [{ name: asset.name, url: `${folder}${encodeURIComponent(asset.name)}` }] }))
          : [{ version, sourceUrl: folder, installReason: "No Mac app bundle is available for this release. Select a newer release or import a compatible local runtime." }]));
      } catch (error) { logger?.warn?.(`[easyrpg] skipped ${version}: ${error.message || error}`); }
    }
    return rows;
  } });

module.exports = { SOURCE_URL, ARCHIVE_URL, compareVersions, source };
