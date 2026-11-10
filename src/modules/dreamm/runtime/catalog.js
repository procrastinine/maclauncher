const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");

const SOURCE_URL = "https://dreamm.aarongiles.com/";
const FEED_URL = "https://dreamm.aarongiles.com/version.xml";

const versionOf = name => /(\d+(?:\.\d+)+)/.exec(name)?.[1] || null;
// Release files the download page links, relative to the site.
function linkedFiles(html, base = SOURCE_URL) {
  const found = new Map();
  for (const [, href] of String(html).matchAll(/href=["']([^"'#?]+)["']/gi)) {
    try {
      const url = new URL(href.replace(/\\/g, "/"), base);
      if (url.protocol === "https:" && url.hostname === new URL(base).hostname) found.set(url.href, decodeURIComponent(url.pathname.split("/").pop()));
    } catch {}
  }
  return [...found].map(([url, name]) => ({ url, name }));
}
// The versions the publisher's update feed announces, newest first.
function feedVersions(xml) {
  return [...String(xml).matchAll(/<entry>[\s\S]*?<title>\s*DREAMM\s+(\d+(?:\.\d+)+)\s*<\/title>/gi)].map(match => match[1]);
}

// The download page links the current Mac disk image. Earlier versions in the
// update feed are listed when the publisher still serves their disk image
// under the current file name pattern.
const source = Upstream.index({ locations: [SOURCE_URL, FEED_URL], allArchitectures: true,
  parse: async (documents, { fetch, latestOnly }) => {
    const page = documents.find(document => !/\.xml$/i.test(new URL(document.url).pathname));
    const feed = documents.find(document => /\.xml$/i.test(new URL(document.url).pathname));
    const links = linkedFiles(page?.text || "");
    const downloads = macDownloads(links, { formats: [".dmg", ".zip", ".tar.gz", ".tgz"] }).filter(item => versionOf(item.asset.name));
    if (!downloads.length) throw new Error("The DREAMM download page links no macOS download.");
    const rows = downloads.map(({ asset, architecture }) => ({ version: versionOf(asset.name), sourceUrl: SOURCE_URL,
      ...(architecture ? { architecture } : {}), files: [{ name: asset.name, url: asset.url }] }));
    if (latestOnly || !feed) return rows;
    const current = rows[0];
    for (const version of feedVersions(feed.text)) {
      if (rows.some(row => row.version === version)) continue;
      const name = current.files[0].name.split(current.version).join(version), url = current.files[0].url.split(current.files[0].name).join(encodeURIComponent(name));
      const answer = await fetch(url, { method: "HEAD" }).catch(() => null);
      rows.push(answer?.status === 200 ? { version, sourceUrl: SOURCE_URL, files: [{ name, url }] }
        : { version, sourceUrl: SOURCE_URL, installReason: "The publisher no longer offers this version's macOS download." });
    }
    return rows;
  } });

module.exports = { SOURCE_URL, FEED_URL, source, linkedFiles, feedVersions };
