const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://downloads.scummvm.org/frs/scummvm/";

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number), b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
// Entries of a directory listing directly inside `base`: folders end in "/".
function listedFiles(html, base) {
  const found = new Set(), root = new URL(base);
  for (const [, href] of String(html).matchAll(/href=["']([^"'?#]+)["']/gi)) {
    try {
      const url = new URL(href, root), rest = url.pathname.slice(root.pathname.length);
      if (url.origin === root.origin && url.pathname.startsWith(root.pathname) && /^[^/]+\/?$/.test(rest)) found.add(decodeURIComponent(rest));
    } catch {}
  }
  return [...found];
}
function parseVersions(html, base) {
  return listedFiles(html, base).map(name => /^(\d+(?:\.\d+)+)\/$/.exec(name)?.[1])
    .filter(Boolean).sort((a, b) => compareVersions(b, a));
}
// A published checksum file: the digest on the line naming the file, or a
// lone digest. A digest stated for another file is not this file's.
function parseDigest(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*([a-f0-9]{64})(?:\s+\*?(.+?))?\s*$/i.exec(line);
    if (match && (!match[2] || match[2] === filename)) return match[1].toLowerCase();
  }
  return null;
}

// downloads.scummvm.org lists one folder per version, and each Mac
// download has a published `.sha256` file beside it. The current disk image
// name wins; a renamed or reformatted Mac download is followed. The
// downloaded executables state their macOS requirement and CPUs.
function createSource({ sourceUrl = SOURCE_URL, prefix = "scummvm", project = "ScummVM" } = {}) {
  return Upstream.index({ locations: [sourceUrl], allArchitectures: true,
    parse: async ([listing], { fetch: readPage, latestOnly, logger }) => {
      const versions = parseVersions(listing.text, sourceUrl).slice(0, latestOnly ? 1 : 100), rows = new Array(versions.length);
      let cursor = 0;
      async function read(version) {
        const folder = `${sourceUrl}${version}/`, document = await readPage(folder);
        if (document?.status !== 200) throw new Error(`the release folder answered ${document?.status}`);
        const names = listedFiles(document.text, folder).filter(name => !name.endsWith("/"));
        const downloads = macDownloads(names.filter(name => !/\.(?:sha\d+|md5|asc|sig)$/i.test(name)).map(name => ({ name })), { preferred: `${prefix}-${version}-macosx.dmg` });
        if (!downloads.length) return [{ version, sourceUrl: folder, installReason: `This ${project} release has no macOS download.` }];
        return Promise.all(downloads.map(async ({ asset, architecture }) => {
          const checksum = names.includes(`${asset.name}.sha256`) ? await readPage(`${folder}${encodeURIComponent(asset.name)}.sha256`) : null;
          const digest = checksum?.status === 200 ? parseDigest(checksum.text, asset.name) : null;
          return { version, sourceUrl: folder, ...(architecture ? { architecture } : {}),
            files: [{ name: asset.name, url: `${folder}${encodeURIComponent(asset.name)}`, ...(digest ? { digest, algorithm: "sha256" } : {}) }] };
        }));
      }
      await Promise.all(Array.from({ length: Math.min(3, versions.length) }, async () => {
        while (cursor < versions.length) {
          const index = cursor++;
          // A version whose folder cannot be read is skipped; the others stay listed.
          try { rows[index] = await read(versions[index]); } catch (error) { logger?.warn?.(`[${prefix}] skipped ${versions[index]}: ${error.message || error}`); }
        }
      }));
      return rows.filter(Boolean).flat();
    } });
}
const source = createSource();

module.exports = { SOURCE_URL, source, createSource, parseVersions, listedFiles, parseDigest, compareVersions };
