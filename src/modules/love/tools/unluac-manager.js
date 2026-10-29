const { createManagedJavaTool } = require("../../shared/runtime/managed-java-tool");
const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");
const SOURCE = "https://sourceforge.net/projects/unluac/files/";
const FEED = "https://sourceforge.net/projects/unluac/rss?path=/Unstable";
function artifactRow(row) {
  const match = /^unluac_(\d{4})_(\d{2})_(\d{2})\.jar$/.exec(row.tag || "");
  return Boolean(match && row.version === match.slice(1).join(".") &&
    row.url === "https://downloads.sourceforge.net/project/unluac/Unstable/" + row.tag &&
    row.sourceUrl === SOURCE + "Unstable/" + row.tag + "/" && (!row.md5 || /^[a-f0-9]{32}$/.test(row.md5)));
}
async function discoverCatalog(context, dependencies) {
  const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(FEED, { signal: context.signal, maxBytes: 4 * 1024 ** 2 });
  throwIfAborted(context.signal);
  if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 4 * 1024 ** 2)
    throw new Error("The SourceForge unluac release feed is unavailable.");
  const rows = [];
  for (const [, item] of response.body.toString("utf8").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    if (rows.length >= 500) throw new Error("The unluac release feed exceeds its limit.");
    const match = /unluac_(\d{4})_(\d{2})_(\d{2})\.jar/.exec(item);
    if (!match) continue;
    const bytes = Number(/<(?:media:content|enclosure)\b[^>]*\b(?:fileSize|length)=["'](\d+)["']/i.exec(item)?.[1]);
    const sha256 = /<(?:media:)?hash\b[^>]*\b(?:algo|algorithm)=["']sha-?256["'][^>]*>\s*([a-f0-9]{64})\s*</i.exec(item)?.[1]?.toLowerCase();
    const md5 = /<(?:media:)?hash\b[^>]*\b(?:algo|algorithm)=["']md5["'][^>]*>\s*([a-f0-9]{32})\s*</i.exec(item)?.[1]?.toLowerCase();
    const row = { version: match.slice(1).join("."), tag: match[0], bytes, url: "https://downloads.sourceforge.net/project/unluac/Unstable/" + match[0],
      sourceUrl: SOURCE + "Unstable/" + match[0] + "/", ...(sha256 ? { sha256 } : {}), ...(md5 ? { md5 } : {}) };
    if (Number.isSafeInteger(bytes) && bytes > 0 && artifactRow(row)) rows.push(row);
  }
  if (!rows.length) throw new Error("The SourceForge feed has no unluac JAR download metadata.");
  return rows;
}
module.exports = createManagedJavaTool({ id: "unluac", label: "unluac", jarName: "unluac.jar", order: 275,
  standaloneJar: true, sourceUrl: SOURCE, validateArtifactRow: artifactRow, discoverCatalog });
