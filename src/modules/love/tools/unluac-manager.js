const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");
const Upstream = require("../../shared/runtime/upstream");
const SOURCE = "https://sourceforge.net/projects/unluac/files/";
const FEED = "https://sourceforge.net/projects/unluac/rss?path=/Unstable";
const DOWNLOADS = "https://downloads.sourceforge.net/project/unluac/";
// A JAR named by its build date, unluac_2023_12_24.jar, or by a version,
// unluac-1.2.3.jar. Another separator or a folder in the feed is read too.
function jarVersion(name) {
  const dated = /^unluac[-_ ]?(\d{4})[-_.](\d{2})[-_.](\d{2})\.jar$/i.exec(name || "");
  if (dated) return dated.slice(1).join(".");
  return /^unluac[-_ ]?v?(\d+(?:\.\d+)+)\.jar$/i.exec(name || "")?.[1] || null;
}
// The feed lists recent files newest first with their sizes and digests. An
// item that cannot be read is skipped; the others stay listed.
const upstream = Upstream.index({ locations: [FEED], parse: ([feed]) => {
  const rows = [];
  for (const [, item] of feed.text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    // The item's file link names its folder; a bare name is in the feed's folder.
    const link = /\/projects\/unluac\/files\/([^"'<>?#]+?\.jar)(?:\/download)?["'<?#]/i.exec(item)?.[1];
    const named = /(?:^|[\s>/])(unluac[^\s<>/"']*\.jar)(?=[\s<"'/]|$)/i.exec(item)?.[1];
    let file = null;
    try { file = link ? decodeURIComponent(link) : named ? "Unstable/" + named : null; } catch {}
    const name = file?.split("/").at(-1), version = jarVersion(name);
    if (!version || rows.some(row => row.version === version)) continue;
    const bytes = Number(/<(?:media:content|enclosure)\b[^>]*\b(?:fileSize|length)=["'](\d+)["']/i.exec(item)?.[1]);
    const sha256 = /<(?:media:)?hash\b[^>]*\b(?:algo|algorithm)=["']sha-?256["'][^>]*>\s*([a-f0-9]{64})\s*</i.exec(item)?.[1];
    const md5 = /<(?:media:)?hash\b[^>]*\b(?:algo|algorithm)=["']md5["'][^>]*>\s*([a-f0-9]{32})\s*</i.exec(item)?.[1];
    rows.push({ version, sourceUrl: SOURCE + file + "/", files: [{ name, url: DOWNLOADS + file, bytes,
      ...(sha256 ? { digest: sha256, algorithm: "sha256" } : md5 ? { digest: md5, algorithm: "md5" } : {}) }] });
  }
  return rows;
} });
module.exports = createManagedJavaTool({ id: "unluac", label: "unluac", jarName: "unluac.jar", order: 275,
  standaloneJar: true, sourceUrl: SOURCE, upstream });
